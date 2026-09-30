const V3 = 'application/vnd.heroku+json; version=3'
const encode = encodeURIComponent
export const APP_STAGES = ['development', 'staging', 'production']

export function validateAppName(name) {
  if (!/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(name ?? '')) {
    throw new Error('App names must be 3–30 lowercase letters, digits, or hyphens, start with a letter, and end with a letter or digit.')
  }
}

export function statusCode(error) {
  return error.statusCode ?? error.status ?? error.response?.statusCode ?? error.http?.statusCode ?? error.http?.http?.statusCode
}

export function errorMessage(error) {
  const status = statusCode(error)
  if (status === 401) return 'Heroku authentication expired. Run heroku login and reopen dash.'
  if (status === 403) return 'Your Heroku account does not have permission to view or change this resource.'
  if (status === 429) return 'Heroku API rate limit reached. Wait before refreshing.'
  return error.body?.message ?? error.message ?? String(error)
}

export class HerokuAPI {
  constructor(client, {readOnly = false} = {}) {
    this.client = client
    this.readOnly = readOnly
  }

  async request(path, options = {}) {
    const method = options.method ?? 'GET'
    if (this.readOnly && method !== 'GET') throw new Error('Read-only mode: remote changes are disabled.')
    return this.client.request(path, {retryAuth: false, ...options, method, headers: {Accept: V3, ...options.headers}})
  }

  async get(path, options) {
    return (await this.request(path, options)).body
  }

  async list(path, options = {}) {
    const items = []
    let range = options.headers?.Range
    const seen = new Set()
    do {
      const response = await this.request(path, {...options, headers: {...options.headers, ...(range ? {Range: range} : {})}})
      if (!Array.isArray(response.body)) throw new Error(`Unexpected list response from ${path}`)
      items.push(...response.body)
      range = response.headers?.['next-range'] ?? response.headers?.['Next-Range']
      if (range && seen.has(range)) throw new Error(`Repeated pagination range from ${path}`)
      if (range) seen.add(range)
    } while (range)
    return items
  }

  async catalog() {
    const results = await Promise.allSettled([this.list('/teams'), this.list('/pipelines'), this.list('/apps')])
    const catalog = {warnings: []}
    for (const [i, key] of ['teams', 'pipelines', 'apps'].entries()) {
      const result = results[i]
      if (result.status === 'fulfilled') catalog[key] = result.value.sort((a, b) => a.name.localeCompare(b.name))
      else {
        catalog[key] = []
        catalog.warnings.push(`${key}: ${errorMessage(result.reason)}`)
      }
    }
    if (results.every(r => r.status === 'rejected')) throw results[2].reason
    return catalog
  }

  async coupling(app) {
    try {
      return await this.get(`/apps/${encode(app)}/pipeline-couplings`)
    } catch (error) {
      if (statusCode(error) === 404) return null
      throw error
    }
  }

  async pipelineApps(pipeline) {
    const couplings = await this.list(`/pipelines/${encode(pipeline)}/pipeline-couplings`)
    return Promise.all(couplings.map(async coupling => ({
      ...await this.get(`/apps/${encode(coupling.app.id)}`),
      stage: coupling.stage,
    })))
  }

  async appData(app) {
    const base = `/apps/${encode(app)}`
    const sections = {
      app: () => this.get(base),
      coupling: () => this.coupling(app),
      formation: () => this.list(`${base}/formation`),
      dynos: () => this.list(`${base}/dynos`),
      addons: () => this.list(`${base}/addons`),
      attachments: () => this.list(`${base}/addon-attachments`),
      domains: () => this.list(`${base}/domains`),
      buildpacks: () => this.list(`${base}/buildpack-installations`),
      // Only the latest page: release histories can be enormous.
      releases: () => this.get(`${base}/releases`, {headers: {Range: 'version ..; order=desc,max=20;'}}),
    }
    const data = {errors: {}, fetchedAt: new Date().toISOString()}
    await Promise.all(Object.entries(sections).map(async ([key, load]) => {
      try { data[key] = await load() }
      catch (error) { data.errors[key] = errorMessage(error); data[key] = ['app', 'coupling'].includes(key) ? null : [] }
    }))
    if (!data.app) throw new Error(data.errors.app)
    return data
  }

  config(app) { return this.get(`/apps/${encode(app)}/config-vars`) }

  async appRegions() {
    return (await this.list('/regions')).filter(region => !region.private_capable)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async createPipelineApp({pipeline, stage, name, region}, confirmation) {
    this.confirm(name, confirmation)
    validateAppName(name)
    if (!pipeline?.id) throw new Error('Select a pipeline before creating an app.')
    if (!APP_STAGES.includes(stage)) throw new Error('Select development, staging, or production.')
    if (!region?.trim()) throw new Error('Select a runtime region.')
    if (!Object.hasOwn(pipeline, 'owner')) throw new Error('Pipeline ownership is unavailable. Refresh the pipeline and try again.')
    const owner = pipeline.owner
    if (owner && !['team', 'user'].includes(owner.type)) throw new Error('Unsupported pipeline owner type.')
    let team
    if (owner?.type === 'team') {
      if (!owner.id) throw new Error('Pipeline team ownership is unavailable.')
      team = await this.get(`/teams/${encode(owner.id)}`)
      if (!team?.name) throw new Error('Pipeline team name is unavailable.')
    }
    const app = await this.get('/teams/apps', {method: 'POST', body: {
      name, region, ...(team ? {team: team.name} : {personal: true}),
    }})
    try {
      await this.get('/pipeline-couplings', {method: 'POST', body: {app: app.id, pipeline: pipeline.id, stage}})
    } catch (error) {
      throw Object.assign(new Error(`App ${app.name} was created, but adding it to pipeline ${pipeline.name} failed: ${errorMessage(error)}`), {createdApp: app})
    }
    return {...app, stage}
  }

  async scale(app, type, quantity, size, confirmation) {
    this.confirm(app, confirmation)
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('Dyno quantity must be a non-negative integer.')
    if (!size?.trim()) throw new Error('Enter a dyno size, such as Standard-1X.')
    return this.get(`/apps/${encode(app)}/formation/${encode(type)}`, {method: 'PATCH', body: {quantity, size: size.trim()}})
  }

  async dynoAction(app, target, scope, action, confirmation) {
    this.confirm(app, confirmation)
    if (!target?.trim()) throw new Error('Select a process or dyno.')
    if (!['process', 'dyno'].includes(scope)) throw new Error('Dyno action scope must be a process or dyno.')
    if (!['stop', 'restart'].includes(action)) throw new Error('Dyno action must be stop or restart.')
    const collection = scope === 'process' ? 'formations' : 'dynos'
    const path = `/apps/${encode(app)}/${collection}/${encode(target)}`
    return this.get(action === 'stop' ? `${path}/actions/stop` : path, {method: action === 'stop' ? 'POST' : 'DELETE'})
  }

  stop(app, target, scope, confirmation) { return this.dynoAction(app, target, scope, 'stop', confirmation) }

  restart(app, target, scope, confirmation) { return this.dynoAction(app, target, scope, 'restart', confirmation) }

  async setConfig(app, key, value, confirmation) {
    this.confirm(app, confirmation)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) throw new Error('Config keys must start with a letter or underscore and contain only letters, digits, and underscores.')
    if (value !== null && typeof value !== 'string') throw new Error('Config values must be strings.')
    return this.get(`/apps/${encode(app)}/config-vars`, {method: 'PATCH', body: {[key]: value}})
  }

  async maintenance(app, enabled, confirmation) {
    this.confirm(app, confirmation)
    if (typeof enabled !== 'boolean') throw new Error('Maintenance mode must be a boolean.')
    return this.get(`/apps/${encode(app)}`, {method: 'PATCH', body: {maintenance: enabled}})
  }

  confirm(app, confirmation) {
    if (this.readOnly) throw new Error('Read-only mode: remote changes are disabled.')
    if (!app || confirmation !== app) throw new Error('Type the exact app name to confirm this change.')
  }
}
