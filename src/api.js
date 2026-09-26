const V3 = 'application/vnd.heroku+json; version=3'
const encode = encodeURIComponent

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
      catch (error) { data.errors[key] = errorMessage(error); data[key] = key === 'app' ? null : [] }
    }))
    if (!data.app) throw new Error(data.errors.app)
    return data
  }

  config(app) { return this.get(`/apps/${encode(app)}/config-vars`) }

  async scale(app, type, quantity, size, confirmation) {
    this.confirm(app, confirmation)
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('Dyno quantity must be a non-negative integer.')
    if (!size?.trim()) throw new Error('Enter a dyno size, such as Standard-1X.')
    return this.get(`/apps/${encode(app)}/formation/${encode(type)}`, {method: 'PATCH', body: {quantity, size: size.trim()}})
  }

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
