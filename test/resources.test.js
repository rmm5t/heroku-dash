import assert from 'node:assert/strict'
import test from 'node:test'
import {HerokuAPI} from '../src/api.js'
import {loadResourcesIntegration, ResourcesIntegration} from '../src/resources.js'

const specs = {
  memoryForSize: (_size, _shielded, sizes) => sizes[0].memory,
  cpuForSize: (_size, quantity) => `${quantity} vCPU`,
  monthlyCostForSize: (size, quantity) => ({monthlyCost: size === 'Eco' ? 0 : quantity * 25, ecoPlan: size === 'Eco'}),
}
const app = {id: 'app-id', name: 'example', space: {shield: true}}
const data = {
  app,
  formation: [{type: 'web', size: 'Private-S', quantity: 3}, {type: 'worker', size: 'Private-S', quantity: 0}],
  dynos: [{name: 'web.1', size: 'Private-S', type: 'web'}, {name: 'run.1', size: 'Eco', type: 'run'}],
  attachments: [],
}

test('missing and incompatible companion plugins are optional', async () => {
  const absent = await loadResourcesIntegration({plugins: new Map()}, {}, () => assert.fail('No module should be imported'))
  assert.equal(absent.available, false)
  assert.match(absent.message, /Install heroku-resources/)
  const config = {plugins: new Map([['heroku-resources', {root: '/plugins/resources', version: '0.1.0'}]])}
  const incompatible = await loadResourcesIntegration(config, {}, async () => ({}))
  assert.equal(incompatible.available, false)
  assert.match(incompatible.message, /0.1.0/)
})

test('installed helper modules are loaded from the oclif plugin root, including linked paths', async () => {
  const urls = []
  const plugin = {root: '/a linked plugin/resources', version: '0.5.1'}
  const provider = await loadResourcesIntegration({plugins: new Map([['heroku-resources', plugin]])}, {}, async url => {
    urls.push(url)
    if (url.endsWith('/specs.js')) return specs
    if (url.endsWith('/addon-limits.js')) return {fetchAddonDetails() {}}
    return {buildReport() {}}
  })
  assert.equal(provider.available, true)
  assert.equal(provider.version, '0.5.1')
  assert.equal(urls.length, 3)
  assert.ok(urls.every(url => url.startsWith('file:///a%20linked%20plugin/resources/src/')))
})

test('dyno enrichment uses formation quantities, actual instance sizes, and Shield context', async () => {
  const calls = []
  const helpers = {specs: Object.fromEntries(Object.entries(specs).map(([name, fn]) => [name, (...args) => {
    calls.push({name, args})
    return fn(...args)
  }]))}
  const provider = new ResourcesIntegration({async list(path) { assert.equal(path, '/dyno-sizes'); return [{memory: 512}] }}, helpers, '0.5.1')
  const result = await provider.dynos(data)
  assert.equal(result.formations.web.monthlyCost, 75)
  assert.equal(result.formations.web.allocatedRamMb, 1536)
  assert.equal(result.formations.worker.monthlyCost, 0)
  assert.equal(result.formations.worker.ramPerDynoMb, 512)
  assert.equal(result.instances['run.1'].ecoPlan, true)
  assert.equal(result.instances['web.1'].monthlyCost, 25)
  assert.ok(calls.filter(c => c.name === 'monthlyCostForSize').every(c => c.args[2] === true))
})

test('dyno-size requests are shared, cached, manually refreshed, and retried after failure', async () => {
  const pending = Promise.withResolvers()
  let calls = 0
  const provider = new ResourcesIntegration({async list() { calls++; return calls === 1 ? pending.promise : [{memory: 1024}] }}, {specs}, '0.5.1')
  const first = provider.dynos(data)
  const concurrent = provider.dynos(data)
  assert.equal(calls, 1)
  pending.resolve([{memory: 512}])
  await Promise.all([first, concurrent])
  await provider.dynos(data)
  assert.equal(calls, 1)
  await provider.dynos(data, {force: true})
  assert.equal(calls, 2)
  provider.api.list = async () => { throw new Error('Unavailable') }
  await assert.rejects(provider.dynos(data, {force: true}), /Unavailable/)
  provider.api.list = async () => [{memory: 2048}]
  assert.equal((await provider.dynos(data)).formations.web.ramPerDynoMb, 2048)
})

test('add-ons reuse provider limits and report semantics with GET-only access and shared billing', async () => {
  const requests = []
  const addons = [
    {id: 'owned', name: 'owned-db', app, billed_price: {cents: 20000, unit: 'month'}, plan: {name: 'heroku-postgresql:standard-2'}},
    {id: 'shared', name: 'shared-db', app: {id: 'other', name: 'billing-app'}, billed_price: {cents: 900, unit: 'month'}},
  ]
  const api = new HerokuAPI({async request(path, options) {
    requests.push({path, options})
    assert.equal(options.method, 'GET')
    if (path === '/apps/app-id/addons') return {body: [addons[0]]}
    if (path === '/addons/shared') return {body: addons[1]}
    if (path === '/addons/forbidden') throw Object.assign(new Error('Forbidden'), {statusCode: 403})
    return {body: {limits: {ram: '4 GB', maxConnections: 200, diskSize: '64 GB'}, activePlan: 'Standard 0', providerStatus: 'Upgrading Plan'}}
  }}, {readOnly: true})
  const provider = new ResourcesIntegration(api, {
    async fetchAddonDetails(reader, addon) {
      assert.equal(reader.patch, undefined)
      // Even options from a helper cannot change the adapter's request method.
      return (await reader.get(`https://postgres-api.heroku.com/${addon.id}`, {method: 'PATCH', timeout: 10_000})).body
    },
    buildReport(_pipeline, _stage, apps) {
      assert.equal(apps.length, 1)
      const addon = apps[0].addons[0]
      assert.equal(addon.activePlan, 'Standard 0')
      assert.equal(addon.limits.maxConnections, 200)
      return {addons: [{name: addon.name, costCents: addon.billed_price.cents, planChangePending: true, activePlan: addon.activePlan, ...addon.limits}]}
    },
  }, '0.5.1')
  const result = await provider.addons({...data, attachments: [{addon: {id: 'owned'}}, {addon: {id: 'shared'}}, {addon: {id: 'forbidden'}}]})
  assert.equal(result.byId.owned.costCents, 20000)
  assert.equal(result.byId.owned.billingApp, 'example')
  assert.equal(result.byId.owned.shared, false)
  assert.equal(result.byId.shared.shared, true)
  assert.equal(result.byId.shared.billingApp, 'billing-app')
  assert.equal(result.byId.shared.planChangePending, true)
  assert.match(result.byId.forbidden.error, /permission/)
  assert.equal(requests[0].options.headers['Accept-Expansion'], 'addon_service,plan')
  assert.match(requests[0].options.headers.Accept, /version=3\.sdk/)
})

test('canceling one dyno-size subscriber preserves a shared lookup for the other subscriber', async () => {
  const pending = Promise.withResolvers()
  const firstController = new AbortController()
  const secondController = new AbortController()
  let calls = 0
  let sharedSignal
  const provider = new ResourcesIntegration({list(_path, {signal}) {
    calls++
    sharedSignal = signal
    return pending.promise
  }}, {specs}, '0.5.1')
  const first = provider.dynos(data, {signal: firstController.signal})
  const second = provider.dynos(data, {signal: secondController.signal})
  assert.equal(calls, 1)
  const rejected = assert.rejects(first, {name: 'AbortError'})
  firstController.abort()
  await rejected
  assert.equal(sharedSignal.aborted, false)
  pending.resolve([{memory: 512}])
  assert.equal((await second).formations.web.ramPerDynoMb, 512)
  await provider.dynos(data)
  assert.equal(calls, 1)
})

test('canceling all dyno-size subscribers aborts shared work and a late failure cannot clear a newer cache', async () => {
  const pending = Promise.withResolvers()
  const controllers = [new AbortController(), new AbortController()]
  let calls = 0
  let sharedSignal
  const provider = new ResourcesIntegration({list(_path, {signal}) {
    calls++
    sharedSignal = signal
    return calls === 1 ? pending.promise : Promise.resolve([{memory: 1024}])
  }}, {specs}, '0.5.1')
  const waiting = controllers.map(controller => provider.dynos(data, {signal: controller.signal}))
  const rejected = waiting.map(loading => assert.rejects(loading, {name: 'AbortError'}))
  for (const controller of controllers) controller.abort()
  await Promise.all(rejected)
  assert.equal(sharedSignal.aborted, true)
  assert.equal((await provider.dynos(data)).formations.web.ramPerDynoMb, 1024)
  pending.reject(new Error('Old canceled lookup failed'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await provider.dynos(data)).formations.web.ramPerDynoMb, 1024)
  assert.equal(calls, 2)
})

test('add-on helper reads use their parent signal and cancellation is not reported as an add-on error', async () => {
  const controller = new AbortController()
  const pending = Promise.withResolvers()
  const reached = Promise.withResolvers()
  let helperSignal
  const api = new HerokuAPI({request(path, options) {
    assert.equal(options.method, 'GET')
    if (path === '/apps/app-id/addons') {
      assert.equal(options.signal, controller.signal)
      return Promise.resolve({body: [{id: 'addon'}]})
    }
    helperSignal = options.signal
    reached.resolve()
    return pending.promise
  }}, {readOnly: true})
  const provider = new ResourcesIntegration(api, {
    fetchAddonDetails(reader) { return reader.get('/addons/details', {method: 'PATCH', signal: new AbortController().signal}) },
    buildReport() { assert.fail('Canceled details must not produce a report') },
  }, '0.5.1')
  const loading = provider.addons(data, {signal: controller.signal})
  await reached.promise
  const rejected = assert.rejects(loading, {name: 'AbortError'})
  controller.abort()
  await rejected
  assert.equal(helperSignal.aborted, true)
  pending.reject(new Error('Late details failure'))
  await new Promise(resolve => setImmediate(resolve))
})
