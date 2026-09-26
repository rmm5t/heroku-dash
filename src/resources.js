import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {errorMessage} from './api.js'

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
    // The companion helpers receive only GET access, using dash's authenticated
    // client. They cannot prompt for login or perform writes through this adapter.
    this.reader = {get: async (path, options = {}) => ({body: await api.get(path, {...options, method: 'GET'})})}
  }

  async sizes(force) {
    if (!this.sizeRequest || (this.sizeLoadedAt && (force || Date.now() - this.sizeLoadedAt > SIZE_CACHE_MS))) {
      this.sizeLoadedAt = 0
      const request = this.api.list('/dyno-sizes').then(sizes => {
        this.sizeLoadedAt = Date.now()
        return sizes
      }).catch(error => {
        this.sizeRequest = null
        throw error
      })
      this.sizeRequest = request
    }
    return this.sizeRequest
  }

  async dynos(data, {force = false} = {}) {
    const sizes = await this.sizes(force)
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

  async addons(data) {
    const owned = await this.api.list(`/apps/${encodeURIComponent(data.app.id)}/addons`, {headers: SDK_HEADERS})
    const all = new Map(owned.map(addon => [addon.id, addon]))
    for (const attachment of data.attachments) {
      if (!all.has(attachment.addon.id)) all.set(attachment.addon.id, null)
    }
    const entries = await Promise.all([...all].map(async ([id, resource]) => {
      try {
        const addon = resource ?? await this.api.get(`/addons/${encodeURIComponent(id)}`, {headers: SDK_HEADERS})
        const details = await this.helpers.fetchAddonDetails(this.reader, addon)
        const report = this.helpers.buildReport(null, null, [{app: data.app, dynos: [], formation: [], addons: [{...addon, ...details}]}], [])
        if (!report.addons?.[0]) throw new Error('Unexpected heroku-resources add-on report')
        return [id, {
          ...report.addons[0],
          billingApp: addon.app?.name ?? (resource ? data.app.name : null),
          shared: addon.app?.id ? addon.app.id !== data.app.id : !resource,
        }]
      } catch (error) {
        return [id, {error: errorMessage(error)}]
      }
    }))
    return {byId: Object.fromEntries(entries)}
  }
}
