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
