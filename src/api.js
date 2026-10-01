import {setTimeout as delay} from 'node:timers/promises'
import {isIP} from 'node:net'
import {domainToASCII} from 'node:url'
import {withAbort} from './read-requests.js'
import {recentReleases, RELEASE_LIMIT} from './releases.js'

const V3 = 'application/vnd.heroku+json; version=3'
const encode = encodeURIComponent
export const APP_STAGES = ['development', 'staging', 'production']

export function validateAppName(name) {
  if (!/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(name ?? '')) {
    throw new Error('App names must be 3–30 lowercase letters, digits, or hyphens, start with a letter, and end with a letter or digit.')
  }
}

export function normalizeHostname(value) {
  const input = String(value ?? '').trim().toLowerCase().replace(/\.$/, '')
  const wildcard = input.startsWith('*.')
  const domain = domainToASCII(wildcard ? input.slice(2) : input)
  const labels = domain.split('.')
  if (/[\s/:\\?#@%]/.test(input) || !domain || domain.length + (wildcard ? 2 : 0) > 253 || labels.length < 2 || isIP(domain)
    || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('Enter a valid domain hostname, such as www.example.com, without a URL scheme, path, or port.')
  }
  return `${wildcard ? '*.' : ''}${domain}`
}

function configCloneValues(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Config vars must be a key/value object.')
  const entries = Object.entries(config).filter(([key]) => !key.startsWith('HEROKU_'))
  if (entries.some(([key, value]) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || typeof value !== 'string')) {
    throw new Error('Source config vars must have valid keys and string values.')
  }
  return Object.fromEntries(entries)
}

function requireEmptyConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Config vars must be a key/value object.')
  if (Object.keys(config).length) throw new Error('Config cloning is only allowed when the current app has no config vars.')
}

export function statusCode(error) {
  return error.statusCode ?? error.status ?? error.response?.statusCode ?? error.http?.statusCode ?? error.http?.http?.statusCode
}

export function retryAfterMs(error, now = Date.now()) {
  if (Number.isFinite(error.retryAfterMs)) return Math.max(0, error.retryAfterMs)
  const headers = error.headers ?? error.response?.headers ?? error.http?.headers ?? error.http?.http?.headers
  const value = headers?.get?.('retry-after') ?? headers?.['retry-after'] ?? headers?.['Retry-After']
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
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
    // http-call forwards signals to sockets, but its retry backoff also needs
    // cancellation so abandoned reads cannot keep the dashboard alive.
    if (client.http) this.http = class extends client.http {
      async _request() {
        this.options.signal?.throwIfAborted()
        return super._request()
      }

      _wait(ms) {
        return this.options.signal ? delay(ms, undefined, {signal: this.options.signal}) : super._wait(ms)
      }
    }
  }

  async request(path, options = {}) {
    const method = options.method ?? 'GET'
    if (this.readOnly && method !== 'GET') throw new Error('Read-only mode: remote changes are disabled.')
    options.signal?.throwIfAborted()
    const transport = this.http ?? this.client
    return withAbort(transport.request(path, {retryAuth: false, ...options, method, headers: {Accept: V3, ...options.headers}}), options.signal)
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
    options.signal?.throwIfAborted()
    return items
  }

  async catalog(options = {}) {
    const results = await Promise.allSettled([this.list('/teams', options), this.list('/pipelines', options), this.list('/apps', options)])
    options.signal?.throwIfAborted()
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

  async coupling(app, options = {}) {
    try {
      return await this.get(`/apps/${encode(app)}/pipeline-couplings`, options)
    } catch (error) {
      options.signal?.throwIfAborted()
      if (statusCode(error) === 404) return null
      throw error
    }
  }

  async pipelineApps(pipeline, options = {}) {
    const couplings = await this.list(`/pipelines/${encode(pipeline)}/pipeline-couplings`, options)
    const apps = new Array(couplings.length)
    let next = 0
    await Promise.all(Array.from({length: Math.min(4, couplings.length)}, async () => {
      while (next < couplings.length) {
        options.signal?.throwIfAborted()
        const index = next++
        const coupling = couplings[index]
        try {
          apps[index] = {...await this.get(`/apps/${encode(coupling.app.id)}`, options), stage: coupling.stage}
        } catch (error) {
          options.signal?.throwIfAborted()
          // Retain failed members so views and actions can account for every app.
          apps[index] = {...coupling.app, name: coupling.app.name ?? coupling.app.id,
            stage: coupling.stage, loadError: errorMessage(error) || 'Unable to load app details.'}
        }
      }
    }))
    options.signal?.throwIfAborted()
    return apps
  }

  async appData(app, options = {}) {
    const {onUpdate, previous, sections: requested, ...requestOptions} = options
    const base = `/apps/${encode(app)}`
    const sections = {
      app: () => this.get(base, requestOptions),
      coupling: () => this.coupling(app, requestOptions),
      formation: () => this.list(`${base}/formation`, requestOptions),
      dynos: () => this.list(`${base}/dynos`, requestOptions),
      addons: () => this.list(`${base}/addons`, requestOptions),
      attachments: () => this.list(`${base}/addon-attachments`, requestOptions),
      domains: () => this.list(`${base}/domains`, requestOptions),
      buildpacks: () => this.list(`${base}/buildpack-installations`, requestOptions),
      // http-call automatically follows Next-Range unless partial is enabled.
      releases: () => this.get(`${base}/releases`, {...requestOptions, partial: true,
        headers: {...requestOptions.headers, Range: `version ..; order=desc,max=${RELEASE_LIMIT};`}}).then(recentReleases),
    }
    const selected = requested ?? Object.keys(sections)
    if (!Array.isArray(selected) || selected.some(key => !Object.hasOwn(sections, key))) throw new Error('Choose known app data sections.')
    if (requested && !previous?.app) throw new Error('Selective app reads require a previous snapshot.')
    const pending = new Set(selected)
    const data = {
      ...Object.fromEntries(Object.keys(sections).map(key => [key, ['app', 'coupling'].includes(key) ? null : []])),
      ...previous, errors: {...previous?.errors}, failures: {...previous?.failures},
      sectionFetchedAt: {...previous?.sectionFetchedAt}, fetchedAt: new Date().toISOString(),
    }
    data.releases = recentReleases(data.releases)
    await Promise.all([...pending].map(async key => {
      try {
        data[key] = await sections[key]()
        delete data.errors[key]
        delete data.failures[key]
        data.sectionFetchedAt[key] = Date.now()
      }
      catch (error) {
        options.signal?.throwIfAborted()
        data.errors[key] = `${errorMessage(error)}${previous && key !== 'app' ? ' · Showing previous data for this section.' : ''}`
        data.failures[key] = {statusCode: statusCode(error), retryAfterMs: retryAfterMs(error)}
        if (!previous || key === 'app') data[key] = ['app', 'coupling'].includes(key) ? null : []
      }
      options.signal?.throwIfAborted()
      pending.delete(key)
      onUpdate?.({...data, errors: {...data.errors}, failures: {...data.failures}, sectionFetchedAt: {...data.sectionFetchedAt}, pending: [...pending]}, key)
    }))
    options.signal?.throwIfAborted()
    if (!data.app) throw Object.assign(new Error(data.errors.app), data.failures.app)
    return data
  }

  config(app, options) { return this.get(`/apps/${encode(app)}/config-vars`, options) }

  async addonDashboardUrl(addon, attachment, app, options = {}) {
    options.signal?.throwIfAborted()
    if (!addon?.id) throw new Error('Select an add-on to open its management dashboard.')
    const datastoreURL = resource => {
      const service = resource.addon_service?.name ?? resource.plan?.name?.split(':')[0]
      const appName = app?.name ?? attachment?.app?.name ?? resource.app?.name
      if (['heroku-postgresql', 'heroku-redis', 'heroku-key-value-store'].includes(service) && appName) {
        return `https://dashboard.heroku.com/apps/${encode(appName)}/datastores/${encode(resource.id)}`
      }
      return null
    }
    // Heroku data services advertise generic SSO URLs too, but their management
    // pages now live in Dashboard's app-scoped datastore routes.
    let loadedAddon
    if (app?.name && !addon.addon_service?.name && !addon.plan?.name?.includes(':')) {
      loadedAddon = await this.get(`/addons/${encode(addon.id)}`, {timeout: 15_000, ...options})
      addon = {...addon, ...loadedAddon}
    }
    const datastore = datastoreURL(addon)
    if (datastore) return datastore
    const validate = value => {
      try {
        const url = new URL(value)
        if (['https:', 'http:'].includes(url.protocol)) return url.href
      } catch { /* Report an invalid link without including its SSO parameters. */ }
      throw new Error('This add-on does not provide a valid HTTP dashboard URL.')
    }
    if (attachment?.web_url) return validate(attachment.web_url)
    if (attachment?.id) {
      try {
        const details = await this.get(`/addon-attachments/${encode(attachment.id)}`, {timeout: 15_000, ...options})
        if (details?.web_url) return validate(details.web_url)
      } catch (error) {
        options.signal?.throwIfAborted()
        if (statusCode(error) !== 404) throw error
      }
    }
    if (addon.web_url) return validate(addon.web_url)
    const details = loadedAddon ?? await this.get(`/addons/${encode(addon.id)}`, {timeout: 15_000, ...options})
    const resolvedDatastore = details && datastoreURL({...addon, ...details})
    if (resolvedDatastore) return resolvedDatastore
    if (details?.web_url) return validate(details.web_url)
    throw new Error('This add-on does not provide a management dashboard.')
  }

  async appRegions(options) {
    return (await this.list('/regions', options)).filter(region => !region.private_capable)
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

  async promotePipelineApp({pipeline, source, stage, targets}, confirmation) {
    this.confirm(source?.name, confirmation)
    const sourceIndex = APP_STAGES.indexOf(source.stage)
    if (!pipeline?.id || !source.id) throw new Error('Select a pipeline app to promote.')
    if (sourceIndex < 0 || APP_STAGES.indexOf(stage) <= sourceIndex) throw new Error('Choose a higher pipeline stage.')
    if (!targets?.length || targets.some(app => !app.id || app.id === source.id)
      || new Set(targets.map(app => app.id)).size !== targets.length) throw new Error('Select downstream apps to promote to.')
    // Recheck membership before the write so a stage change during the dialog
    // cannot deploy a release to a different stage than the one confirmed.
    const couplings = await this.list(`/pipelines/${encode(pipeline.id)}/pipeline-couplings`)
    if (!couplings.some(coupling => coupling.app.id === source.id && coupling.stage === source.stage)
      || targets.some(app => !couplings.some(coupling => coupling.app.id === app.id && coupling.stage === stage))) {
      throw new Error('Pipeline stages changed. Refresh the pipeline and confirm the promotion again.')
    }
    return this.get('/pipeline-promotions', {method: 'POST', body: {
      pipeline: {id: pipeline.id}, source: {app: {id: source.id}}, targets: targets.map(app => ({app: {id: app.id}})),
    }})
  }

  async waitForPromotion(promotion, targets, {signal, onUpdate = () => {}, wait = delay, attempts = 300} = {}) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal?.throwIfAborted()
      const results = await this.list(`/pipeline-promotions/${encode(promotion.id)}/promotion-targets`, {signal})
      signal?.throwIfAborted()
      onUpdate(results)
      if (targets.every(app => results.some(result => result.app.id === app.id && ['succeeded', 'failed'].includes(result.status)))) return results
      await wait(1000, undefined, {signal})
    }
    throw new Error(`Promotion ${promotion.id} is still pending. Check its status in the Heroku dashboard.`)
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

  async validateConfigCloneApps({pipeline, source, destination}, options = {}) {
    if (!pipeline?.id || !source?.id || !destination?.id || source.id === destination.id) {
      throw new Error('Choose two different apps in the same pipeline.')
    }
    const couplings = await this.list(`/pipelines/${encode(pipeline.id)}/pipeline-couplings`, options)
    if (![source, destination].every(app => couplings.some(coupling => coupling.app.id === app.id))) {
      throw new Error('Both apps must belong to the selected pipeline. Refresh and try again.')
    }
  }

  async prepareConfigClone({pipeline, source, destination}, options = {}) {
    await this.validateConfigCloneApps({pipeline, source, destination}, options)
    requireEmptyConfig(await this.config(destination.id, options))
    const sourceConfig = await this.config(source.id, options)
    const values = configCloneValues(sourceConfig)
    return {pipeline, source, destination, values,
      skippedCount: Object.keys(sourceConfig).length - Object.keys(values).length}
  }

  async clonePipelineConfig(plan, confirmation) {
    this.confirm(plan.destination?.name, confirmation)
    const values = configCloneValues(plan.values)
    if (!Object.keys(values).length) throw new Error('There are no config vars to clone after excluding HEROKU_* variables.')
    await this.validateConfigCloneApps(plan)
    const path = `/apps/${encode(plan.destination.id)}/config-vars`
    const snapshot = await this.request(path)
    requireEmptyConfig(snapshot.body)
    // Recheck emptiness immediately before writing. Where Heroku supplies an
    // ETag, make the update conditional on that empty config snapshot as well.
    const etag = snapshot.headers?.etag ?? snapshot.headers?.ETag
    await this.get(path, {method: 'PATCH', body: values, ...(etag ? {headers: {'If-Match': etag}} : {})})
    return Object.keys(values).length
  }

  async maintenance(app, enabled, confirmation) {
    this.confirm(app, confirmation)
    if (typeof enabled !== 'boolean') throw new Error('Maintenance mode must be a boolean.')
    return this.get(`/apps/${encode(app)}`, {method: 'PATCH', body: {maintenance: enabled}})
  }

  async addDomain(app, hostname, enableACM, confirmation) {
    this.confirm(app, confirmation)
    hostname = normalizeHostname(hostname)
    if (typeof enableACM !== 'boolean') throw new Error('Choose whether to enable ACM.')
    if (enableACM && hostname.startsWith('*.')) throw new Error('ACM does not support wildcard domains. Add this domain without enabling ACM.')
    const domain = await this.get(`/apps/${encode(app)}/domains`, {method: 'POST', body: {hostname, sni_endpoint: null}})
    if (enableACM) {
      try { await this.get(`/apps/${encode(app)}/acm`, {method: 'POST', body: {}}) }
      catch (error) {
        throw Object.assign(new Error(`Domain ${hostname} was added, but enabling ACM failed: ${errorMessage(error)}`), {createdDomain: domain})
      }
    }
    return domain
  }

  async removeDomain(app, domain, confirmation) {
    this.confirm(app, confirmation)
    if (domain?.kind !== 'custom') throw new Error('Only custom domains can be removed.')
    const hostname = normalizeHostname(domain.hostname)
    return this.get(`/apps/${encode(app)}/domains/${encode(domain.id || hostname)}`, {method: 'DELETE'})
  }

  confirm(app, confirmation) {
    if (this.readOnly) throw new Error('Read-only mode: remote changes are disabled.')
    if (!app || confirmation !== app) throw new Error('Type the exact app name to confirm this change.')
  }
}
