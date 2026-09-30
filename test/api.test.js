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
  await assert.rejects(api.stop('app', 'web', 'process', 'app'), /Read-only/)
  await assert.rejects(api.restart('app', 'web.1', 'dyno', 'app'), /Read-only/)
  await assert.rejects(api.setConfig('app', 'KEY', 'value', 'app'), /Read-only/)
  await assert.rejects(api.maintenance('app', true, 'app'), /Read-only/)
  await assert.rejects(api.createPipelineApp({name: 'new-app'}, 'new-app'), /Read-only/)
  for (const method of ['PATCH', 'POST', 'DELETE', 'PUT', 'patch']) await assert.rejects(api.request('/apps/app', {method}), /Read-only/)
  assert.equal(calls, 0)
})

test('mutations validate confirmation, quantity, size, and config names', async () => {
  const api = new HerokuAPI({request() { assert.fail('Invalid action reached network') }})
  await assert.rejects(api.scale('production', 'web', 2, 'Standard-1X', 'staging'), /exact app name/)
  await assert.rejects(api.stop('production', 'web', 'process', 'staging'), /exact app name/)
  for (const quantity of [-1, 1.5, NaN, Infinity, '2']) await assert.rejects(api.scale('app', 'web', quantity, 'Standard-1X', 'app'), /non-negative integer/)
  await assert.rejects(api.scale('app', 'web', 1, '', 'app'), /dyno size/)
  await assert.rejects(api.stop('app', '', 'process', 'app'), /Select a process or dyno/)
  await assert.rejects(api.stop('app', 'web', 'app', 'app'), /scope/)
  await assert.rejects(api.dynoAction('app', 'web', 'process', 'delete', 'app'), /must be stop or restart/)
  await assert.rejects(api.setConfig('app', 'BAD-NAME', '', 'app'), /Config keys/)
  await assert.rejects(api.maintenance('app', 'true', 'app'), /boolean/)
})

test('confirmed mutations target exactly the app and process requested', async () => {
  const calls = []
  const api = new HerokuAPI({async request(path, options) { calls.push({path, ...options}); return {body: {}} }})
  await api.scale('staging', 'web', 0, 'Standard-1X', 'staging')
  await api.stop('staging', 'web', 'process', 'staging')
  await api.restart('staging', 'worker', 'process', 'staging')
  await api.stop('staging', 'web.1', 'dyno', 'staging')
  await api.restart('staging', 'worker.2', 'dyno', 'staging')
  await api.setConfig('staging', 'EMPTY', '', 'staging')
  await api.setConfig('staging', 'DELETE', null, 'staging')
  await api.maintenance('staging', true, 'staging')
  assert.deepEqual(calls.map(c => [c.method, c.path, c.body]), [
    ['PATCH', '/apps/staging/formation/web', {quantity: 0, size: 'Standard-1X'}],
    ['POST', '/apps/staging/formations/web/actions/stop', undefined],
    ['DELETE', '/apps/staging/formations/worker', undefined],
    ['POST', '/apps/staging/dynos/web.1/actions/stop', undefined],
    ['DELETE', '/apps/staging/dynos/worker.2', undefined],
    ['PATCH', '/apps/staging/config-vars', {EMPTY: ''}],
    ['PATCH', '/apps/staging/config-vars', {DELETE: null}],
    ['PATCH', '/apps/staging', {maintenance: true}],
  ])
})

test('app creation validates inputs before creating any remote resource', async () => {
  const api = new HerokuAPI({request() { assert.fail('Invalid creation reached network') }})
  const options = {pipeline: {id: 'pipeline-id', owner: {type: 'user', id: 'user-id'}}, stage: 'staging', name: 'new-app', region: 'eu'}
  await assert.rejects(api.createPipelineApp(options, 'other-app'), /exact app name/)
  for (const name of ['ab', 'Bad-name', 'bad-', '3bad', 'a'.repeat(31)]) {
    await assert.rejects(api.createPipelineApp({...options, name}, name), /App names/)
  }
  await assert.rejects(api.createPipelineApp({...options, stage: 'review'}, options.name), /development, staging, or production/)
  await assert.rejects(api.createPipelineApp({...options, region: ''}, options.name), /runtime region/)
  await assert.rejects(api.createPipelineApp({...options, pipeline: {id: 'unknown-owner'}}, options.name), /ownership/)
})

test('app creation uses pipeline ownership and couples the new app by ID', async () => {
  const calls = []
  const api = new HerokuAPI({async request(path, options) {
    calls.push({path, ...options})
    return {body: path === '/teams/team-id' ? {id: 'team-id', name: 'acme'} : {id: 'new-id', name: 'new-app'}}
  }})
  const pipeline = {id: 'pipeline-id', name: 'service', owner: {type: 'team', id: 'team-id'}}
  const created = await api.createPipelineApp({pipeline, stage: 'staging', name: 'new-app', region: 'eu'}, 'new-app')
  assert.equal(created.stage, 'staging')
  assert.deepEqual(calls.map(({method, path, body}) => [method, path, body]), [
    ['GET', '/teams/team-id', undefined],
    ['POST', '/teams/apps', {name: 'new-app', region: 'eu', team: 'acme'}],
    ['POST', '/pipeline-couplings', {app: 'new-id', pipeline: 'pipeline-id', stage: 'staging'}],
  ])
  calls.length = 0
  await api.createPipelineApp({pipeline: {...pipeline, owner: {type: 'user', id: 'user-id'}}, stage: 'production', name: 'new-app', region: 'us'}, 'new-app')
  assert.deepEqual(calls[0].body, {name: 'new-app', region: 'us', personal: true})
})

test('runtime regions exclude Private Spaces and creation reports a partial attachment failure', async () => {
  const calls = []
  const app = {id: 'new-id', name: 'new-app'}
  const api = new HerokuAPI({async request(path, options) {
    calls.push({path, ...options})
    if (path === '/regions') return {body: [{name: 'us'}, {name: 'virginia', private_capable: true}, {name: 'eu'}]}
    if (path === '/pipeline-couplings') throw new Error('Attachment denied')
    return {body: app}
  }})
  assert.deepEqual((await api.appRegions()).map(region => region.name), ['eu', 'us'])
  await assert.rejects(api.createPipelineApp({pipeline: {id: 'pipe', name: 'service', owner: null}, stage: 'development', name: app.name, region: 'us'}, app.name), error => {
    assert.equal(error.createdApp, app)
    assert.match(error.message, /was created.*service failed: Attachment denied/)
    return true
  })
  assert.ok(!calls.some(call => call.method === 'DELETE'))
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
