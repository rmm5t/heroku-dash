import assert from 'node:assert/strict'
import test from 'node:test'
import {createDemo} from '../src/demo.js'
import {appRows, clean, operationalMetrics, TABS} from '../src/ui/views.js'

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
  assert.match(rows[0].detail, /1 GB/)
  assert.match(rows[0].detail, /\$50\.00\/month for this process/)
  assert.match(rows[0].detail, /\$25\.00\/dyno\/month/)
  assert.match(rows[1].detail, /Estimated cost\s+Unavailable/)
  assert.match(rows[2].detail, /Shared \$5\/month account plan/)
  assert.ok(!rows[2].detail.includes('$0.00'))
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
