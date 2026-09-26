import assert from 'node:assert/strict'
import test from 'node:test'
import {errorMessage, HerokuAPI} from '../src/api.js'

test('list follows Next-Range and preserves headers', async () => {
  const calls = []
  const api = new HerokuAPI({async request(path, options) {
    calls.push({path, options})
    return calls.length === 1 ? {body: [{id: 'a'}], headers: {'next-range': 'id b..'}} : {body: [{id: 'b'}], headers: {}}
  }})
  assert.deepEqual(await api.list('/apps', {headers: {'Accept-Expansion': 'team'}}), [{id: 'a'}, {id: 'b'}])
  assert.equal(calls[1].options.headers.Range, 'id b..')
  assert.equal(calls[1].options.headers['Accept-Expansion'], 'team')
  assert.equal(calls[0].options.retryAuth, false)
})

test('list rejects a repeated pagination cursor', async () => {
  const api = new HerokuAPI({async request() { return {body: [], headers: {'next-range': 'id a..'}} }})
  await assert.rejects(api.list('/apps'), /Repeated pagination/)
})

test('read-only mode rejects every write before transport', async () => {
  let calls = 0
  const api = new HerokuAPI({async request() { calls++; return {body: {}} }}, {readOnly: true})
  await assert.rejects(api.scale('app', 'web', 2, 'Standard-1X', 'app'), /Read-only/)
  await assert.rejects(api.setConfig('app', 'KEY', 'value', 'app'), /Read-only/)
  await assert.rejects(api.maintenance('app', true, 'app'), /Read-only/)
  for (const method of ['PATCH', 'POST', 'DELETE', 'PUT', 'patch']) await assert.rejects(api.request('/apps/app', {method}), /Read-only/)
  assert.equal(calls, 0)
})

test('mutations validate confirmation, quantity, size, and config names', async () => {
  const api = new HerokuAPI({request() { assert.fail('Invalid action reached network') }})
  await assert.rejects(api.scale('production', 'web', 2, 'Standard-1X', 'staging'), /exact app name/)
  for (const quantity of [-1, 1.5, NaN, Infinity, '2']) await assert.rejects(api.scale('app', 'web', quantity, 'Standard-1X', 'app'), /non-negative integer/)
  await assert.rejects(api.scale('app', 'web', 1, '', 'app'), /dyno size/)
  await assert.rejects(api.setConfig('app', 'BAD-NAME', '', 'app'), /Config keys/)
  await assert.rejects(api.maintenance('app', 'true', 'app'), /boolean/)
})

test('confirmed mutations target exactly the app and process requested', async () => {
  const calls = []
  const api = new HerokuAPI({async request(path, options) { calls.push({path, ...options}); return {body: {}} }})
  await api.scale('staging', 'web', 0, 'Standard-1X', 'staging')
  await api.setConfig('staging', 'EMPTY', '', 'staging')
  await api.setConfig('staging', 'DELETE', null, 'staging')
  await api.maintenance('staging', true, 'staging')
  assert.deepEqual(calls.map(c => [c.method, c.path, c.body]), [
    ['PATCH', '/apps/staging/formation/web', {quantity: 0, size: 'Standard-1X'}],
    ['PATCH', '/apps/staging/config-vars', {EMPTY: ''}],
    ['PATCH', '/apps/staging/config-vars', {DELETE: null}],
    ['PATCH', '/apps/staging', {maintenance: true}],
  ])
})

test('app sections fail independently and config is fetched lazily', async () => {
  const calls = []
  const api = new HerokuAPI({async request(path, options) {
    calls.push({path, options})
    if (path.endsWith('/addons')) throw Object.assign(new Error('Forbidden'), {http: {statusCode: 403}})
    return {body: path === '/apps/app' ? {id: 'app', name: 'app'} : []}
  }})
  const data = await api.appData('app')
  assert.equal(data.app.name, 'app')
  assert.match(data.errors.addons, /permission/)
  assert.deepEqual(data.dynos, [])
  assert.ok(!calls.some(c => c.path.endsWith('/config-vars')))
  assert.equal(calls.find(c => c.path.endsWith('/releases')).options.headers.Range, 'version ..; order=desc,max=20;')
})

test('coupling only treats 404 as an app without a pipeline', async () => {
  const api = new HerokuAPI({async request() { throw {http: {statusCode: 404}} }})
  assert.equal(await api.coupling('app'), null)
  api.client.request = async () => { throw {http: {statusCode: 403}} }
  await assert.rejects(api.coupling('app'))
  assert.match(errorMessage({http: {http: {statusCode: 429}}}), /rate limit/)
})

test('app data distinguishes no pipeline from an inaccessible pipeline coupling', async () => {
  let statusCode = 404
  const api = new HerokuAPI({async request(path) {
    if (path.endsWith('/pipeline-couplings')) throw {http: {statusCode}}
    return {body: path === '/apps/app' ? {id: 'app', name: 'app'} : []}
  }})
  const standalone = await api.appData('app')
  assert.equal(standalone.coupling, null)
  assert.equal(standalone.errors.coupling, undefined)
  statusCode = 403
  const inaccessible = await api.appData('app')
  assert.equal(inaccessible.app.name, 'app')
  assert.equal(inaccessible.coupling, null)
  assert.match(inaccessible.errors.coupling, /permission/)
})
