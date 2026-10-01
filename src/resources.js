import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {errorMessage} from './api.js'
import {withAbort} from './read-requests.js'

const SDK_HEADERS = {Accept: 'application/vnd.heroku+json; version=3.sdk', 'Accept-Expansion': 'addon_service,plan'}
const SIZE_CACHE_MS = 5 * 60_000

export async function loadResourcesIntegration(config, api, importModule = url => import(url)) {
  const plugin = config.plugins?.get('heroku-resources')
  if (!plugin) return {available: false, message: 'Install heroku-resources and restart dash to show costs and limits.'}
  try {
    const [specs, limits, report] = await Promise.all(['specs', 'addon-limits', 'report'].map(name =>
      importModule(pathToFileURL(join(plugin.root, 'src', `${name}.js`)).href),
    ))
    for (const name of ['memoryForSize', 'cpuForSize', 'monthlyCostForSize']) {
      if (typeof specs[name] !== 'function') throw new Error('Incompatible dyno helpers')
    }
    if (typeof limits.fetchAddonDetails !== 'function' || typeof report.buildReport !== 'function') throw new Error('Incompatible add-on helpers')
    return new ResourcesIntegration(api, {specs, ...limits, ...report}, plugin.version)
  } catch {
    return {available: false, message: `Cost/limit integration is unavailable with this installation of heroku-resources (${plugin.version ?? 'unknown version'}). Check or update the plugin, then restart dash.`}
  }
}

export class ResourcesIntegration {
  constructor(api, helpers, version) {
    Object.assign(this, {api, helpers, version, available: true})
  }

  reader(signal) {
    // Each helper gets GET-only access tied to its own view's read lifetime.
    return {get: async (path, options = {}) => {
      const requestSignal = signal && options.signal && signal !== options.signal
        ? AbortSignal.any([signal, options.signal]) : signal ?? options.signal
      return {body: await this.api.get(path, {...options, method: 'GET', signal: requestSignal})}
    }}
  }

  async sizes(force, signal) {
    signal?.throwIfAborted()
    if (!this.sizeRequest || this.sizeRequest.controller.signal.aborted
      || (this.sizeLoadedAt && (force || Date.now() - this.sizeLoadedAt > SIZE_CACHE_MS))) {
      this.sizeLoadedAt = 0
      const request = {controller: new AbortController(), users: 0, settled: false}
      request.promise = this.api.list('/dyno-sizes', {signal: request.controller.signal}).then(sizes => {
        request.controller.signal.throwIfAborted()
        request.settled = true
        if (this.sizeRequest === request) this.sizeLoadedAt = Date.now()
        return sizes
      }).catch(error => {
        request.settled = true
        if (this.sizeRequest === request) this.sizeRequest = null
        throw error
      })
      this.sizeRequest = request
    }
    const request = this.sizeRequest
    request.users++
    try { return await withAbort(request.promise, signal) }
    finally {
      request.users--
      // Cancel shared work only after every waiting view has released it.
      if (!request.users && !request.settled) {
        request.controller.abort()
        if (this.sizeRequest === request) this.sizeRequest = null
      }
    }
  }

  async dynos(data, {force = false, signal} = {}) {
    const sizes = await this.sizes(force, signal)
    signal?.throwIfAborted()
    const {memoryForSize, cpuForSize, monthlyCostForSize} = this.helpers.specs
    const shielded = data.app.space?.shield === true
    const allocation = (size, quantity) => {
      const ramPerDynoMb = memoryForSize(size, shielded, sizes)
      return {
        ramPerDynoMb,
        allocatedRamMb: ramPerDynoMb === null ? null : ramPerDynoMb * quantity,
        cpuPerDyno: cpuForSize(size, 1, shielded, sizes),
        cpu: cpuForSize(size, quantity, shielded, sizes),
        ...monthlyCostForSize(size, quantity, shielded, sizes),
        unitMonthlyCost: monthlyCostForSize(size, 1, shielded, sizes).monthlyCost,
      }
    }
    return {
      formations: Object.fromEntries(data.formation.map(f => [f.type, allocation(f.size, f.quantity)])),
      instances: Object.fromEntries(data.dynos.map(d => [d.name, allocation(d.size, 1)])),
    }
  }

  async addons(data, {signal} = {}) {
    signal?.throwIfAborted()
    const reader = this.reader(signal)
    const owned = await this.api.list(`/apps/${encodeURIComponent(data.app.id)}/addons`, {headers: SDK_HEADERS, signal})
    signal?.throwIfAborted()
    const all = new Map(owned.map(addon => [addon.id, addon]))
    for (const attachment of data.attachments) {
      if (!all.has(attachment.addon.id)) all.set(attachment.addon.id, null)
    }
    const entries = await Promise.all([...all].map(async ([id, resource]) => {
      try {
        signal?.throwIfAborted()
        const addon = resource ?? await this.api.get(`/addons/${encodeURIComponent(id)}`, {headers: SDK_HEADERS, signal})
        const details = await this.helpers.fetchAddonDetails(reader, addon)
        signal?.throwIfAborted()
        const report = this.helpers.buildReport(null, null, [{app: data.app, dynos: [], formation: [], addons: [{...addon, ...details}]}], [])
        if (!report.addons?.[0]) throw new Error('Unexpected heroku-resources add-on report')
        return [id, {
          ...report.addons[0],
          billingApp: addon.app?.name ?? (resource ? data.app.name : null),
          shared: addon.app?.id ? addon.app.id !== data.app.id : !resource,
        }]
      } catch (error) {
        signal?.throwIfAborted()
        return [id, {error: errorMessage(error)}]
      }
    }))
    signal?.throwIfAborted()
    return {byId: Object.fromEntries(entries)}
  }
}
