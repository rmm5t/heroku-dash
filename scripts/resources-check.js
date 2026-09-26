// Opt-in integration check against the installed companion plugin. Every
// outbound application/provider request is restricted to GET by two layers.
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {HerokuAPI} from '../src/api.js'
import {loadResourcesIntegration} from '../src/resources.js'
import {appRows} from '../src/ui/views.js'

const names = process.argv.slice(2)
if (!names.length) throw new Error('Usage: npm run test:resources -- APP [APP...]')
const exec = promisify(execFile)
const {stdout: pluginJSON} = await exec('heroku', ['plugins:inspect', 'heroku-resources', '--json'])
const [plugin] = JSON.parse(pluginJSON)
assert.equal(plugin.name, 'heroku-resources')
const {stdout} = await exec('heroku', ['auth:token'])
const token = stdout.trim()
assert.ok(token)
let requests = 0
const api = new HerokuAPI({async request(path, options) {
  assert.equal(options.method, 'GET', 'Live checks may only send GET requests')
  const url = new URL(path, 'https://api.heroku.com')
  assert.equal(url.protocol, 'https:')
  assert.ok(['api.heroku.com', 'postgres-api.heroku.com', 'api.data.heroku.com'].includes(url.hostname))
  requests++
  const response = await fetch(url, {method: 'GET', headers: {...options.headers, Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(options.timeout ?? 30_000)})
  const body = await response.json()
  if (!response.ok) throw Object.assign(new Error(body.message ?? `HTTP ${response.status}`), {statusCode: response.status})
  return {body, headers: Object.fromEntries(response.headers)}
}}, {readOnly: true})
const provider = await loadResourcesIntegration({plugins: new Map([[plugin.name, plugin]])}, api)
assert.ok(provider.available, provider.message)
console.log(`Using installed heroku-resources ${provider.version}`)
for (const name of names) {
  const data = await api.appData(name)
  assert.deepEqual(data.errors, {})
  const [dynos, addons] = await Promise.all([provider.dynos(data), provider.addons(data)])
  const resources = {provider, data: {dynos, addons}, errors: {}}
  assert.equal(Object.keys(dynos.formations).length, data.formation.length)
  for (const addon of Object.values(addons.byId)) assert.equal(addon.error, undefined)
  for (const tab of ['Resources', 'Add-ons']) assert.ok(appRows(tab, data, {resources}).length)
  console.log(`PASS: ${name}: ${Object.keys(dynos.formations).length} process types, ${Object.keys(dynos.instances).length} dynos, ${Object.keys(addons.byId).length} add-ons enriched`)
  const addonRows = Object.values(addons.byId)
  console.log(`  Known prices: ${Object.values(dynos.formations).filter(row => Number.isFinite(row.monthlyCost)).length} process types, ${addonRows.filter(row => Number.isFinite(row.costCents) && !row.contract && !row.metered).length} add-ons; limits available for ${addonRows.filter(row => row.ram != null || row.maxConnections != null || row.diskSize != null).length} add-ons`)
}
console.log(`${requests} GET requests; zero remote writes.`)
