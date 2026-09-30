import assert from 'node:assert/strict'
import test from 'node:test'
import {createDemo, demoTelemetry} from '../src/demo.js'
import {ansi, appRows, clean, operationalMetrics, TABS} from '../src/ui/views.js'

test('config values remain masked except the explicitly revealed variables', async () => {
  const {api, catalog} = createDemo()
  const data = await api.appData(catalog.apps[0].id)
  const config = {PASSWORD: 'secret1', TOKEN: 'secret2', PRIVATE: 'secret3'}
  const hidden = JSON.stringify(appRows('Config', data, {config}))
  assert.ok(!hidden.includes('secret1') && !hidden.includes('secret2'))
  const revealed = new Set(['TOKEN'])
  const visible = JSON.stringify(appRows('Config', data, {config, revealed}))
  assert.ok(!visible.includes('secret1') && visible.includes('secret2'))
  revealed.add('PASSWORD')
  const multiple = JSON.stringify(appRows('Config', data, {config, revealed}))
  assert.ok(multiple.includes('secret1') && multiple.includes('secret2') && !multiple.includes('secret3'))
})

test('all views render demo data and errors without exposing config inadvertently', async () => {
  const {api, catalog} = createDemo()
  const data = await api.appData(catalog.apps[0].id)
  for (const tab of TABS) assert.ok(appRows(tab, data).length)
  data.errors.dynos = 'Permission denied'
  assert.match(JSON.stringify(appRows('Metrics', data)), /unavailable/)
})

test('Settings domain rows identify copyable Hostname and CNAME values and retain domain status', async () => {
  const {api, catalog} = createDemo()
  const data = await api.appData(catalog.apps[0].id)
  data.domains = [{hostname: 'www.example.com', cname: 'target.herokudns.com', kind: 'custom', status: 'succeeded', acm_status: 'pending'}]
  const rows = appRows('Settings', data)
  assert.ok(rows.some(row => row.id === 'action:add-domain'))
  const domain = rows.find(row => row.kind === 'domain')
  assert.deepEqual(domain.copyRanges.map(({start, end, label, value}) => [label, domain.detail.slice(start, end), value]), [
    ['Hostname', 'www.example.com', 'www.example.com'], ['CNAME', 'target.herokudns.com', 'target.herokudns.com'],
  ])
  assert.match(domain.detail, /ACM status\s+pending/)
  data.domains[0].cname = null
  assert.deepEqual(appRows('Settings', data).find(row => row.kind === 'domain').copyRanges.map(range => range.label), ['Hostname'])
})

test('metrics columns show unavailable dyno counts as unknown rather than zero', async () => {
  const {api, catalog} = createDemo()
  const data = await api.appData(catalog.apps[0].id)
  data.dynos = []
  data.errors.dynos = 'Permission denied'
  const metrics = appRows('Metrics', data)
  assert.deepEqual(metrics.find(row => row.columns[0] === 'Dyno health').columns, ['Dyno health', '—', '—', 'Unavailable'])
  const web = metrics.find(row => row.columns[0] === 'web')
  assert.deepEqual(web.columns, ['web', 2, '—', 'Unavailable'])
  assert.match(web.detail, /Permission denied/)
})

test('operational metrics exclude one-off dynos from desired formation health', async () => {
  const {api, catalog} = createDemo()
  const data = await api.appData(catalog.apps[0].id)
  data.dynos.push({type: 'run', state: 'up'})
  assert.deepEqual(operationalMetrics(data), {desired: 3, healthy: 3, total: 4, crashed: 0, starting: 0, coverage: 100})
  data.dynos[0].state = 'crashed'
  assert.equal(operationalMetrics(data).healthy, 2)
})

test('remote text cannot inject terminal control sequences', () => {
  assert.equal(clean('\x1b[31mhello\x1b[0m\x07'), 'hello')
  assert.equal(clean('\x1b]52;c;secret\x07hello'), 'hello')
  assert.equal(ansi('\x1b[31mred\x1b[0m\x1b[2J\x1b]52;c;secret\x07safe'), '\x1b[31mred\x1b[0msafe')
  assert.equal(ansi('\x1b[38;2;10;20;30mtruecolor\x1b[m\x1b[1A'), '\x1b[38;2;10;20;30mtruecolor\x1b[m')
  assert.equal(ansi('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\'), 'link')
})

test('resource details distinguish process estimates, per-dyno rates, Eco, and unknown costs', async () => {
  const {api, catalog} = createDemo()
  const data = await api.appData(catalog.apps[0].id)
  const resources = {provider: {available: true, version: '0.5.1'}, errors: {}, data: {dynos: {
    formations: {
      web: {ramPerDynoMb: 512, allocatedRamMb: 1024, cpuPerDyno: '1x shared', cpu: '2x shared', monthlyCost: 50, unitMonthlyCost: 25},
      worker: {ramPerDynoMb: null, allocatedRamMb: null, cpuPerDyno: 'n/a', cpu: 'n/a', monthlyCost: null},
    },
    instances: {'web.1': {ramPerDynoMb: 512, cpuPerDyno: '1x shared', monthlyCost: 0, ecoPlan: true}},
  }}}
  const rows = appRows('Resources', data, {resources})
  assert.match(rows[0].detail, /512 MB/)
  assert.match(rows[0].detail, /\[s\] scale\s+\[x\] stop\s+\[r\] restart/)
  assert.match(rows[0].detail, /1 GB/)
  assert.match(rows[0].detail, /\$50\.00\/month for this process/)
  assert.match(rows[0].detail, /\$25\.00\/dyno\/month/)
  assert.match(rows.find(row => row.id === 'formation:worker').detail, /Estimated cost\s+Unavailable/)
  const instance = rows.find(row => row.id === 'dyno:web.1')
  assert.match(instance.detail, /Shared \$5\/month account plan/)
  assert.match(instance.detail, /\[r\] restart/)
  assert.ok(!instance.detail.includes('[x] stop'))
  assert.match(instance.columns[3], /up \[r\]/)
  assert.ok(!instance.detail.includes('$0.00'))
})

test('Resources renders idle dynos as stopped and muted', async () => {
  const {api, catalog} = createDemo()
  const data = await api.appData(catalog.apps[0].id)
  data.dynos[0].state = 'idle'
  const idle = appRows('Resources', data).find(row => row.id === `dyno:${data.dynos[0].name}`)
  assert.equal(idle.icon, 'stopped')
  assert.equal(idle.tone, 'muted')
})

test('Resources nests naturally sorted dynos under their process, retaining zero-scale and unmatched entries', async () => {
  const {api, catalog} = createDemo()
  const data = await api.appData(catalog.apps[0].id)
  const base = data.dynos[0]
  data.formation.push({type: 'scheduler', quantity: 0, size: 'Basic'})
  data.dynos = [
    {...base, name: 'run.9', type: 'run'}, {...base, name: 'web.10', size: 'Basic'},
    {...base, name: 'worker.1', type: 'worker', state: 'crashed'},
    {...base, name: 'web.2'}, {...base, name: 'web.1'},
  ]
  const rows = appRows('Resources', data)
  assert.deepEqual(rows.map(row => row.id), [
    'formation:web', 'dyno:web.1', 'dyno:web.2', 'dyno:web.10',
    'formation:worker', 'dyno:worker.1', 'group:other-dynos', 'dyno:run.9', 'formation:scheduler',
  ])
  assert.equal(rows[1].columns[0], '  ├─ web.1')
  assert.equal(rows[3].columns[0], '  └─ web.10')
  assert.equal(rows[3].columns[1], 'Basic', 'Dynos group by process type, even with a different size during a deploy')
  assert.equal(rows[5].columns[0], '  └─ worker.1')
  assert.equal(rows[5].columns[3], 'crashed [r]')
  assert.equal(rows[8].columns[2], 0)
  assert.equal(rows[7].kind, 'dyno')
  assert.match(rows[7].detail, /Process\s+run/)
})

test('Overview and Resources place active processes first without changing formation order', async () => {
  const {api, catalog} = createDemo()
  const data = await api.appData(catalog.apps[0].id)
  const [web, worker] = data.formation
  data.formation = [{type: 'idle-a', quantity: 0, size: 'Basic'}, worker, {type: 'idle-b', quantity: 0, size: 'Basic'}, web]
  const original = [...data.formation]
  data.dynos.push({...data.dynos[0], type: 'idle-a', name: 'idle-a.1'}, {...data.dynos[0], type: 'run', name: 'run.3'})
  const rows = appRows('Resources', data)
  assert.deepEqual(rows.map(row => row.id), [
    'formation:worker', 'dyno:worker.1',
    'formation:web', 'dyno:web.1', 'dyno:web.2',
    'group:other-dynos', 'dyno:run.3',
    'formation:idle-a', 'dyno:idle-a.1', 'formation:idle-b',
  ])
  const overview = appRows('Overview', data)
  assert.deepEqual(overview.filter(row => row.id?.startsWith('overview:formation:')).map(row => row.columns[0]),
    ['worker', 'web', 'idle-a', 'idle-b'])
  assert.deepEqual(data.formation, original)
})

test('Resources keeps dynos visible when the formation cannot be loaded', async () => {
  const {api, catalog} = createDemo()
  const data = await api.appData(catalog.apps[0].id)
  data.formation = []
  data.errors.formation = 'Permission denied'
  const rows = appRows('Resources', data)
  assert.match(rows[0].detail, /Permission denied/)
  assert.equal(rows[1].id, 'group:other-dynos')
  assert.equal(rows.filter(row => row.kind === 'dyno').length, data.dynos.length)
})

test('add-on details show billed price, active limits, shared ownership, and pending changes', async () => {
  const {api, catalog} = createDemo()
  const data = await api.appData(catalog.apps[0].id)
  const item = {costCents: 20000, costUnit: 'month', billingApp: 'other-app', shared: true,
    plan: 'Standard 2', activePlan: 'Standard 0', planChangePending: true, providerStatus: 'Upgrading Plan',
    state: 'upgrade pending', maxConnections: 200, ram: '4 GB', diskSize: '64 GB'}
  const resources = {provider: {available: true, version: '0.5.1'}, errors: {}, data: {addons: {byId: {postgres: item}}}}
  const [row] = appRows('Add-ons', data, {resources})
  assert.match(row.detail, /\$200\.00\/month/)
  assert.match(row.detail, /Connection limit\s+200/)
  assert.match(row.detail, /RAM limit\s+4 GB/)
  assert.match(row.detail, /Disk capacity\s+64 GB/)
  assert.match(row.detail, /Shared attachment/)
  assert.match(row.detail, /limits describe the active plan; cost reflects the billed plan/)
  assert.match(row.label, /upgrade pending/)
  assert.equal(row.tone, 'warning')
  item.contract = true
  assert.match(appRows('Add-ons', data, {resources})[0].detail, /Contract pricing/)
  item.contract = false
  item.metered = true
  assert.match(appRows('Add-ons', data, {resources})[0].detail, /Metered \/ usage-based/)
  item.metered = false
  item.costCents = 0
  assert.match(appRows('Add-ons', data, {resources})[0].detail, /\$0\.00\/month/)
  item.costUnit = 'hour'
  item.costCents = 5
  assert.match(appRows('Add-ons', data, {resources})[0].detail, /\$0\.05\/hour/)
})

test('optional resource integration failures leave the normal resource details visible', async () => {
  const {api, catalog} = createDemo()
  const data = await api.appData(catalog.apps[0].id)
  assert.match(appRows('Resources', data)[0].detail, /Install heroku-resources/)
  const resources = {provider: {available: true}, data: {}, errors: {addons: 'Permission denied'}}
  const [addon] = appRows('Add-ons', data, {resources})
  assert.match(addon.detail, /heroku-postgresql:essential-0/)
  assert.match(addon.detail, /Costs \/ limits unavailable: Permission denied/)
})

test('performance rows display measured units, matching memory quota, and bucket percentiles', async () => {
  const {api, catalog} = createDemo()
  const data = await api.appData(catalog.apps[0].id)
  const snapshot = demoTelemetry(data)
  snapshot.router.latency.series['latency.ms.p95'].fill(125.5)
  snapshot.processes.web.memory.series['memory.swap-plus-rss.bytes.mean'].fill(128 * 1024 ** 2)
  snapshot.processes.web.memory.series['memory.quota.bytes.max'].fill(512 * 1024 ** 2)
  const rows = appRows('Metrics', data, {metrics: {snapshot}})
  const latency = rows.find(row => row.id === 'telemetry:latency:p95')
  assert.equal(latency.columns[2], '125.5 ms')
  assert.match(latency.detail, /not whole-window request percentiles/)
  const memory = rows.find(row => row.id === 'telemetry:memory:web')
  assert.equal(memory.columns[2], '128 MiB')
  assert.match(memory.detail, /Quota \(max\)\s+512 MiB/)
  assert.match(memory.detail, /Usage \/ quota\s+25%/)
  assert.match(rows.find(row => row.id === 'telemetry:load:web').detail, /not CPU utilization percent/)
  assert.match(rows[0].columns[2], /rpm$/)
  assert.match(rows[0].detail, /req\/min/)
})

test('performance rows distinguish missing samples, endpoint errors, and stale readings', async () => {
  const {api, catalog} = createDemo()
  const data = await api.appData(catalog.apps[0].id)
  const snapshot = demoTelemetry(data)
  for (const values of Object.values(snapshot.router.status.series)) values.fill(null)
  snapshot.router.latency = null
  snapshot.errors['router.latency'] = 'Permission denied'
  snapshot.processes.web.memory.times = snapshot.processes.web.memory.times.map(time => time - 3 * 60 * 60_000)
  const rows = appRows('Metrics', data, {metrics: {snapshot}})
  assert.deepEqual(rows[0].columns.slice(2), ['—', 'No samples'])
  assert.match(rows[0].detail, /not a zero reading/)
  const latency = rows.find(row => row.id === 'telemetry:latency:p50')
  assert.equal(latency.columns[3], 'Unavailable')
  assert.match(latency.detail, /Permission denied/)
  const memory = rows.find(row => row.id === 'telemetry:memory:web')
  assert.equal(memory.columns[3], 'Stale')
  assert.equal(memory.tone, 'warning')
  assert.match(memory.detail, /last available sample/)
})
