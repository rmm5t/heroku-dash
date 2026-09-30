import assert from 'node:assert/strict'
import test from 'node:test'
import {errorMessage, HerokuAPI, normalizeHostname} from '../src/api.js'

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

test('add-on dashboards use authoritative datastore and third-party SSO links, preferring the current attachment', async () => {
  const api = new HerokuAPI({request() { assert.fail('Cached dashboard URLs should not make requests') }}, {readOnly: true})
  const datastore = 'https://data.heroku.com/datastores/database-id'
  const owner = 'https://addons-sso.heroku.com/apps/owner-app/addons/addon-id'
  const current = 'https://addons-sso.heroku.com/apps/current-app/attachments/attachment-id'
  assert.equal(await api.addonDashboardUrl({id: 'postgres-addon', web_url: datastore}), datastore)
  assert.equal(await api.addonDashboardUrl({id: 'third-party', web_url: owner}), owner)
  assert.equal(await api.addonDashboardUrl({id: 'shared-addon', web_url: owner}, {id: 'attachment-id', web_url: current}), current)
})

test('Heroku Postgres and Key-Value Store bypass generic SSO links and open current-app datastore overview', async () => {
  const api = new HerokuAPI({request() { assert.fail('Known datastore links should not need a lookup') }}, {readOnly: true})
  const sso = 'https://addons-sso.heroku.com/apps/owner-app/addons/addon-id'
  for (const service of ['heroku-postgresql', 'heroku-redis', 'heroku-key-value-store']) {
    const addon = {id: 'addon-id', addon_service: {name: service}, app: {name: 'owner-app'}, web_url: sso}
    assert.equal(await api.addonDashboardUrl(addon, {web_url: sso}, {name: 'current-app'}),
      'https://dashboard.heroku.com/apps/current-app/datastores/addon-id')
    assert.equal(await api.addonDashboardUrl(addon),
      'https://dashboard.heroku.com/apps/owner-app/datastores/addon-id')
  }
})

test('shared datastore stubs resolve service metadata before opening an attachment SSO link', async () => {
  const paths = []
  const api = new HerokuAPI({async request(path, options) {
    assert.equal(options.method, 'GET')
    paths.push(path)
    return {body: {id: 'shared-addon', addon_service: {name: 'heroku-postgresql'}, app: {name: 'owner-app'}}}
  }}, {readOnly: true})
  assert.equal(await api.addonDashboardUrl({id: 'shared-addon', plan: {name: 'essential-0'}}, {web_url: 'https://addons-sso.heroku.com/apps/current-app/attachments/id'}, {name: 'current-app'}),
    'https://dashboard.heroku.com/apps/current-app/datastores/shared-addon')
  assert.deepEqual(paths, ['/addons/shared-addon'])
})

test('missing dashboard metadata is loaded using GET-only attachment and add-on endpoints', async () => {
  const calls = []
  const url = 'https://addons-sso.heroku.com/apps/current-app/attachments/attachment-id'
  const api = new HerokuAPI({async request(path, options) {
    calls.push({path, method: options.method})
    assert.equal(options.method, 'GET')
    return {body: {web_url: url}}
  }}, {readOnly: true})
  assert.equal(await api.addonDashboardUrl({id: 'addon-id'}, {id: 'attachment-id'}), url)
  assert.equal(await api.addonDashboardUrl({id: 'addon-id'}), url)
  assert.deepEqual(calls, [
    {path: '/addon-attachments/attachment-id', method: 'GET'}, {path: '/addons/addon-id', method: 'GET'},
  ])
})

test('add-on dashboard lookup handles removed attachments, permission failures, and invalid links', async () => {
  const url = 'https://data.heroku.com/datastores/database-id'
  let status = 404
  const api = new HerokuAPI({async request() { throw {statusCode: status} }})
  assert.equal(await api.addonDashboardUrl({id: 'addon-id', web_url: url}, {id: 'removed-attachment'}), url)
  status = 403
  await assert.rejects(api.addonDashboardUrl({id: 'addon-id', web_url: url}, {id: 'attachment-id'}), error => error.statusCode === 403)
  await assert.rejects(api.addonDashboardUrl({id: 'addon-id', web_url: 'javascript:alert("sso-secret")'}), error => {
    assert.match(error.message, /valid HTTP dashboard URL/)
    assert.ok(!error.message.includes('sso-secret'))
    return true
  })
  api.client.request = async () => ({body: {}})
  await assert.rejects(api.addonDashboardUrl({id: 'addon-id'}), /does not provide a management dashboard/)
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
  await assert.rejects(api.promotePipelineApp({source: {name: 'source-app'}}, 'source-app'), /Read-only/)
  await assert.rejects(api.addDomain('app', 'www.example.com', true, 'app'), /Read-only/)
  await assert.rejects(api.removeDomain('app', {kind: 'custom', hostname: 'www.example.com'}, 'app'), /Read-only/)
  await assert.rejects(api.clonePipelineConfig({destination: {name: 'destination'}}, 'destination'), /Read-only/)
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

test('pipeline promotion validates stages and rechecks membership before deploying by ID', async () => {
  const source = {id: 'source-id', name: 'source-app', stage: 'staging'}
  const target = {id: 'target-id', name: 'target-app', stage: 'production'}
  const pipeline = {id: 'pipeline-id'}
  const options = {pipeline, source, stage: 'production', targets: [target]}
  let couplings = [source, target].map(app => ({app: {id: app.id}, stage: app.stage}))
  const calls = []
  const api = new HerokuAPI({async request(path, options) {
    calls.push({path, ...options})
    return {body: options.method === 'GET' ? couplings : {id: 'promotion-id'}}
  }})
  await assert.rejects(api.promotePipelineApp(options, 'wrong-name'), /exact app name/)
  await assert.rejects(api.promotePipelineApp({...options, stage: 'development'}, source.name), /higher pipeline stage/)
  await assert.rejects(api.promotePipelineApp({...options, targets: [source]}, source.name), /downstream apps/)
  await assert.rejects(api.promotePipelineApp({...options, targets: []}, source.name), /downstream apps/)
  assert.equal(calls.length, 0)
  assert.deepEqual(await api.promotePipelineApp(options, source.name), {id: 'promotion-id'})
  assert.deepEqual(calls.map(({path, method, body}) => [method, path, body]), [
    ['GET', '/pipelines/pipeline-id/pipeline-couplings', undefined],
    ['POST', '/pipeline-promotions', {pipeline: {id: pipeline.id}, source: {app: {id: source.id}}, targets: [{app: {id: target.id}}]}],
  ])
  calls.length = 0
  couplings = couplings.map(coupling => ({...coupling, stage: 'staging'}))
  await assert.rejects(api.promotePipelineApp(options, source.name), /stages changed/)
  assert.ok(calls.every(call => call.method === 'GET'))
})

test('promotion tracking waits for every destination and preserves per-app failure details', async () => {
  const targets = [{id: 'first'}, {id: 'second'}]
  let requests = 0
  const api = new HerokuAPI({async request(path) {
    assert.equal(path, '/pipeline-promotions/promotion-id/promotion-targets')
    requests++
    return {body: targets.map((app, index) => ({app, status: requests === 1 ? 'pending' : index ? 'failed' : 'succeeded',
      ...(index && requests > 1 ? {error_message: 'Release command failed'} : {})}))}
  }})
  const updates = []
  let waits = 0
  const results = await api.waitForPromotion({id: 'promotion-id'}, targets, {
    wait: async () => { waits++ }, onUpdate: results => updates.push(results),
  })
  assert.equal(waits, 1)
  assert.equal(updates.length, 2)
  assert.equal(results[1].error_message, 'Release command failed')
})

test('promotion tracking bounds polling and supports cancellation without repeating the write', async () => {
  let requests = 0
  const api = new HerokuAPI({async request() { requests++; return {body: []} }})
  const targets = [{id: 'target'}]
  await assert.rejects(api.waitForPromotion({id: 'promotion-id'}, targets, {attempts: 2, wait: async () => {}}), /promotion-id.*still pending/)
  assert.equal(requests, 2)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(api.waitForPromotion({id: 'promotion-id'}, targets, {signal: controller.signal}), {name: 'AbortError'})
  assert.equal(requests, 2)
})

test('domain input validates hostnames and rejects URL components before any write', async () => {
  assert.equal(normalizeHostname(' WWW.Example.COM. '), 'www.example.com')
  assert.equal(normalizeHostname('bücher.example'), 'xn--bcher-kva.example')
  assert.equal(normalizeHostname('*.example.com'), '*.example.com')
  const api = new HerokuAPI({request() { assert.fail('Invalid domain reached transport') }})
  for (const hostname of ['https://example.com', 'example.com/path', 'example.com?x', 'example.com#x', 'user@example.com', 'example.com:443', '127.0.0.1', 'bad_name.example', '-bad.example', 'localhost', 'a'.repeat(64) + '.example']) {
    await assert.rejects(api.addDomain('app', hostname, false, 'app'), /valid domain hostname/)
  }
  await assert.rejects(api.addDomain('app', 'www.example.com', true, 'other-app'), /exact app name/)
  await assert.rejects(api.addDomain('app', '*.example.com', true, 'app'), /ACM does not support wildcard/)
})

test('domain creation targets the confirmed app and optionally enables app-wide ACM', async () => {
  const calls = []
  const domain = {id: 'domain-id', hostname: 'www.example.com', cname: 'dns-target.herokudns.com'}
  const api = new HerokuAPI({async request(path, options) { calls.push({path, ...options}); return {body: domain} }})
  assert.deepEqual(await api.addDomain('app', 'WWW.EXAMPLE.COM', false, 'app'), domain)
  assert.deepEqual(calls.map(({path, method, body}) => [method, path, body]), [
    ['POST', '/apps/app/domains', {hostname: 'www.example.com', sni_endpoint: null}],
  ])
  calls.length = 0
  await api.addDomain('app', domain.hostname, true, 'app')
  assert.deepEqual(calls.map(({path, method, body}) => [method, path, body]), [
    ['POST', '/apps/app/domains', {hostname: 'www.example.com', sni_endpoint: null}],
    ['POST', '/apps/app/acm', {}],
  ])
})

test('ACM failure reports that the domain was added and preserves the new domain', async () => {
  const domain = {id: 'domain-id', hostname: 'www.example.com'}
  const api = new HerokuAPI({async request(path, options) {
    assert.equal(options.method, 'POST')
    if (path.endsWith('/acm')) throw new Error('ACM unavailable')
    return {body: domain}
  }})
  await assert.rejects(api.addDomain('app', domain.hostname, true, 'app'), error => {
    assert.equal(error.createdDomain, domain)
    assert.match(error.message, /was added, but enabling ACM failed: ACM unavailable/)
    return true
  })
})

test('domain removal requires exact confirmation and rejects built-in domains before transport', async () => {
  const api = new HerokuAPI({request() { assert.fail('Invalid removal reached transport') }})
  await assert.rejects(api.removeDomain('app', {kind: 'custom', hostname: 'www.example.com'}, 'other-app'), /exact app name/)
  await assert.rejects(api.removeDomain('app', {kind: 'heroku', hostname: 'app.herokuapp.com'}, 'app'), /Only custom domains/)
  await assert.rejects(api.removeDomain('app', null, 'app'), /Only custom domains/)
})

test('domain removal scopes the DELETE to the confirmed app and selected domain', async () => {
  const calls = []
  const api = new HerokuAPI({async request(path, options) { calls.push({path, ...options}); return {body: {}} }})
  await api.removeDomain('app', {kind: 'custom', id: 'domain-id', hostname: 'www.example.com'}, 'app')
  await api.removeDomain('app', {kind: 'custom', hostname: '*.example.com'}, 'app')
  assert.deepEqual(calls.map(({path, method}) => [method, path]), [
    ['DELETE', '/apps/app/domains/domain-id'], ['DELETE', '/apps/app/domains/*.example.com'],
  ])
})

test('config cloning excludes HEROKU_* vars and initializes an empty destination with exact values', async () => {
  const source = {id: 'source-id', name: 'source-app'}
  const destination = {id: 'destination-id', name: 'destination-app'}
  const pipeline = {id: 'pipeline-id'}
  const configs = {
    'source-id': {SHARED: 'source secret', EMPTY: '', MULTILINE: '  café\nquotes: "x" \'y\' $value\\path\n', HEROKU_APP_ID: source.id, HEROKU_RELEASE_VERSION: 'v10'},
    'destination-id': {},
  }
  const originalSource = structuredClone(configs[source.id])
  const writes = []
  const api = new HerokuAPI({async request(path, options) {
    if (path === '/pipelines/pipeline-id/pipeline-couplings') return {body: [source, destination].map(app => ({app: {id: app.id}}))}
    const id = path.split('/')[2]
    if (options.method === 'PATCH') {
      writes.push({path, body: options.body, ifMatch: options.headers['If-Match']})
      Object.assign(configs[id], options.body)
    }
    return {body: structuredClone(configs[id]), headers: {etag: '"empty-config"'}}
  }})
  const plan = await api.prepareConfigClone({pipeline, source, destination})
  assert.equal(plan.skippedCount, 2)
  assert.deepEqual(Object.keys(plan.values), ['SHARED', 'EMPTY', 'MULTILINE'])
  assert.equal(await api.clonePipelineConfig(plan, destination.name), 3)
  assert.deepEqual(writes, [{path: '/apps/destination-id/config-vars', body: plan.values, ifMatch: '"empty-config"'}])
  assert.deepEqual(configs[source.id], originalSource)
  assert.deepEqual(configs[destination.id], plan.values)
})

test('config cloning validates current-app confirmation and rechecks pipeline membership before the write', async () => {
  const source = {id: 'source-id', name: 'source-app'}
  const destination = {id: 'destination-id', name: 'destination-app'}
  const pipeline = {id: 'pipeline-id'}
  let members = [source, destination]
  const calls = []
  const api = new HerokuAPI({async request(path, options) {
    calls.push({path, ...options})
    assert.equal(options.method, 'GET', 'No write should reach transport')
    return {body: path.endsWith('/pipeline-couplings') ? members.map(app => ({app: {id: app.id}})) : path.includes(destination.id) ? {} : {KEY: 'value'}}
  }})
  const plan = await api.prepareConfigClone({pipeline, source, destination})
  calls.length = 0
  await assert.rejects(api.clonePipelineConfig(plan, source.name), /exact app name/)
  assert.equal(calls.length, 0)
  members = [source]
  await assert.rejects(api.clonePipelineConfig(plan, destination.name), /Both apps must belong/)
  assert.equal(calls.length, 1)
  calls.length = 0
  await assert.rejects(api.prepareConfigClone({pipeline, source, destination: source}), /two different apps/)
  assert.equal(calls.length, 0)
})

test('empty or invalid cloned config values cannot issue a PATCH or delete destination variables', async () => {
  const api = new HerokuAPI({request() { assert.fail('Invalid config clone reached transport') }})
  const plan = {pipeline: {id: 'pipe'}, source: {id: 'source'}, destination: {id: 'destination', name: 'destination-app'}}
  await assert.rejects(api.clonePipelineConfig({...plan, values: {HEROKU_APP_ID: 'source'}}, 'destination-app'), /no config vars to clone/)
  await assert.rejects(api.clonePipelineConfig({...plan, values: {KEY: null}}, 'destination-app'), /string values/)
  await assert.rejects(api.clonePipelineConfig({...plan, values: {'BAD-KEY': 'value'}}, 'destination-app'), /valid keys/)
})

test('any destination key prevents cloning at preparation and immediately before applying', async () => {
  const source = {id: 'source-id', name: 'source-app'}
  const destination = {id: 'destination-id', name: 'destination-app'}
  const pipeline = {id: 'pipeline-id'}
  for (const config of [{EXISTING: 'value'}, {EMPTY: ''}, {HEROKU_APP_ID: destination.id}]) {
    const paths = []
    const api = new HerokuAPI({async request(path, options) {
      paths.push(path)
      assert.equal(options.method, 'GET', 'Existing config must never be overwritten')
      return {body: path.endsWith('/pipeline-couplings') ? [source, destination].map(app => ({app: {id: app.id}})) : config}
    }})
    await assert.rejects(api.prepareConfigClone({pipeline, source, destination}), /current app has no config vars/)
    assert.ok(!paths.includes('/apps/source-id/config-vars'), 'Do not read source secrets when the destination is populated')
    await assert.rejects(api.clonePipelineConfig({pipeline, source, destination, values: {EXISTING: 'overwrite'}}, destination.name), /current app has no config vars/)
    assert.ok(!Object.values(config).includes('overwrite'))
  }
})

test('config added after preparation blocks cloning and leaves the new value intact', async () => {
  const source = {id: 'source-id', name: 'source-app'}
  const destination = {id: 'destination-id', name: 'destination-app'}
  let config = {}
  const api = new HerokuAPI({async request(path, options) {
    assert.equal(options.method, 'GET')
    return {body: path.endsWith('/pipeline-couplings') ? [source, destination].map(app => ({app: {id: app.id}}))
      : path.includes(source.id) ? {KEY: 'source-value'} : config}
  }})
  const plan = await api.prepareConfigClone({pipeline: {id: 'pipe'}, source, destination})
  config = {KEY: 'added-during-confirmation'}
  await assert.rejects(api.clonePipelineConfig(plan, destination.name), /current app has no config vars/)
  assert.deepEqual(config, {KEY: 'added-during-confirmation'})
})

test('conditional cloning preserves a concurrent config change between the final read and write', async () => {
  const source = {id: 'source-id', name: 'source-app'}
  const destination = {id: 'destination-id', name: 'destination-app'}
  const config = {}
  const api = new HerokuAPI({async request(path, options) {
    if (path.endsWith('/pipeline-couplings')) return {body: [source, destination].map(app => ({app: {id: app.id}}))}
    if (options.method === 'GET') return {body: {}, headers: {etag: '"empty-config"'}}
    config.KEY = 'concurrent-value'
    if (options.headers['If-Match'] === '"empty-config"') throw Object.assign(new Error('Config changed'), {statusCode: 412})
    Object.assign(config, options.body)
    return {body: config}
  }})
  await assert.rejects(api.clonePipelineConfig({pipeline: {id: 'pipe'}, source, destination, values: {KEY: 'source-value'}}, destination.name), /Config changed/)
  assert.deepEqual(config, {KEY: 'concurrent-value'})
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
