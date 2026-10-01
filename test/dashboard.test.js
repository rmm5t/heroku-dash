import assert from 'node:assert/strict'
import {PassThrough, Writable} from 'node:stream'
import {setTimeout as delay} from 'node:timers/promises'
import test from 'node:test'
import blessed from 'blessed'
import {createDemo, demoTelemetry} from '../src/demo.js'
import {Dashboard} from '../src/ui/dashboard.js'
import {clean} from '../src/ui/text.js'
import {icons, palette} from '../src/ui/theme.js'
import {TABS} from '../src/ui/views.js'

const breadcrumbs = dashboard => clean(dashboard.header.content).split('\n')[1]
  .split(icons.chevron).map(part => part.trim().replace(/^\S+\s+/, ''))

function tabCell(dashboard, screen, index, offset = 0) {
  const {xi, xl, yi} = dashboard.tabs.lpos
  const left = xi + dashboard.tabs.ileft
  const y = yi + dashboard.tabs.itop
  const cells = screen.lines[y].slice(left, xl - dashboard.tabs.iright)
  const digit = cells.findIndex(cell => cell[1] === String(index + 1))
  assert.ok(digit >= 0, `Tab ${index + 1} must be visible`)
  return [left + digit + offset, y]
}

async function harness(t, override = {}) {
  const input = new PassThrough()
  input.isTTY = true
  input.setRawMode = () => {}
  const output = new Writable({write(_chunk, _encoding, callback) { callback() }})
  Object.assign(output, {isTTY: true, columns: 140, rows: 45})
  const screen = blessed.screen({input, output, terminal: 'xterm-256color', fullUnicode: true, smartCSR: false})
  const demo = createDemo()
  const dashboard = new Dashboard({...demo, screen, refresh: 0, ...override})
  t.after(() => { dashboard.close(); input.destroy(); output.destroy() })
  await dashboard.start()
  return {dashboard, screen, input,
    async key(value) { input.write(value); await delay(15) },
    async click(x, y, button = 'left') {
      screen.program.emit('mouse', {x, y, button, action: 'mousedown'})
      screen.program.emit('mouse', {x, y, button, action: 'mouseup'})
      await delay(15)
    },
  }
}

test('keyboard opens pipeline apps and switches all app views', async t => {
  const {dashboard: d, key} = await harness(t)
  assert.equal(d.rows[0].kind, 'app')
  assert.ok(!clean(d.footer.content).includes(': command'))
  assert.ok(clean(d.footer.content).includes('A add app'))
  assert.ok(!clean(d.footer.content).includes('C console'))
  assert.ok(!clean(d.footer.content).includes('Esc back'))
  await key('\r')
  assert.equal(d.app.name, 'constellation-staging')
  assert.ok(clean(d.footer.content).includes(': command'))
  assert.ok(!clean(d.footer.content).includes('A add app'))
  assert.ok(clean(d.footer.content).includes('C console'))
  for (let tab = 1; tab <= 7; tab++) {
    await key(String(tab))
    assert.equal(d.tab, tab - 1)
    assert.ok(d.rows.length)
  }
  const app = d.app
  await key('\x1b')
  assert.equal(d.app, app)
  assert.equal(d.tab, 6)
})

test('app views and pane focus remain responsive while app data loads, and Config loads independently', async t => {
  const {dashboard: d, screen, key, click} = await harness(t)
  const app = d.rows[0].value
  const data = await d.api.appData(app.id)
  let resolve
  d.api.appData = () => new Promise(done => { resolve = done })
  let configReads = 0
  d.api.config = async () => { configReads++; return {READY: 'loaded'} }
  const loading = d.openApp(app)
  assert.equal(d.busy, false)
  assert.equal(d.data, null)
  await key('2')
  assert.match(clean(d.main._label.content), /Resources/)
  assert.match(d.rows[0].label, /Loading resources/)
  await key('l')
  assert.match(clean(d.main._label.content), /Add-ons/)
  await click(...tabCell(d, screen, 4))
  assert.match(d.rows[0].label, /Loading settings/)
  await key('7')
  await key('T')
  assert.equal(d.metricsWindowHours, 24)
  await key('4')
  assert.equal(configReads, 1)
  assert.equal(d.data, null)
  assert.equal(d.rows[0].key, 'READY')
  await key('v')
  assert.match(clean(d.detail.content), /loaded/)
  await key('\t')
  assert.equal(screen.focused, d.detail)
  await key('\t')
  assert.equal(screen.focused, d.nav)
  resolve(data)
  await loading
  assert.equal(d.tab, 3)
  assert.equal(configReads, 1)
  assert.equal(d.rows[0].key, 'READY')
  assert.equal(screen.focused, d.nav)
})

test('opening on Config starts its read alongside app data rather than waiting for the snapshot', async t => {
  const {dashboard: d, key} = await harness(t)
  await key('\r')
  await key('4')
  const app = d.catalog.apps.find(app => app.id !== d.app.id)
  const data = await d.api.appData(app.id)
  let resolve
  d.api.appData = () => new Promise(done => { resolve = done })
  let configReads = 0
  d.api.config = async id => { configReads++; assert.equal(id, app.id); return {DESTINATION: 'new app'} }
  const loading = d.openApp(app)
  await delay(0)
  assert.equal(configReads, 1)
  assert.equal(d.data, null)
  assert.equal(d.rows[0].key, 'DESTINATION')
  assert.equal(d.revealed.size, 0)
  resolve(data)
  await loading
  assert.equal(configReads, 1)
})

test('an app snapshot failure keeps independent Config results usable and other tabs show the error', async t => {
  const {dashboard: d, key} = await harness(t)
  d.tab = 3
  d.api.appData = async () => { throw new Error('App lookup failed') }
  d.api.config = async () => ({AVAILABLE: 'value'})
  await d.openApp(d.rows[0].value)
  assert.equal(d.rows[0].key, 'AVAILABLE')
  await key('2')
  assert.equal(d.rows[0].label, 'Unable to load app')
  assert.match(d.rows[0].detail, /App lookup failed/)
  await key('4')
  assert.equal(d.rows[0].key, 'AVAILABLE')
})

test('slow breadcrumb reads do not delay app panes and are canceled when navigating away', async t => {
  const {dashboard: d, key} = await harness(t)
  const app = d.rows[0].value
  const data = await d.api.appData(app.id)
  data.app = {...data.app, team: null}
  data.coupling = {pipeline: {id: 'slow-parent', name: 'Slow parent'}}
  d.api.appData = async () => data
  let resolve
  let signal
  d.api.get = (path, options) => {
    assert.equal(path, '/pipelines/slow-parent')
    signal = options.signal
    return new Promise(done => { resolve = done })
  }
  await d.openApp(app)
  assert.equal(d.data, data)
  assert.equal(d.loading.has('app'), false)
  assert.equal(d.readRequests.has('hierarchy'), true)
  await key('2')
  assert.ok(d.rows.some(row => row.kind === 'formation'))
  await d.openPipeline(d.catalog.pipelines[0])
  assert.equal(signal.aborted, true)
  resolve({id: 'slow-parent', name: 'Late parent', owner: {type: 'user', id: 'owner'}})
  await delay(0)
  assert.equal(d.pipeline.id, d.catalog.pipelines[0].id)
  assert.equal(d.app, null)
})

test('pipeline completion preserves pane focus changed while loading', async t => {
  const {dashboard: d, screen, key} = await harness(t)
  const apps = await d.api.pipelineApps()
  let resolve
  d.api.pipelineApps = () => new Promise(done => { resolve = done })
  const loading = d.openPipeline(d.pipeline)
  await key('a')
  assert.equal(screen.focused, d.nav)
  resolve(apps)
  await loading
  assert.equal(screen.focused, d.nav)
})

async function progressiveApp(t, override = {}) {
  const demo = createDemo()
  const app = demo.catalog.apps[0]
  const appData = demo.api.appData.bind(demo.api)
  const snapshot = await appData(app.id)
  const sections = {app: '', coupling: '/pipeline-couplings', formation: '/formation', dynos: '/dynos',
    addons: '/addons', attachments: '/addon-attachments', domains: '/domains', buildpacks: '/buildpack-installations', releases: '/releases'}
  const gates = Object.fromEntries(Object.keys(sections).map(section => [section, Promise.withResolvers()]))
  demo.api.client.request = path => {
    const section = Object.keys(sections).find(section => path === `/apps/${app.id}${sections[section]}`)
    assert.ok(section, `Unexpected request: ${path}`)
    return gates[section].promise.then(body => ({body}))
  }
  delete demo.api.appData
  const ui = await harness(t, {...demo, ...override})
  const loading = ui.dashboard.openApp(app)
  return {...ui, gates, snapshot, loading, appData,
    async settle(...sections) {
      for (const section of sections) gates[section].resolve(snapshot[section])
      await new Promise(resolve => setImmediate(resolve))
    },
    async finish() {
      for (const [section, gate] of Object.entries(gates)) gate.resolve(snapshot[section])
      await loading
    },
  }
}

test('ready app panes render before unrelated sections finish, with pending sections visibly loading', async t => {
  const p = await progressiveApp(t)
  const {dashboard: d, gates, key, screen} = p
  await p.settle('app', 'coupling')
  assert.match(clean(d.summary.content), /Loading dynos/)
  assert.match(clean(d.summary.content), /Loading add-ons/)
  await key('2')
  await p.settle('formation')
  assert.match(d.rows[0].label, /Loading resources/)
  await p.settle('dynos')
  assert.ok(d.rows.some(row => row.kind === 'formation'))
  assert.equal(d.loading.has('app'), true)
  assert.ok(d.data.pending.includes('releases'))
  await key('3')
  assert.match(d.rows[0].label, /Loading add-ons/)
  await p.settle('addons', 'attachments')
  assert.ok(d.rows.some(row => row.kind === 'addon'))
  await key('5')
  assert.match(d.rows[0].label, /Loading settings/)
  gates.domains.reject(new Error('Domains lookup failed'))
  await p.settle('buildpacks')
  assert.ok(d.rows.some(row => /domains unavailable/.test(row.label)))
  await key('6')
  assert.match(d.rows[0].label, /Loading releases/)
  await key('\t')
  const focus = screen.focused
  await p.finish()
  assert.ok(d.rows.some(row => /v\d/.test(row.label)))
  assert.equal(screen.focused, focus)
  assert.equal(d.loading.has('app'), false)
  assert.deepEqual(d.data.pending, [])
})

test('progressive snapshots start enrichment and metrics only when ready without repeating them on completion', async t => {
  let resourceReads = 0
  let metricsReads = 0
  const p = await progressiveApp(t, {
    resources: {available: true, async dynos() { resourceReads++; return {} }},
    async fetchMetrics(data) { metricsReads++; return demoTelemetry(data) },
  })
  const {dashboard: d, key} = p
  await key('2')
  await p.settle('app', 'formation')
  assert.equal(resourceReads, 0)
  await p.settle('dynos')
  assert.equal(resourceReads, 1)
  const snapshot = d.data
  d.main.select(1)
  const selected = d.rows[d.main.selected].id
  await p.settle('addons', 'attachments')
  assert.equal(d.rows[d.main.selected].id, selected)
  assert.equal(d.data, snapshot)
  await key('7')
  assert.equal(metricsReads, 1)
  assert.ok(!d.rows.some(row => row.id === 'releases'))
  await p.finish()
  assert.equal(resourceReads, 1)
  assert.equal(metricsReads, 1)
  assert.ok(d.rows.some(row => row.id === 'releases'))
})

test('navigating away from a progressive snapshot cancels pending sections and ignores late updates', async t => {
  const p = await progressiveApp(t)
  const {dashboard: d, gates} = p
  await p.settle('app', 'formation', 'dynos')
  const old = d.data
  d.api.appData = p.appData
  await d.openApp(d.catalog.apps[1])
  await p.loading
  const current = d.data
  const message = d.message
  gates.releases.reject(new Error('Old releases failed'))
  await p.finish()
  assert.notEqual(current, old)
  assert.equal(d.data, current)
  assert.equal(d.app.id, d.catalog.apps[1].id)
  assert.equal(d.message, message)
})

test('partial pipeline loads show unavailable rows while accessible apps still open and retries recover', async t => {
  const demo = createDemo()
  const apps = await demo.api.pipelineApps()
  let fail = true
  demo.api.client.request = async path => {
    if (path.endsWith('pipeline-couplings')) return {body: apps.map(app => ({app: {id: app.id, name: app.name}, stage: app.stage}))}
    const app = apps.find(app => path.endsWith(`/${app.id}`))
    assert.ok(app)
    if (fail && app.stage === 'production') throw Object.assign(new Error('Forbidden'), {statusCode: 403})
    return {body: app}
  }
  // Exercise the real loader rather than the demo's all-success override.
  delete demo.api.pipelineApps
  const {dashboard: d, key} = await harness(t, demo)
  assert.equal(d.rows.length, 2)
  assert.equal(d.rows[0].kind, 'app')
  assert.equal(d.rows[1].kind, 'unavailable-app')
  assert.equal(d.rows[1].value.id, apps[1].id)
  assert.match(d.rows[1].label, /Unavailable/)
  assert.match(d.rows[1].detail, /permission/)
  assert.match(clean(d.summary.content), /production: 1/)
  assert.match(d.message, /1 app unavailable/)
  assert.equal(d.messageTone, 'warning')
  d.main.select(1)
  await key('\r')
  await key('P')
  assert.equal(d.app, null)
  assert.equal(d.modal, undefined)
  d.main.select(0)
  await key('\r')
  assert.equal(d.app.id, apps[0].id)
  await d.back()
  fail = false
  await d.reload()
  assert.ok(d.rows.every(row => row.kind === 'app'))
  assert.equal(d.messageTone, 'success')
  assert.ok(!d.message.includes('unavailable'))
  d.main.select(1)
  await key('\r')
  assert.equal(d.app.id, apps[1].id)
})

test('pipeline app failures remain visible even when no app details can be loaded', async t => {
  const demo = createDemo()
  const apps = await demo.api.pipelineApps()
  demo.api.pipelineApps = async () => apps.map(app => ({id: app.id, name: app.name, stage: app.stage, loadError: 'Timed out'}))
  const {dashboard: d} = await harness(t, demo)
  assert.equal(d.rows.length, apps.length)
  assert.ok(d.rows.every(row => row.kind === 'unavailable-app' && /Timed out/.test(row.detail)))
  assert.match(d.message, /2 apps unavailable/)
  assert.equal(d.messageTone, 'warning')
})

test('promotion does not proceed with unavailable pipeline app details', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const {dashboard: d, key} = await harness(t, {...demo, demo: false})
  const apps = await demo.api.pipelineApps()
  d.api.pipelineApps = async () => [apps[0], {...apps[1], loadError: 'Forbidden'}]
  d.api.promotePipelineApp = async () => assert.fail('Incomplete pipeline lookup must not promote')
  await key('P')
  assert.match(d.message, /apps are unavailable/)
  assert.equal(d.modal, null)
  assert.equal(d.busy, false)
})

test('config cloning source choices exclude unavailable pipeline apps', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  demo.api.config = async () => ({})
  const apps = await demo.api.pipelineApps()
  demo.api.pipelineApps = async () => [...apps, {id: 'unavailable', name: 'unavailable-app', stage: 'production', loadError: 'Forbidden'}]
  demo.api.prepareConfigClone = async () => assert.fail('Canceled source selection must not prepare a clone')
  const {dashboard: d, key} = await harness(t, {...demo, demo: false})
  await key('\r')
  await key('4')
  await key('Y')
  assert.deepEqual(d.modal.children.find(child => child.type === 'list').items.map(item => item.content), ['constellation-production · production'])
  await key('\x1b')
  assert.equal(d.modal, null)
  d.api.pipelineApps = async () => [d.app, {...apps[1], loadError: 'Forbidden'}]
  await key('Y')
  assert.match(d.message, /apps are unavailable/)
  assert.equal(d.modal, null)
})

test('superseded workspace refreshes cannot overwrite newer data, status, or loading state', async t => {
  const {dashboard: d} = await harness(t, {context: {reason: 'Workspace'}})
  const catalog = {...d.catalog, warnings: []}
  const calls = []
  d.api.catalog = ({signal}) => {
    const pending = Promise.withResolvers()
    calls.push({signal, ...pending})
    return pending.promise
  }
  const first = d.reload()
  const second = d.reload()
  assert.equal(calls[0].signal.aborted, true)
  await first
  assert.equal(d.loading.has('catalog'), true)
  calls[1].resolve(catalog)
  await second
  assert.equal(d.catalog, catalog)
  assert.equal(d.message, 'Workspace refreshed.')
  assert.equal(d.messageTone, 'success')
  calls[0].reject(new Error('Obsolete refresh failure'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(d.message, 'Workspace refreshed.')
  assert.equal(d.loadingTimer, null)
})

test('workspace reads are canceled on navigation and shutdown and their late results are ignored', async t => {
  const {dashboard: d} = await harness(t, {context: {reason: 'Workspace'}})
  const catalog = d.catalog
  const pending = Promise.withResolvers()
  let signal
  d.api.catalog = options => { signal = options.signal; return pending.promise }
  const loading = d.reload()
  await d.openPipeline(catalog.pipelines[0])
  assert.equal(signal.aborted, true)
  await loading
  const message = d.message
  pending.resolve({...catalog, pipelines: []})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(d.catalog, catalog)
  assert.equal(d.message, message)
  await d.back()
  const closed = Promise.withResolvers()
  d.api.catalog = options => { signal = options.signal; return closed.promise }
  const refreshing = d.reload()
  d.close()
  const lastMessage = d.message
  d.setStatus = () => assert.fail('Closed dashboards must not receive read statuses')
  assert.equal(signal.aborted, true)
  await refreshing
  closed.reject(new Error('Late failure after close'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(d.message, lastMessage)
  assert.equal(d.loadingTimer, null)
})

test('navigation cancels pipeline and app reads without replacing the newer app view', async t => {
  const {dashboard: d} = await harness(t)
  const pendingPipeline = Promise.withResolvers()
  let pipelineSignal
  d.api.pipelineApps = (_id, {signal}) => { pipelineSignal = signal; return pendingPipeline.promise }
  const oldPipeline = d.openPipeline(d.pipeline)
  await d.openApp(d.catalog.apps[0])
  assert.equal(pipelineSignal.aborted, true)
  await oldPipeline
  assert.equal(d.app.id, d.catalog.apps[0].id)
  pendingPipeline.reject(new Error('Late pipeline failure'))
  const appData = d.api.appData.bind(d.api)
  const pendingApp = Promise.withResolvers()
  let appSignal
  d.api.appData = (id, {signal}) => {
    if (id !== d.catalog.apps[0].id) return appData(id)
    appSignal = signal
    return pendingApp.promise
  }
  const oldApp = d.openApp(d.catalog.apps[0])
  await d.openApp(d.catalog.apps[1])
  assert.equal(appSignal.aborted, true)
  await oldApp
  const message = d.message
  pendingApp.reject(new Error('Late app failure'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(d.app.id, d.catalog.apps[1].id)
  assert.equal(d.message, message)
  assert.equal(d.busy, false)
})

test('an obsolete app refresh cannot start a config read in the newly selected app', async t => {
  const {dashboard: d} = await harness(t)
  await d.openApp(d.catalog.apps[0])
  d.tab = 3
  const appData = d.api.appData.bind(d.api)
  const nextData = await appData(d.catalog.apps[1].id)
  const old = Promise.withResolvers()
  const next = Promise.withResolvers()
  const configCalls = []
  d.api.appData = id => id === d.catalog.apps[0].id ? old.promise : next.promise
  d.api.config = async id => { configCalls.push(id); return {CURRENT: id} }
  const refreshing = d.reload()
  const opening = d.openApp(d.catalog.apps[1])
  await refreshing
  // The new app starts its own Config read immediately; the canceled refresh
  // must not start a second one in the new context.
  assert.deepEqual(configCalls, [d.catalog.apps[1].id])
  next.resolve(nextData)
  await opening
  assert.deepEqual(configCalls, [d.catalog.apps[1].id])
  old.reject(new Error('Old refresh failed'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(d.config, {CURRENT: d.catalog.apps[1].id})
})

test('config reads cancel superseded work and never redraw or report failures after shutdown', async t => {
  const {dashboard: d} = await harness(t)
  await d.openApp(d.catalog.apps[0])
  d.tab = 3
  const calls = []
  d.api.config = (_id, {signal}) => {
    const pending = Promise.withResolvers()
    calls.push({signal, ...pending})
    return pending.promise
  }
  const first = d.loadConfig()
  const second = d.loadConfig()
  assert.equal(calls[0].signal.aborted, true)
  await first
  assert.equal(d.loading.has('config'), true)
  calls[1].resolve({LATEST: 'new-value'})
  await second
  calls[0].reject(new Error('Old config failure'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(d.config, {LATEST: 'new-value'})
  assert.equal(d.configError, null)
  const third = d.loadConfig()
  d.close()
  d.drawApp = () => assert.fail('Closed dashboards must not redraw')
  assert.equal(calls[2].signal.aborted, true)
  await third
  calls[2].reject(new Error('Config failed after shutdown'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(d.config, null)
  assert.equal(d.configError, null)
})

test('resource reads cancel on replacement, app navigation, and shutdown without stale errors', async t => {
  const calls = []
  const load = kind => (_data, {signal}) => {
    const pending = Promise.withResolvers()
    calls.push({kind, signal, ...pending})
    return pending.promise
  }
  const {dashboard: d} = await harness(t, {resources: {available: true, dynos: load('dynos'), addons: load('addons')}})
  await d.openApp(d.catalog.apps[0])
  d.changeTab(1)
  const replacement = d.loadResourceDetails({force: true})
  assert.equal(calls[0].signal.aborted, true)
  calls[1].resolve({formations: {}, instances: {}})
  await replacement
  calls[0].reject(new Error('Old resource failure'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(d.resourceErrors.dynos, undefined)
  const oldApp = d.loadResourceDetails({force: true})
  await d.openApp(d.catalog.apps[1])
  assert.equal(calls[2].signal.aborted, true)
  await oldApp
  d.changeTab(2)
  assert.equal(calls[3].kind, 'dynos')
  assert.equal(calls[4].kind, 'addons')
  d.close()
  assert.ok(calls.slice(2).every(call => call.signal.aborted))
  for (const call of calls.slice(2)) call.reject(new Error('Resource failed after cancellation'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(d.resourceErrors, {})
  assert.equal(d.loadingTimer, null)
})

test('closing during action preparation cancels reads and cannot start a write', async t => {
  for (const action of ['add', 'promote', 'clone']) {
    const demo = createDemo()
    demo.api.readOnly = false
    demo.api.config = async () => ({})
    const {dashboard: d} = await harness(t, {...demo, demo: false})
    if (action === 'clone') {
      await d.openApp(d.catalog.apps[0])
      d.tab = 3
      await d.loadConfig()
    }
    const pending = Promise.withResolvers()
    let signal
    if (action === 'add') d.api.appRegions = options => { signal = options.signal; return pending.promise }
    else d.api.pipelineApps = (_id, options) => { signal = options.signal; return pending.promise }
    d.api.createPipelineApp = d.api.promotePipelineApp = d.api.clonePipelineConfig = async () => assert.fail('Canceled preparation cannot write')
    const preparing = action === 'add' ? d.addApp() : action === 'promote' ? d.promoteApp() : d.cloneConfigFromApp()
    assert.ok(d.modal)
    d.close()
    const message = d.message
    assert.equal(signal.aborted, true)
    await preparing
    pending.reject(new Error('Preparation failed after closing'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(d.message, message)
    assert.equal(d.modal, null)
  }
})

test('o in Add-ons opens the selected datastore, third-party SSO, or shared attachment dashboard', async t => {
  const demo = createDemo()
  const original = demo.api.appData.bind(demo.api)
  const addons = [
    {id: 'postgres-id', name: 'postgres-app', web_url: 'https://addons-sso.heroku.com/apps/app-staging/addons/postgres-id', addon_service: {name: 'heroku-postgresql'}},
    {id: 'provider-id', name: 'provider-app', web_url: 'https://addons-sso.heroku.com/apps/app-staging/addons/provider-id', addon_service: {name: 'papertrail'}},
    {id: 'redis-id', name: 'redis-app', web_url: 'https://addons-sso.heroku.com/apps/app-staging/addons/redis-id', addon_service: {name: 'heroku-redis'}},
  ]
  const sharedUrl = 'https://addons-sso.heroku.com/apps/app-staging/attachments/shared-attachment'
  demo.api.appData = async id => ({...await original(id), addons, attachments: [
    {id: 'shared-attachment', name: 'SHARED_DATABASE', addon: {id: 'shared-id', addon_service: {name: 'third-party-service'}}, web_url: sharedUrl},
  ]})
  const opened = []
  const {dashboard: d, key} = await harness(t, {...demo, openURL: async url => { opened.push(url) }})
  await key('\r')
  await key('3')
  assert.equal(d.api.readOnly, true)
  for (const [id, expected] of [
    ['postgres-id', 'https://dashboard.heroku.com/apps/constellation-staging/datastores/postgres-id'],
    ['provider-id', addons[1].web_url],
    ['redis-id', 'https://dashboard.heroku.com/apps/constellation-staging/datastores/redis-id'],
    ['shared-id', sharedUrl],
  ]) {
    d.main.select(d.rows.findIndex(row => row.value?.id === id))
    await key('o')
    assert.equal(opened.at(-1), expected)
    assert.match(d.message, /management dashboard in your browser/)
  }
  assert.equal(opened.length, 4)
  assert.equal(d.openingBrowser, false)
  assert.equal(d.loadingTimer, null)
})

test('o ignores late add-on link lookups after selection or view changes and suppresses repeated opens', async t => {
  const demo = createDemo()
  const original = demo.api.appData.bind(demo.api)
  demo.api.appData = async id => ({...await original(id), addons: [{id: 'first', name: 'first'}, {id: 'second', name: 'second'}], attachments: []})
  const pending = Promise.withResolvers()
  let requests = 0
  demo.api.addonDashboardUrl = async () => { requests++; return pending.promise }
  const opened = []
  const {dashboard: d, key} = await harness(t, {...demo, openURL: async url => { opened.push(url) }})
  await key('\r')
  await key('3')
  await key('o')
  await key('o')
  assert.equal(requests, 1)
  await key('j')
  pending.resolve('https://provider.example.com/first')
  await delay(20)
  assert.deepEqual(opened, [])
  assert.equal(d.openingBrowser, false)
  const next = Promise.withResolvers()
  d.api.addonDashboardUrl = async () => next.promise
  await key('o')
  await key('1')
  next.resolve('https://provider.example.com/second')
  await delay(20)
  assert.deepEqual(opened, [])
})

test('o reports unavailable add-on links and browser errors without opening a generic app page', async t => {
  const demo = createDemo()
  const original = demo.api.appData.bind(demo.api)
  demo.api.appData = async id => ({...await original(id), addons: [{id: 'addon', name: 'selected-addon'}], errors: {addons: 'Add-ons unavailable'}})
  demo.api.addonDashboardUrl = async () => { throw new Error('Provider dashboard unavailable') }
  const opened = []
  const {dashboard: d, key} = await harness(t, {...demo, openURL: async url => { opened.push(url); throw new Error('Browser launcher unavailable') }})
  await key('\r')
  await key('3')
  await key('o')
  assert.match(d.message, /Select an add-on/)
  d.main.select(d.rows.findIndex(row => row.kind === 'addon'))
  await key('o')
  assert.match(d.message, /Provider dashboard unavailable/)
  assert.deepEqual(opened, [])
  d.api.addonDashboardUrl = async () => 'https://provider.example.com/manage'
  await key('o')
  assert.match(d.message, /Browser launcher unavailable/)
  assert.equal(opened.length, 1)
  assert.equal(d.openingBrowser, false)
  assert.equal(d.loadingTimer, null)
})

test('o in Metrics opens the selected process metrics, with app-wide rows using the generic page', async t => {
  const opened = []
  const {dashboard: d, key} = await harness(t, {openURL: async url => { opened.push(url) }})
  await key('\r')
  await key('7')
  assert.equal(d.api.readOnly, true)
  const cases = [
    ['telemetry:memory:web', 'metrics/web'],
    ['telemetry:memory:worker', 'metrics/worker'],
    ['telemetry:load:web', 'metrics/web'],
    ['telemetry:load:worker', 'metrics/worker'],
    ['health:web', 'metrics/web'],
    ['health:worker', 'metrics/worker'],
    ['telemetry:throughput', 'metrics'],
    ['telemetry:latency:p50', 'metrics'],
    ['telemetry:latency:p95', 'metrics'],
    ['telemetry:latency:p99', 'metrics'],
    ['health', 'metrics'],
    ['releases', 'metrics'],
    ['snapshot', 'metrics'],
  ]
  for (const [id, path] of cases) {
    const index = d.rows.findIndex(row => row.id === id)
    assert.ok(index >= 0, `Metrics row ${id} must be available`)
    d.main.select(index)
    await key('o')
    assert.equal(opened.at(-1), `https://dashboard.heroku.com/apps/constellation-staging/${path}`)
  }
  assert.equal(opened.length, cases.length)
  assert.equal(d.openingBrowser, false)
  assert.equal(d.loadingTimer, null)
})

test('o retains app and pipeline browser navigation and is disabled in the offline demo', async t => {
  const opened = []
  const {dashboard: d, key} = await harness(t, {openURL: async url => { opened.push(url) }})
  await key('o')
  assert.equal(opened.at(-1), 'https://dashboard.heroku.com/pipelines/pipeline-demo')
  await key('\r')
  await key('5')
  await key('o')
  assert.equal(opened.at(-1), 'https://dashboard.heroku.com/apps/constellation-staging/settings')
  d.demo = true
  await key('o')
  assert.match(d.message, /disabled in the offline demo/)
  assert.equal(opened.length, 2)
})

test('exact-app confirmation instructions remain visible when long descriptions scroll and the terminal resizes', async t => {
  const {dashboard: d, screen, key} = await harness(t)
  await key('\r')
  const app = d.app
  const confirmation = d.confirm(app, Array.from({length: 40}, (_, index) => `Change ${index}: ${'Long description '.repeat(8)}`).join('\n'))
  await delay(15)
  const description = d.modal.children.find(child => child.scrollable)
  const instructions = d.modal.children.find(child => clean(child.content).includes('Type the exact app name'))
  const input = d.modal.children.find(child => child.type === 'textbox')
  assert.equal(instructions.scrollable, undefined)
  assert.ok(!description.content.includes('Type the exact app name'))
  for (const [width, height] of [[140, 45], [80, 24]]) {
    screen.program.cols = width
    screen.program.rows = height
    screen.program.emit('resize')
    for (const scroll of [0, 1000]) {
      description.setScroll(scroll)
      d.render()
      const visible = screen.lines.map(line => line.map(cell => cell[1]).join('')).join('\n')
      assert.ok(visible.includes(`Target: ${app.name}`))
      assert.ok(visible.includes('Type the exact app name above to apply this change.'))
      assert.ok(instructions.lpos.yl <= input.lpos.yi)
      assert.ok(input.lpos.yl <= d.modal.lpos.yl)
    }
  }
  await key(app.name)
  await key('\r')
  assert.equal(await confirmation, app.name)
})

test('Ctrl-N and Ctrl-P move lists and scroll focused panes without changing context', async t => {
  const {dashboard: d, key} = await harness(t)
  const pipeline = d.pipeline
  const selected = d.main.selected
  await key('\x0e')
  assert.equal(d.main.selected, selected + 1)
  await key('\x10')
  assert.equal(d.main.selected, selected)
  assert.equal(d.pipeline, pipeline)
  assert.equal(d.app, null)
  await key('a')
  assert.equal(d.screen.focused, d.nav)
  const navSelected = d.nav.selected
  await key('\x0e')
  assert.equal(d.nav.selected, navSelected + 1)
  await key('\x10')
  assert.equal(d.nav.selected, navSelected)
  d.detail.setContent(Array.from({length: 80}, (_, index) => `Line ${index}`).join('\n'))
  d.detail.setScroll(0)
  d.detail.focus()
  d.render()
  await key('\x0e')
  assert.equal(d.detail.childBase, 1)
  await key('\x10')
  assert.equal(d.detail.childBase, 0)
  await key('?')
  await key('\x0e')
  assert.equal(d.modal.getScroll(), 1)
  await key('\x10')
  assert.equal(d.modal.getScroll(), 0)
  await key('q')
})

test('Shift-A creates an app in the pipeline with chosen stage and region after exact-name confirmation', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const writes = []
  const apps = await demo.api.pipelineApps()
  demo.api.appRegions = async () => [{name: 'eu', description: 'Europe'}, {name: 'us', description: 'United States'}]
  demo.api.pipelineApps = async () => apps
  demo.api.createPipelineApp = async (options, confirmation) => {
    writes.push({options, confirmation})
    const app = {id: 'new-app-id', name: options.name, stage: options.stage, region: {name: options.region}, team: demo.catalog.teams[0]}
    apps.push(app)
    return app
  }
  const {dashboard: d, key} = await harness(t, {...demo, demo: false})
  await key('A')
  assert.match(d.modal._label.content, /Add App.*Stage/)
  assert.deepEqual(d.modal.children.find(child => child.type === 'list').items.map(item => item.content), ['development', 'staging', 'production'])
  await key('\x0e')
  await key('\r')
  assert.match(d.modal._label.content, /Name/)
  await key('new-service-app')
  await key('\r')
  assert.match(d.modal._label.content, /Region/)
  await key('\x10')
  await key('\r')
  assert.match(d.modal._label.content, /Confirm remote change/)
  assert.match(d.modal.children.map(child => clean(child.content)).join('\n'), /production.*\nRegion: eu · Owner: acme/)
  assert.equal(writes.length, 0)
  await key('new-service-app')
  await key('\r')
  assert.deepEqual(writes, [{options: {pipeline: demo.context.pipeline, stage: 'production', name: 'new-service-app', region: 'eu'}, confirmation: 'new-service-app'}])
  assert.equal(d.app, null)
  assert.equal(d.rows[d.main.selected].value.name, 'new-service-app')
  assert.ok(d.catalog.apps.some(app => app.name === 'new-service-app'))
  assert.match(d.message, /Created new-service-app/)
  assert.equal(d.modal, null)
})

test('Add App is pipeline-only, respects read-only/demo modes, and supports cancellation and validation', async t => {
  let writes = 0
  const {dashboard: d, key} = await harness(t)
  d.api.appRegions = async () => [{name: 'us'}]
  d.api.createPipelineApp = async () => { writes++; assert.fail('Unconfirmed creation') }
  await key('A')
  assert.match(d.message, /Read-only/)
  d.api.readOnly = false
  d.demo = true
  await key('A')
  assert.match(d.message, /offline demo/)
  d.demo = false
  await key('A')
  await key('\x1b')
  assert.equal(d.modal, null)
  await key('A')
  await key('\r')
  await key('Bad name')
  await key('\r')
  assert.match(d.message, /App names/)
  await key('A')
  await key('\r')
  await key('valid-name')
  await key('\r')
  await key('\r')
  await key('wrong-name')
  await key('\r')
  assert.match(d.message, /did not match/)
  await key('\r')
  const app = d.app
  await key('A')
  assert.equal(d.app, app)
  assert.equal(d.modal, null)
  assert.equal(writes, 0)
})

test('Add App reports region lookup and partial creation errors without leaving the UI locked', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  demo.api.appRegions = async () => { throw new Error('Regions unavailable') }
  const {dashboard: d, key} = await harness(t, {...demo, demo: false})
  await key('A')
  assert.match(d.message, /Regions unavailable/)
  assert.equal(d.busy, false)
  assert.equal(d.modal, null)
  d.api.appRegions = async () => [{name: 'us'}]
  d.api.createPipelineApp = async () => { throw Object.assign(new Error('App partial-app was created, but attachment failed'), {createdApp: {id: 'partial-id', name: 'partial-app'}}) }
  await key('A')
  await key('\r')
  await key('partial-app')
  await key('\r')
  await key('\r')
  await key('partial-app')
  await key('\r')
  assert.match(d.message, /was created, but attachment failed/)
  assert.ok(d.catalog.apps.some(app => app.id === 'partial-id'))
  assert.equal(d.busy, false)
  assert.equal(d.modal, null)
})

test('Add App locks its pipeline target during creation and handles refresh failures', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const creation = Promise.withResolvers()
  demo.api.appRegions = async () => [{name: 'us'}]
  demo.api.createPipelineApp = async () => creation.promise
  const {dashboard: d, key} = await harness(t, {...demo, demo: false})
  await key('A')
  await key('\r')
  await key('locked-app')
  await key('\r')
  await key('\r')
  await key('locked-app')
  await key('\r')
  assert.equal(d.busy, true)
  assert.ok(d.modal)
  await key('a')
  await key('\r')
  assert.equal(d.app, null)
  assert.equal(d.pipeline.id, demo.context.pipeline.id)
  d.api.pipelineApps = async () => { throw new Error('Refresh failed') }
  creation.resolve({id: 'locked-id', name: 'locked-app', stage: 'staging'})
  await delay(20)
  assert.match(d.message, /Created locked-app.*could not be refreshed/)
  assert.equal(d.messageTone, 'warning')
  assert.equal(d.busy, false)
  assert.equal(d.modal, null)
  assert.ok(d.catalog.apps.some(app => app.id === 'locked-id'))
})

for (const appContext of [false, true]) test(`Shift-P promotes from ${appContext ? 'an app view' : 'the pipeline workspace'} and tracks destinations`, async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const writes = []
  const apps = await demo.api.pipelineApps()
  const completion = Promise.withResolvers()
  let signal
  demo.api.promotePipelineApp = async (options, confirmation) => { writes.push({options, confirmation}); return {id: 'promotion-id'} }
  demo.api.waitForPromotion = async (_promotion, targets, options) => {
    signal = options.signal
    options.onUpdate(targets.map(app => ({app: {id: app.id}, status: 'pending'})))
    await completion.promise
    return targets.map(app => ({app: {id: app.id}, status: 'succeeded'}))
  }
  const {dashboard: d, key} = await harness(t, {...demo, demo: false})
  if (appContext) await key('\r')
  assert.match(clean(d.footer.content), /P promote/)
  await key('P')
  assert.match(d.modal._label.content, /Promote.*constellation-staging/)
  assert.deepEqual(d.modal.children.find(child => child.type === 'list').items.map(item => item.content), ['production · constellation-production'])
  await key('\r')
  assert.match(d.modal.children.map(child => clean(child.content)).join('\n'), /Destinations: constellation-production/)
  assert.equal(writes.length, 0)
  await key('constellation-staging')
  await key('\r')
  assert.deepEqual(writes, [{options: {pipeline: demo.context.pipeline, source: apps[0], stage: 'production', targets: [apps[1]]}, confirmation: 'constellation-staging'}])
  assert.match(clean(d.modal.content), /constellation-production: pending/)
  assert.equal(d.busy, true)
  await key('a')
  assert.equal(Boolean(d.app), appContext)
  completion.resolve()
  await delay(20)
  assert.match(d.message, /Promoted constellation-staging to production/)
  assert.equal(d.messageTone, 'success')
  assert.equal(d.modal, null)
  assert.equal(d.busy, false)
  assert.equal(signal.aborted, false)
  if (appContext) assert.equal(d.app.name, 'constellation-staging')
  else assert.equal(d.rows[d.main.selected].value.name, 'constellation-staging')
})

test('promotion rejects read-only/demo modes, cancellation, wrong confirmation, and missing higher stages', async t => {
  let writes = 0
  const {dashboard: d, key} = await harness(t)
  d.api.promotePipelineApp = async () => { writes++; assert.fail('Unconfirmed promotion') }
  await key('P')
  assert.match(d.message, /Read-only/)
  d.api.readOnly = false
  d.demo = true
  await key('P')
  assert.match(d.message, /offline demo/)
  d.demo = false
  await key('P')
  await key('\x1b')
  assert.equal(d.modal, null)
  await key('P')
  await key('\r')
  await key('wrong-app')
  await key('\r')
  assert.match(d.message, /did not match/)
  await key('\x0e')
  await key('P')
  assert.match(d.message, /no higher stage/)
  await key('\x10')
  d.api.pipelineApps = async () => [{id: 'app-staging', name: 'constellation-staging', stage: 'staging'}]
  await key('P')
  assert.match(d.message, /no apps in a higher stage/)
  assert.equal(writes, 0)
})

test('promotion reports partial deployment failure and stops local polling on close', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  demo.api.promotePipelineApp = async () => ({id: 'promotion-id'})
  demo.api.waitForPromotion = async () => [{app: {id: 'app-production'}, status: 'failed', error_message: 'Release phase failed'}]
  const {dashboard: d, key} = await harness(t, {...demo, demo: false})
  await key('P')
  await key('\r')
  await key('constellation-staging')
  await key('\r')
  assert.match(d.message, /constellation-production: Release phase failed/)
  assert.equal(d.messageTone, 'error')
  assert.equal(d.modal, null)
  let signal
  d.api.waitForPromotion = async (_promotion, _targets, options) => {
    signal = options.signal
    await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}))
    signal.throwIfAborted()
  }
  await key('P')
  await key('\r')
  await key('constellation-staging')
  await key('\r')
  d.close()
  await delay(20)
  assert.equal(signal.aborted, true)
  assert.equal(d.closed, true)
  assert.equal(d.promotionRequest, null)
})

test('automatic refresh waits while the terminal is unfocused and catches up once on focus', async t => {
  t.mock.timers.enable({apis: ['setInterval']})
  const {dashboard: d, screen, key} = await harness(t, {refresh: 10})
  await key('\r')
  let refreshes = 0
  d.loadApp = async automatic => { if (automatic) refreshes++ }

  screen.program.emit('blur')
  t.mock.timers.tick(20_000)
  assert.equal(refreshes, 0)
  assert.equal(d.refreshPending, true)

  screen.program.emit('focus')
  assert.equal(refreshes, 1)
  assert.equal(d.refreshPending, false)
  screen.program.emit('focus')
  assert.equal(refreshes, 1)

  t.mock.timers.tick(10_000)
  assert.equal(refreshes, 2)
})

test('clicking tab numbers, icons, and labels switches views in full and compact layouts', async t => {
  const {dashboard: d, screen, key, click} = await harness(t)
  await key('\r')
  for (const width of [160, 80, 120, 160]) {
    screen.program.cols = width
    screen.program.emit('resize')
    d.render()
    for (const index of [1, 2, 3, 4, 5, 6, 0]) {
      await key('a') // Clicking a tab must transfer focus from the sidebar.
      const offset = width === 160 ? (index % 3) * 2 : (index % 2) * 2
      await click(...tabCell(d, screen, index, offset))
      assert.equal(d.tab, index)
      assert.equal(screen.focused, d.main)
      assert.ok(d.main._label.content.includes(TABS[index]))
      assert.ok(d.rows.length)
      if (index === 3) assert.ok(d.config, 'Mouse activation loads config vars')
      if (index === 6) assert.equal(d.telemetry.appId, d.app.id, 'Mouse activation loads metrics')
    }
  }
})

test('active tab clicks preserve selection and revealed values; tab gaps and non-left clicks are ignored', async t => {
  const {dashboard: d, screen, key, click} = await harness(t)
  await key('\r')
  await key('4')
  await key('v')
  await key('j')
  const selected = d.main.selected
  const revealed = [...d.revealed]
  await key('a')
  await click(...tabCell(d, screen, 3))
  assert.equal(screen.focused, d.main)
  await click(...tabCell(d, screen, 3))
  assert.equal(d.main.selected, selected)
  assert.deepEqual([...d.revealed], revealed)

  await key('a')
  const {xi, xl, yi, yl} = d.tabs.lpos
  const [x, y] = tabCell(d, screen, 0)
  const [next] = tabCell(d, screen, 1)
  for (const args of [[xi, y], [xi + 1, y], [x, yi], [x, yl - 1], [xl - 1, y], [xl - 2, y], [next - 1, y], [x, y, 'right'], [x, y, 'middle']]) {
    await click(...args)
    assert.equal(d.tab, 3)
    assert.equal(screen.focused, d.nav)
    assert.equal(d.main.selected, selected)
    assert.deepEqual([...d.revealed], revealed)
  }
})

test('tab clicks are inactive in the workspace, during prompts, and below the minimum terminal size', async t => {
  const {dashboard: d, screen, key, click} = await harness(t)
  await click(d.tabs.lpos.xi + d.tabs.ileft + 4, d.tabs.lpos.yi + d.tabs.itop)
  assert.equal(d.app, null)
  assert.equal(d.tab, 0)
  await key('\r')
  const target = tabCell(d, screen, 3)
  await key('/')
  const prompt = d.modal
  const input = screen.focused
  await click(...target)
  assert.equal(d.tab, 0)
  assert.equal(d.modal, prompt)
  assert.equal(screen.focused, input)
  await key('\x1b')

  screen.program.cols = 80
  screen.program.emit('resize')
  d.render()
  const compactTarget = tabCell(d, screen, 3)
  const left = d.tabs.lpos.xi
  screen.program.cols = 70
  screen.program.emit('resize')
  d.render()
  assert.equal(d.small.visible, true)
  await click(compactTarget[0] + d.tabs.lpos.xi - left, compactTarget[1])
  assert.equal(d.tab, 0)
  screen.program.cols = 140
  screen.program.emit('resize')
  d.render()
  await click(...tabCell(d, screen, 3))
  assert.equal(d.tab, 3)
})

for (const theme of ['dark', 'light']) test(`${theme} selection highlights follow keyboard and mouse focus with one purple marker`, async t => {
  const {dashboard: d, screen, key, click} = await harness(t, {theme})
  const assertSelections = focused => {
    for (const list of [d.nav, d.main]) {
      const active = list === focused
      const {xi, yi} = list.items[list.selected].lpos
      const [attr] = screen.lines[yi][xi + 4]
      assert.equal((attr >> 9) & 0x1ff, blessed.colors.convert(active ? palette.selectedFg : palette.selectedInactiveFg))
      assert.equal(attr & 0x1ff, blessed.colors.convert(active ? palette.selected : palette.selectedInactive))
      const [markerAttr, marker] = screen.lines[yi][xi]
      assert.equal(marker, active ? '▎' : ' ')
      if (active) assert.equal((markerAttr >> 9) & 0x1ff, blessed.colors.convert(palette.selectionMarker))
    }
    assert.equal(screen.lines.flat().filter(cell => cell[1] === '▎').length, focused ? 1 : 0)
  }
  assertSelections(d.main)
  await key('\t')
  assert.equal(screen.focused, d.detail)
  assertSelections(null)
  await key('\t')
  assertSelections(d.nav)

  const app = d.rows[1].value
  const {xi, yi} = d.main.items[1].lpos
  await click(xi + 4, yi)
  assert.equal(d.main.selected, 1)
  assertSelections(d.main)
  // The decorative marker must let clicks reach the selected app row.
  await click(xi, yi)
  assert.equal(d.app.id, app.id)
  assertSelections(d.main)
})

for (const theme of ['dark', 'light']) test(`${theme} inline keybindings stay purple across panes, selections, and help`, async t => {
  const {dashboard: d, screen, key} = await harness(t, {theme})
  const assertKey = (widget, context, key, tone = 'accent') => {
    const {xi, xl, yi, yl} = widget.lpos
    for (let y = Math.max(0, yi); y < Math.min(yl, screen.height); y++) {
      const cells = screen.lines[y].slice(xi, xl)
      const text = cells.map(cell => cell[1]).join('')
      const start = text.indexOf(context)
      if (start < 0) continue
      const offset = start + context.indexOf(key)
      for (let index = 0; index < key.length; index++) {
        assert.equal((cells[offset + index][0] >> 9) & 0x1ff, blessed.colors.convert(palette[tone]), `${context}: ${key}`)
      }
      return cells[offset][0]
    }
    assert.fail(`Expected visible shortcut: ${context}`)
  }
  assertKey(d.status, 'press Enter', 'Enter')
  assertKey(d.status, 'press A', 'A')
  assertKey(d.detail, 'P to promote', 'P')
  await key('\r')
  for (let index = 0; index < TABS.length; index++) {
    const [x, y] = tabCell(d, screen, index)
    assert.equal((screen.lines[y][x][0] >> 9) & 0x1ff, blessed.colors.convert(palette.accent))
  }
  await key('2')
  d.main.select(d.rows.findIndex(row => row.kind === 'formation'))
  d.render()
  const selected = d.main.items[d.main.selected]
  assert.equal(assertKey(selected, '[s/x/r]', 's/x/r') & 0x1ff, blessed.colors.convert(palette.selected))
  for (const key of ['s', 'x', 'r']) assertKey(d.detail, `[${key}]`, key)
  await key('\t')
  assert.equal(assertKey(selected, '[s/x/r]', 's/x/r') & 0x1ff, blessed.colors.convert(palette.selectedInactive))
  const dyno = d.main.items[d.rows.findIndex(row => row.kind === 'dyno')]
  assertKey(dyno, '[r]', 'r')
  await key('3')
  assertKey(d.detail, '[o]', 'o')
  await key('4')
  for (const key of ['y', 'v', 'e', 'n', 'x']) assertKey(d.detail, `[${key}]`, key)
  await key('5')
  assertKey(d.detail, 'Press m', 'm')
  assertKey(d.main.items[0], '[m] toggle', 'm')
  await key('7')
  assertKey(d.main._label, '[T] timeframe', 'T')
  d.api.readOnly = false
  await key(':')
  await key('logs')
  await key('\r')
  const proceed = d.modal.children.find(child => clean(child.content) === 'Continue (y)')
  const cancel = d.modal.children.find(child => clean(child.content) === 'Cancel (n)')
  assertKey(proceed, 'Continue (y)', 'y')
  assertKey(cancel, '(n)', 'n')
  await key('\x1b')
  await key('?')
  for (const keys of ['t / p / a', 'j / k, ↑ / ↓', 'Ctrl-N / Ctrl-P', 'Tab / Shift-Tab', '1–7', 'h / l, [ / ]', 'R / g']) {
    assertKey(d.modal, keys, keys)
  }
  d.modal.setScroll(15)
  d.render()
  assertKey(d.modal, 'Y (Config)', 'Y')
  assertKey(d.modal, 'T (Metrics)', 'T')
  d.modal.setScrollPerc(100)
  d.render()
  for (const key of ['Esc', '?', 'q']) assertKey(d.modal, 'Press Esc, ?, or q', key)
  await key('q')
  d.clearApp()
  d.pipeline = null
  d.drawLanding()
  d.render()
  assertKey(d.summary, 't / p / a', 't / p / a')
  assertKey(d.detail, 'j/k', 'j/k')
  assertKey(d.detail, '/ filters', '/')
  assertKey(d.detail, '? displays', '?')
})

test('light theme covers app views, config values, charts, and input prompts', async t => {
  const {dashboard: d, screen, key} = await harness(t, {theme: 'light'})
  assert.equal(d.theme, 'light')
  const background = blessed.colors.convert(palette.bg)
  for (const pane of [d.nav, d.main, d.summary, d.detail]) assert.equal(pane.style.bg, palette.bg)
  await key('\r')
  for (let tab = 1; tab <= 7; tab++) {
    await key(String(tab))
    const {xi, yi} = d.detail.lpos
    assert.equal(screen.lines[yi + d.detail.itop][xi + d.detail.ileft][0] & 0x1ff, background)
  }
  assert.ok(d.detail.content.includes(`\x1b[38;5;${blessed.colors.convert(palette.cyan)}m`), 'Charts use the light palette')
  await key('4')
  await key('v')
  assert.ok(d.detail.content.includes(`\x1b[38;5;${blessed.colors.convert(palette.cyan)}m`), 'Revealed values use readable teal')
  const unselected = d.main.items[1].lpos
  assert.equal(screen.lines[unselected.yi][unselected.xi][0] & 0x1ff, background, 'Unselected rows have an explicit light background')
  await key('/')
  assert.equal(d.modal.style.bg, palette.bg)
  const input = d.modal.children.find(child => child.type === 'textbox')
  assert.equal(input.style.bg, palette.bg)
  assert.equal(input.style.fg, palette.fg)
  await key('\x1b')
  await key('?')
  assert.equal(d.modal.style.bg, palette.bg)
  await key('q')
})

test('switching apps through the sidebar preserves every selected app tab', async t => {
  const {dashboard: d, key} = await harness(t)
  await key('\r')
  assert.equal(d.tab, 0)
  for (let tab = 0; tab < 7; tab++) {
    await key(String(tab + 1))
    const next = d.app.id === d.catalog.apps[0].id ? 1 : 0
    await key('a')
    await key(next ? 'j' : 'k')
    await key('\r')
    assert.equal(d.app.id, d.catalog.apps[next].id)
    assert.equal(d.tab, tab)
    assert.ok(d.rows.length)
    if (tab === 3) assert.ok(d.config, 'The new app config loads without reselecting Config')
    if (tab === 6) assert.equal(d.telemetry.appId, d.app.id)
  }
  await d.back()
  assert.equal(d.app, null)
  await key('\r')
  assert.equal(d.tab, 6, 'The remembered tab also survives a return through the pipeline')
})

test('preserving Config reloads the destination app, masks values, and ignores old config responses', async t => {
  const {dashboard: d, key, screen} = await harness(t)
  const oldConfig = Promise.withResolvers()
  const newConfig = Promise.withResolvers()
  const calls = []
  d.api.config = async id => {
    calls.push(id)
    if (calls.length === 1) return {TOKEN: 'app-a-secret'}
    return id === 'app-staging' ? oldConfig.promise : newConfig.promise
  }
  await key('\r')
  await key('4')
  await key('v')
  assert.ok(d.detail.content.includes('app-a-secret'))
  const oldLoading = d.loadConfig()
  const opening = d.openApp(d.catalog.apps[1])
  await delay(15)
  assert.equal(d.tab, 3)
  assert.equal(d.config, null)
  assert.equal(d.revealed.size, 0)
  assert.deepEqual(calls, ['app-staging', 'app-staging', 'app-production'])
  const visible = () => screen.lines.map(line => line.map(cell => cell[1]).join('')).join('\n')
  assert.ok(!visible().includes('app-a-secret'))
  oldConfig.resolve({TOKEN: 'late-app-a-secret'})
  await oldLoading
  assert.equal(d.config, null)
  assert.ok(d.loading.has('config'))
  newConfig.resolve({TOKEN: 'app-b-secret'})
  await opening
  assert.equal(d.config.TOKEN, 'app-b-secret')
  assert.ok(!visible().includes('app-b-secret'))
  assert.ok(!visible().includes('late-app-a-secret'))
})

test('direct pipeline and app-sidebar navigation show full parent breadcrumbs', async t => {
  const {dashboard: d, key} = await harness(t)
  assert.deepEqual(breadcrumbs(d), ['acme', 'constellation'])
  assert.equal(d.team, null)
  await key('a')
  await key('\r')
  assert.deepEqual(breadcrumbs(d), ['acme', 'constellation', 'constellation-staging'])
  assert.equal(d.team, null)
  await d.back()
  assert.deepEqual(breadcrumbs(d), ['acme', 'constellation'])
  assert.equal(d.rows[0].kind, 'app')
})

test('starting directly in an app resolves team and pipeline breadcrumbs', async t => {
  const demo = createDemo()
  const {dashboard: d} = await harness(t, {...demo, context: {app: demo.catalog.apps[1], reason: 'Direct app'}})
  assert.deepEqual(breadcrumbs(d), ['acme', 'constellation', 'constellation-production'])
})

test('resource breadcrumbs do not inherit or change the sidebar team filter', async t => {
  const demo = createDemo()
  const otherTeam = {id: 'other-team', name: 'other-team'}
  const otherPipeline = {id: 'other-pipeline', name: 'other-pipeline', owner: {type: 'team', id: otherTeam.id}}
  demo.catalog.teams.push(otherTeam)
  demo.catalog.pipelines.push(otherPipeline)
  const {dashboard: d} = await harness(t, {...demo, context: {team: demo.catalog.teams[0], reason: 'Team filter'}})
  await d.openPipeline(otherPipeline)
  assert.deepEqual(breadcrumbs(d), ['other-team', 'other-pipeline'])
  assert.equal(d.team.name, 'acme')
  const appData = d.api.appData
  d.api.appData = async id => ({...await appData(id), coupling: {pipeline: otherPipeline},
    app: {...demo.catalog.apps[1], team: otherTeam},
  })
  await d.openApp(demo.catalog.apps[1])
  assert.deepEqual(breadcrumbs(d), ['other-team', 'other-pipeline', 'constellation-production'])
  assert.equal(d.team.name, 'acme')
  d.api.appData = async id => ({...await appData(id), coupling: null, app: {...demo.catalog.apps[0], team: null}})
  await d.openApp(demo.catalog.apps[0])
  assert.deepEqual(breadcrumbs(d), ['Personal', 'No pipeline', 'constellation-staging'])
  assert.equal(d.pipeline, null)
  assert.equal(d.team.name, 'acme')
})

test('unavailable pipeline metadata does not prevent app views from loading', async t => {
  const {dashboard: d} = await harness(t)
  const appData = d.api.appData
  d.api.appData = async id => ({...await appData(id), coupling: null, errors: {coupling: 'Permission denied'}})
  await d.openApp(d.catalog.apps[0])
  assert.deepEqual(breadcrumbs(d), ['acme', 'Pipeline unavailable', 'constellation-staging'])
  assert.ok(d.data.formation.length)
  assert.equal(d.messageTone, 'warning')
})

test('slow parent lookup cannot replace breadcrumbs after navigating to another app', async t => {
  const {dashboard: d} = await harness(t)
  const appData = d.api.appData
  const lookupStarted = Promise.withResolvers()
  const lookup = Promise.withResolvers()
  d.api.get = async () => { lookupStarted.resolve(); return lookup.promise }
  d.api.appData = async id => {
    const data = await appData(id)
    return id === 'app-staging' ? {...data, app: {...data.app, team: null}, coupling: {pipeline: {id: 'old', name: 'old-pipeline'}}} : data
  }
  const first = d.openApp(d.catalog.apps[0])
  await lookupStarted.promise
  await d.openApp(d.catalog.apps[1])
  lookup.resolve({id: 'old', name: 'old-pipeline', owner: {type: 'user', id: 'user'}})
  await first
  assert.deepEqual(breadcrumbs(d), ['acme', 'constellation', 'constellation-production'])
})

test('config reveal persists across row navigation and is hidden on changing views', async t => {
  const {dashboard: d, key} = await harness(t)
  await key('\r')
  await key('4')
  assert.equal(d.config.EXAMPLE_SECRET, 'demo-only-value')
  assert.ok(!d.detail.content.includes('demo-only-value'))
  await key('v')
  assert.ok(d.revealed.has('EXAMPLE_SECRET'))
  assert.ok(d.detail.content.includes('demo-only-value'))
  await key('j')
  assert.ok(d.revealed.has('EXAMPLE_SECRET'))
  assert.ok(d.main.items[0].content.includes('demo-only-value'))
  assert.ok(!d.detail.content.includes('demo-only-value'))
  await key('1')
  await key('4')
  assert.equal(d.revealed.size, 0)
})

test('v repeatedly reveals and hides the same config row without changing selection', async t => {
  const {dashboard: d, screen, key} = await harness(t)
  const config = {FIRST: 'first-private-value', SECOND: 'second-private-value', THIRD: 'third-private-value'}
  d.api.config = async () => config
  await key('\r')
  await key('4')
  const visible = () => screen.lines.map(line => line.map(cell => cell[1]).join('')).join('\n')
  for (const [index, name] of Object.keys(config).entries()) {
    if (index) await key('j')
    for (let cycle = 0; cycle < 2; cycle++) {
      await key('v')
      assert.equal(d.main.selected, index)
      assert.deepEqual([...d.revealed], [name])
      assert.ok(d.main.items[index].content.includes(config[name]))
      assert.ok(d.detail.content.includes(config[name]))
      assert.ok(visible().includes(config[name]))
      await key('v')
      assert.equal(d.main.selected, index)
      assert.equal(d.revealed.size, 0)
      for (const value of Object.values(config)) {
        assert.ok(!d.main.items.some(item => item.content.includes(value)))
        assert.ok(!d.detail.content.includes(value))
        assert.ok(!visible().includes(value))
      }
    }
  }
})

test('config reveal and hide preserve a scrolled viewport and the selected row position', async t => {
  const {dashboard: d, screen, key} = await harness(t)
  const config = Object.fromEntries(Array.from({length: 60}, (_, i) => [`CONFIG_${String(i).padStart(2, '0')}`, `private-value-${i}`]))
  d.api.config = async () => config
  await key('\r')
  await key('4')
  const height = d.main.height - d.main.iheight
  await key('j'.repeat(height * 2))
  await key('k'.repeat(height - 1))
  const top = d.main.childBase
  assert.ok(top >= height, 'Start beyond the first viewport')

  for (const offset of [0, Math.floor(height / 2), height - 1]) {
    const index = top + offset
    await key('j'.repeat(index - d.main.selected))
    const name = d.rows[index].key
    const y = d.main.items[index].lpos.yi
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const revealed of [true, false]) {
        await key('v')
        assert.equal(d.main.selected, index)
        assert.equal(d.main.childBase, top, 'Toggling a value must not move the viewport')
        assert.equal(d.main.items[index].lpos.yi, y, 'The selected row must stay on the same screen line')
        const [markerAttr, marker] = screen.lines[y][d.main.items[index].lpos.xi]
        assert.equal(marker, '▎', 'The selection marker must follow the row after scrolling')
        assert.equal((markerAttr >> 9) & 0x1ff, blessed.colors.convert(palette.selectionMarker))
        assert.equal(d.revealed.has(name), revealed)
        assert.equal(d.main.items[index].content.includes(config[name]), revealed)
        assert.equal(d.detail.content.includes(config[name]), revealed)
      }
    }
  }
})

test('multiple config values can be revealed and hidden independently', async t => {
  const {dashboard: d, screen, key} = await harness(t)
  const config = {FIRST: 'first-private-value', SECOND: 'second-private-value', THIRD: 'third-private-value'}
  d.api.config = async () => config
  await key('\r')
  await key('4')
  const visible = () => screen.lines.map(line => line.map(cell => cell[1]).join('')).join('\n')
  await key('v')
  await key('j')
  await key('v')
  assert.ok(visible().includes(config.FIRST))
  assert.ok(visible().includes(config.SECOND))
  assert.ok(!visible().includes(config.THIRD))
  await key('j')
  assert.ok(visible().includes(config.FIRST))
  assert.ok(visible().includes(config.SECOND))
  await key('k')
  await key('v')
  assert.ok(visible().includes(config.FIRST))
  assert.ok(!visible().includes(config.SECOND))
  await d.loadApp(true)
  assert.ok(visible().includes(config.FIRST))
  assert.ok(!visible().includes(config.SECOND))
  await key('v')
  assert.ok(visible().includes(config.FIRST))
  assert.ok(visible().includes(config.SECOND))
  await d.reload()
  assert.equal(d.revealed.size, 0)
  for (const value of Object.values(config)) assert.ok(!visible().includes(value))
})

test('y copies exact config values while masked, revealed, or empty in read-only mode', async t => {
  const copies = []
  const {dashboard: d, screen, key} = await harness(t, {writeClipboard: async value => { copies.push(value) }})
  const value = `  secret-first-line\nUnicode: café 🔑\n${'long-value '.repeat(40)}\x1b[31m\n`
  d.api.config = async () => ({MULTILINE: value, ZEMPTY: ''})
  await key('\r')
  await key('4')
  assert.equal(d.api.readOnly, true)
  await key('y')
  assert.deepEqual(copies, [value])
  assert.equal(d.revealed.size, 0)
  assert.equal(d.message, 'Copied MULTILINE to clipboard.')
  const visible = screen.lines.map(line => line.map(cell => cell[1]).join('')).join('\n')
  assert.ok(!visible.includes('secret-first-line'))
  await key('v')
  await key('y')
  assert.ok(d.revealed.has('MULTILINE'))
  await key('j')
  await key('y')
  assert.deepEqual(copies, [value, value, ''])
  assert.equal(d.message, 'Copied ZEMPTY to clipboard.')
})

test('Shift-Y clones from a pipeline app into the empty current app and keeps its Config masked', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const configs = {
    'app-staging': {},
    'app-production': {SECRET_COPY: 'copied-secret-value', EMPTY: '', MULTILINE: ' first line\nsecond line ', HEROKU_APP_ID: 'app-production'},
  }
  const writes = []
  demo.api.config = async id => structuredClone(configs[id])
  demo.api.prepareConfigClone = async ({pipeline, source, destination}) => ({pipeline, source, destination,
    values: {SECRET_COPY: configs[source.id].SECRET_COPY, EMPTY: '', MULTILINE: configs[source.id].MULTILINE}, skippedCount: 1})
  demo.api.clonePipelineConfig = async (plan, confirmation) => {
    writes.push({plan, confirmation})
    Object.assign(configs[plan.destination.id], plan.values)
    return Object.keys(plan.values).length
  }
  const {dashboard: d, screen, key} = await harness(t, {...demo, demo: false})
  await key('\r')
  await key('4')
  await key('Y')
  const options = d.modal.children.find(child => child.type === 'list')
  assert.deepEqual(options.items.map(item => item.content), ['constellation-production · production'])
  await key('\r')
  const confirmation = clean(d.modal.children.map(child => child.content).join('\n'))
  assert.match(confirmation, /Clone 3 config vars: constellation-production → constellation-staging/)
  assert.match(confirmation, /current app must have no config vars/)
  assert.match(confirmation, /Target: constellation-staging/)
  assert.ok(!confirmation.includes('copied-secret-value'))
  assert.equal(writes.length, 0)
  await key('constellation-staging')
  await key('\r')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].confirmation, 'constellation-staging')
  assert.equal(writes[0].plan.source.id, 'app-production')
  assert.equal(writes[0].plan.destination.id, 'app-staging')
  assert.equal(d.app.name, 'constellation-staging')
  assert.equal(TABS[d.tab], 'Config')
  assert.equal(d.revealed.size, 0)
  assert.equal(d.config.SECRET_COPY, 'copied-secret-value')
  assert.ok(!screen.lines.map(line => line.map(cell => cell[1]).join('')).join('\n').includes('copied-secret-value'))
  assert.equal(configs['app-production'].HEROKU_APP_ID, 'app-production')
  assert.ok(!Object.hasOwn(d.config, 'HEROKU_APP_ID'))
  assert.match(d.message, /Cloned 3 config vars/)
})

test('config cloning respects modes, cancellation, empty source, and current-app confirmation', async t => {
  const {dashboard: d, key} = await harness(t)
  d.api.config = async () => ({})
  d.api.clonePipelineConfig = async () => assert.fail('Unconfirmed config clone')
  d.api.prepareConfigClone = async options => ({...options, values: {KEY: 'secret'}, skippedCount: 0})
  await key('\r')
  await key('4')
  await key('Y')
  assert.match(d.message, /Read-only/)
  d.api.readOnly = false
  d.demo = true
  await key('Y')
  assert.match(d.message, /offline demo/)
  d.demo = false
  await key('Y')
  await key('\x1b')
  assert.equal(d.modal, null)
  await key('Y')
  await key('\r')
  await key('constellation-production')
  await key('\r')
  assert.match(d.message, /did not match/)
  d.api.prepareConfigClone = async options => ({...options, values: {}, skippedCount: 2})
  await key('Y')
  await key('\r')
  assert.match(d.message, /no config vars to clone/)
  d.api.pipelineApps = async () => [d.app]
  await key('Y')
  assert.match(d.message, /no other apps/)
  d.pipeline = null
  await key('Y')
  assert.match(d.message, /Open an app in a pipeline/)
})

test('config clone failure leaves the current empty app open and values masked', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  demo.api.config = async () => ({})
  demo.api.prepareConfigClone = async options => ({...options, values: {SECRET_KEY: 'never-show-this'}, skippedCount: 0})
  demo.api.clonePipelineConfig = async () => { throw new Error('Permission denied') }
  const {dashboard: d, key} = await harness(t, {...demo, demo: false})
  await key('\r')
  await key('4')
  await key('Y')
  await key('\r')
  await key('constellation-staging')
  await key('\r')
  assert.equal(d.app.name, 'constellation-staging')
  assert.equal(d.modal, null)
  assert.equal(d.busy, false)
  assert.match(d.message, /Permission denied/)
  assert.ok(!d.message.includes('never-show-this'))
})

test('Shift-Y rejects any populated current app before showing a source picker', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const {dashboard: d, key} = await harness(t, {...demo, demo: false})
  await key('\r')
  await key('4')
  d.api.pipelineApps = async () => assert.fail('No source picker lookup for a populated app')
  d.api.clonePipelineConfig = async () => assert.fail('Existing config must never be overwritten')
  for (const config of [{EXISTING: 'value'}, {EMPTY: ''}, {HEROKU_APP_ID: d.app.id}]) {
    d.config = config
    d.drawApp()
    await key('Y')
    assert.match(d.message, /current app has no config vars/)
    assert.equal(d.modal, undefined)
    assert.equal(d.config, config)
  }
})

test('revealed detail values are cyan and only clicks on the value copy it', async t => {
  const copies = []
  const {dashboard: d, screen, key, click} = await harness(t, {writeClipboard: async value => { copies.push(value) }})
  d.api.config = async () => ({TOKEN: 'copy-this-value'})
  await key('\r')
  await key('4')
  const x = d.detail.lpos.xi + d.detail.ileft
  const top = d.detail.lpos.yi + d.detail.itop
  await click(x + 1, top + 2) // Hidden value.
  assert.deepEqual(copies, [])
  await key('v')
  assert.equal((screen.lines[top + 2][x][0] >> 9) & 0x1ff, blessed.colors.convert(palette.cyan))
  assert.notEqual((screen.lines[top][x][0] >> 9) & 0x1ff, blessed.colors.convert(palette.cyan))
  await click(x + 1, top + 2)
  assert.deepEqual(copies, ['copy-this-value'])
  assert.equal(d.message, 'Copied TOKEN to clipboard.')
  await click(x, top) // Variable name.
  await click(x, top + 1) // Blank separator.
  await click(x, top + 4) // Instructions.
  await click(x + 20, top + 2) // Space after the value.
  await click(x - 1, top + 2) // Padding.
  await click(d.detail.lpos.xi, top + 2) // Border.
  await click(x, top + 2, 'right')
  assert.equal(copies.length, 1)
  await key('v')
  await click(x, top + 2)
  assert.equal(copies.length, 1)
  await key('v')
  await key('?')
  await click(x, top + 2) // An open modal blocks copy actions.
  assert.equal(copies.length, 1)
})

test('clicking wrapped and scrolled config values copies the full original after resizing', async t => {
  const copies = []
  const {dashboard: d, screen, key, click} = await harness(t, {writeClipboard: async value => { copies.push(value) }})
  const name = `LONG_${'CONFIG_KEY_'.repeat(15)}`
  const value = `BEGIN\t${'界🔑e\u0301 '.repeat(150)}\nsecond line\n\x1b[31m{red-fg}literal{/red-fg}\n`
  d.api.config = async () => ({[name]: value})
  await key('\r')
  await key('4')
  await key('v')
  for (const width of [140, 90]) {
    screen.program.cols = width
    screen.program.emit('resize')
    d.detail.setScroll(6)
    d.render()
    const x = d.detail.lpos.xi + d.detail.ileft
    const y = d.detail.lpos.yi + d.detail.itop
    await click(x + 3, y)
    assert.equal(copies.at(-1), value)
    const previous = copies.length
    await click(d.detail.lpos.xl - d.detail.iright - 1, y) // Scrollbar.
    assert.equal(copies.length, previous)
  }
  assert.equal(copies.length, 2)
  await key('1')
  const x = d.detail.lpos.xi + d.detail.ileft
  const y = d.detail.lpos.yi + d.detail.itop
  await click(x + 3, y + 2)
  assert.equal(copies.length, 2)
})

test('empty values and wide characters are clickable without including trailing space', async t => {
  const copies = []
  const {dashboard: d, key, click} = await harness(t, {writeClipboard: async value => { copies.push(value) }})
  d.api.config = async () => ({EMPTY: '', UNICODE: '界'})
  await key('\r')
  await key('4')
  await key('v')
  let x = d.detail.lpos.xi + d.detail.ileft
  let y = d.detail.lpos.yi + d.detail.itop + 2
  assert.ok(d.detail.content.includes('(empty value)'))
  await click(x + 1, y)
  assert.deepEqual(copies, [''])
  d.main.select(1)
  await key('v')
  x = d.detail.lpos.xi + d.detail.ileft
  y = d.detail.lpos.yi + d.detail.itop + 2
  await click(x + 1, y) // Second cell of a double-width glyph.
  assert.deepEqual(copies, ['', '界'])
  await click(x + 2, y) // First cell after the glyph.
  assert.equal(copies.length, 2)
})

test('domain Hostname and CNAME values are cyan and clickable in read-only mode', async t => {
  const copies = []
  const {dashboard: d, screen, key, click} = await harness(t, {writeClipboard: async value => { copies.push(value) }})
  const original = d.api.appData.bind(d.api)
  const domain = {hostname: 'www.example.com', cname: 'target.herokudns.com', kind: 'custom', status: 'succeeded'}
  d.api.appData = async id => ({...await original(id), domains: [domain]})
  await key('\r')
  await key('5')
  d.main.select(d.rows.findIndex(row => row.kind === 'domain'))
  d.render()
  const x = d.detail.lpos.xi + d.detail.ileft
  const top = d.detail.lpos.yi + d.detail.itop
  assert.equal((screen.lines[top][x + 18][0] >> 9) & 0x1ff, blessed.colors.convert(palette.cyan))
  assert.equal((screen.lines[top + 2][x + 18][0] >> 9) & 0x1ff, blessed.colors.convert(palette.cyan))
  assert.notEqual((screen.lines[top][x][0] >> 9) & 0x1ff, blessed.colors.convert(palette.cyan))
  await click(x + 19, top)
  await click(x + 19, top + 2)
  assert.deepEqual(copies, [domain.hostname, domain.cname])
  assert.equal(d.message, 'Copied CNAME to clipboard.')
  await click(x, top)
  await click(x + 18 + domain.hostname.length, top)
  await click(x + 19, top + 1)
  await click(x + 19, top + 2, 'right')
  await click(d.detail.lpos.xl - d.detail.iright - 1, top)
  assert.equal(copies.length, 2)
  await key('?')
  await click(x + 19, top)
  assert.equal(copies.length, 2)
})

test('y copies the selected custom domain CNAME in read-only mode and ignores unavailable values', async t => {
  const copies = []
  const {dashboard: d, key} = await harness(t, {writeClipboard: async value => { copies.push(value) }})
  const original = d.api.appData.bind(d.api)
  const domain = {hostname: 'www.example.com', cname: 'target.herokudns.com', kind: 'custom'}
  d.api.appData = async id => ({...await original(id), domains: [domain]})
  await key('\r')
  await key('5')
  await key('y') // Maintenance row.
  assert.deepEqual(copies, [])
  d.main.select(d.rows.findIndex(row => row.kind === 'domain'))
  await key('y')
  assert.deepEqual(copies, [domain.cname])
  assert.equal(d.message, 'Copied CNAME to clipboard.')
  domain.cname = null
  await key('y')
  assert.match(d.message, /CNAME is not available/)
  domain.cname = 'built-in.example.com'
  domain.kind = 'heroku'
  await key('y')
  assert.equal(copies.length, 1)
})

test('wrapped and scrolled domain fields copy the complete value after resizing', async t => {
  const copies = []
  const {dashboard: d, screen, key, click} = await harness(t, {writeClipboard: async value => { copies.push(value) }})
  const original = d.api.appData.bind(d.api)
  const hostname = `${'host-label.'.repeat(18)}example.com`
  const cname = `${'target-label.'.repeat(16)}herokudns.com`
  d.api.appData = async id => ({...await original(id), domains: [{hostname, cname, kind: 'custom', acm_status_reason: 'ACM status detail '.repeat(150)}]})
  await key('\r')
  await key('5')
  d.main.select(d.rows.findIndex(row => row.kind === 'domain'))
  for (const width of [140, 90]) {
    screen.program.cols = width
    screen.program.emit('resize')
    const wrapped = d.detail._clines.ftor[2][1]
    assert.ok(wrapped > 0)
    d.detail.setScroll(wrapped)
    d.render()
    assert.equal(d.detail.lpos.base, wrapped)
    await click(d.detail.lpos.xi + d.detail.ileft + 2, d.detail.lpos.yi + d.detail.itop)
    assert.equal(copies.at(-1), cname)
  }
  assert.equal(copies.length, 2)
})

for (const enableACM of [false, true]) test(`Settings adds a domain ${enableACM ? 'with' : 'without'} ACM after confirmation`, async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const original = demo.api.appData.bind(demo.api)
  const domain = {hostname: 'www.example.com', cname: 'target.herokudns.com', kind: 'custom', status: 'pending'}
  const writes = []
  demo.api.appData = async id => {
    const data = await original(id)
    return {...data, app: {...data.app, acm: false}, domains: writes.length ? [domain] : []}
  }
  demo.api.addDomain = async (...args) => { writes.push(args); return domain }
  const {dashboard: d, key} = await harness(t, {...demo, demo: false})
  await key('\r')
  await key('5')
  await key('D')
  assert.match(d.modal._label.content, /Add Domain.*hostname/)
  await key('WWW.EXAMPLE.COM')
  await key('\r')
  assert.match(d.modal._label.content, /SSL \/ ACM/)
  if (enableACM) await key('\x0e')
  await key('\r')
  assert.match(d.modal._label.content, /Confirm remote change/)
  assert.equal(writes.length, 0)
  await key('constellation-staging')
  await key('\r')
  assert.deepEqual(writes, [['constellation-staging', domain.hostname, enableACM, 'constellation-staging']])
  assert.equal(d.rows[d.main.selected].kind, 'domain')
  assert.equal(d.rows[d.main.selected].value.hostname, domain.hostname)
  assert.match(d.message, /Added www.example.com/)
  assert.equal(d.modal, null)
})

test('Settings domain creation supports cancellation, validation, and reports partial ACM failure', async t => {
  const {dashboard: d, key} = await harness(t)
  await key('\r')
  await key('5')
  await key('D')
  assert.equal(d.modal, undefined)
  assert.match(d.message, /Read-only/)
  d.api.readOnly = false
  d.demo = false
  d.api.addDomain = async () => assert.fail('Unconfirmed write')
  await key('D')
  await key('\x1b')
  assert.equal(d.modal, null)
  await key('D')
  await key('https://example.com')
  await key('\r')
  assert.match(d.message, /valid domain hostname/)
  await key('D')
  await key('www.example.com')
  await key('\r')
  // ACM is already enabled, so no ACM selection or additional write is needed.
  assert.match(d.modal._label.content, /Confirm remote change/)
  await key('wrong-app')
  await key('\r')
  assert.match(d.message, /did not match/)
  const original = d.api.appData.bind(d.api)
  const domain = {hostname: 'partial.example.com', cname: 'partial.herokudns.com'}
  d.api.appData = async id => ({...await original(id), domains: [domain]})
  d.api.addDomain = async () => { throw Object.assign(new Error('Domain was added, but enabling ACM failed'), {createdDomain: domain}) }
  await key('D')
  await key(domain.hostname)
  await key('\r')
  await key('constellation-staging')
  await key('\r')
  assert.match(d.message, /was added, but enabling ACM failed/)
  assert.equal(d.rows[d.main.selected].value.hostname, domain.hostname)
  assert.equal(d.busy, false)
  assert.equal(d.modal, null)
})

test('x removes the selected custom domain in Settings after exact-app confirmation', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const original = demo.api.appData.bind(demo.api)
  const domain = {id: 'domain-id', hostname: 'www.example.com', kind: 'custom', cname: 'target.herokudns.com'}
  const writes = []
  demo.api.appData = async id => ({...await original(id), domains: writes.length ? [] : [domain]})
  demo.api.removeDomain = async (...args) => { writes.push(args) }
  const {dashboard: d, key} = await harness(t, {...demo, demo: false})
  await key('\r')
  await key('5')
  d.main.select(d.rows.findIndex(row => row.kind === 'domain'))
  await key('x')
  assert.match(d.modal.children.map(child => clean(child.content)).join('\n'), /Remove domain www.example.com/)
  assert.equal(writes.length, 0)
  await key('constellation-staging')
  await key('\r')
  assert.deepEqual(writes, [['constellation-staging', domain, 'constellation-staging']])
  assert.ok(!d.rows.some(row => row.kind === 'domain' && row.value.hostname === domain.hostname))
  assert.equal(d.message, 'Removed www.example.com. Settings refreshed.')
  assert.equal(d.modal, null)
  assert.equal(d.busy, false)
})

test('domain removal rejects non-custom rows, read-only/demo modes, cancellation, and wrong confirmation', async t => {
  const {dashboard: d, key} = await harness(t)
  let writes = 0
  d.api.removeDomain = async () => { writes++; assert.fail('Unconfirmed removal') }
  await key('\r')
  await key('5')
  await key('x')
  assert.match(d.message, /Read-only/)
  d.api.readOnly = false
  d.demo = true
  await key('x')
  assert.match(d.message, /offline demo/)
  d.demo = false
  await key('x')
  assert.match(d.message, /Select a custom domain/)
  d.main.select(d.rows.findIndex(row => row.kind === 'domain'))
  await key('x')
  assert.match(d.message, /default Heroku domain cannot be removed/)
  d.rows[d.main.selected].value = {kind: 'custom', hostname: 'www.example.com', id: 'domain-id'}
  await key('x')
  await key('\x1b')
  assert.equal(d.modal, null)
  await key('x')
  await key('wrong-app')
  await key('\r')
  assert.match(d.message, /did not match/)
  assert.equal(writes, 0)
})

test('y only copies an available config row and remains text inside prompts', async t => {
  const {dashboard: d, key} = await harness(t, {writeClipboard: async () => assert.fail('No config value should be copied')})
  await key('y') // Pipeline overview.
  await key('\r')
  await key('y') // App overview.
  d.api.config = async () => ({})
  await key('4')
  await key('y') // Empty config list.
  await key('/')
  await key('y')
  await key('\r')
  assert.equal(d.filter, 'y')
})

test('clipboard errors do not expose config values or leave the UI busy', async t => {
  const {dashboard: d, screen, key} = await harness(t, {writeClipboard: async value => { throw new Error(`Backend failed with stdin: ${value}`) }})
  await key('\r')
  await key('4')
  await key('y')
  assert.equal(d.messageTone, 'error')
  assert.match(d.message, /Could not copy value/)
  assert.equal(d.copying, false)
  assert.equal(d.revealed.size, 0)
  assert.ok(!d.message.includes('demo-only-value'))
  const visible = screen.lines.map(line => line.map(cell => cell[1]).join('')).join('\n')
  assert.ok(!visible.includes('demo-only-value'))
  await key('1')
  assert.equal(d.tab, 0)
})

test('pending copies ignore repeats and do not overwrite status after changing apps', async t => {
  const pending = Promise.withResolvers()
  let copies = 0
  const {dashboard: d, key} = await harness(t, {writeClipboard: () => { copies++; return pending.promise }})
  await key('\r')
  await key('4')
  const copying = d.copyConfig()
  await key('y')
  assert.equal(copies, 1)
  await d.openApp(d.catalog.apps[1])
  const message = d.message
  pending.resolve()
  await copying
  assert.equal(d.message, message)
  assert.equal(d.copying, false)
})

test('h/l wrap through views in every pane without opening selected items', async t => {
  const {dashboard: d, key} = await harness(t)
  await key('l')
  assert.equal(d.app, null)
  await key('\r')
  const app = d.app
  for (const pane of [d.main, d.nav, d.detail]) {
    pane.focus()
    await key('h')
    assert.equal(d.tab, 6)
    await key('l')
    assert.equal(d.tab, 0)
    await key('l')
    assert.equal(d.tab, 1)
    await key('h')
    assert.equal(d.tab, 0)
    assert.equal(d.app, app)
  }
  await key('/')
  await key('hl')
  await key('\r')
  assert.equal(d.filter, 'hl')
  assert.equal(d.tab, 0)
})

test('filter input supports readline editing of long pre-filled values without changing navigation', async t => {
  const {dashboard: d, key} = await harness(t)
  d.filter = 'x'.repeat(200) + 'stellation'
  await key('/')
  assert.ok(d.modal)
  const input = d.modal.children.find(child => child.type === 'textbox')
  assert.equal(input.getValue(), d.filter)
  assert.ok(d.screen.program.x >= input.lpos.xi + input.ileft)
  assert.ok(d.screen.program.x < input.lpos.xl - input.iright)
  await key('\x05' + '\x02'.repeat('stellation'.length) + '\x15')
  assert.equal(input.getValue(), 'stellation')
  await key('\x01')
  await key('con')
  await key('\x05')
  assert.equal(input.getValue(), 'constellation')
  assert.equal(d.mode, 'pipelines')
  assert.equal(d.closed, false)
  await key('\r')
  assert.equal(d.modal, null)
  assert.equal(d.filter, 'constellation')
  assert.equal(d.navItems.length, 1)
})

test('app-scoped Heroku commands require confirmation and stream sanitized output in a floating pane', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const execution = Promise.withResolvers()
  const calls = []
  const executeHeroku = async (args, options) => {
    calls.push({args, signal: options.signal})
    options.onOutput('first line\n\x1b[31mred line\x1b[0m\n\x1b]52;c;hidden-value\x07second line\n')
    return execution.promise
  }
  const {dashboard: d, screen, key} = await harness(t, {...demo, demo: false, executeHeroku})
  await key('\r')
  await key(':')
  assert.match(d.modal._label.content, /Heroku command.*constellation-staging/)
  await key('logs --num "10"')
  await key('\r')
  const invocation = 'heroku logs --num 10 --app constellation-staging'
  assert.match(d.modal.children.map(child => child.content).join('\n'), new RegExp(invocation))
  assert.match(d.modal.children.map(child => clean(child.content)).join('\n'), /Continue \(y\)/)
  assert.match(d.modal.children.map(child => clean(child.content)).join('\n'), /Cancel \(n\)/)
  const confirmation = screen.lines.map(line => line.map(cell => cell[1]).join(''))
  const confirmationY = confirmation.findIndex(line => line.includes(invocation))
  const confirmationX = confirmation[confirmationY].indexOf(invocation)
  assert.equal((screen.lines[confirmationY][confirmationX][0] >> 9) & 0x1ff, blessed.colors.convert(palette.warning))
  assert.equal(calls.length, 0)
  await key('\r')
  assert.deepEqual(calls[0].args, ['logs', '--num', '10', '--app', 'constellation-staging'])
  const output = d.modal.children.find(child => child.scrollable)
  assert.match(output.content, /first line\n\x1b\[31mred line\x1b\[0m\nsecond line/)
  assert.ok(!output.content.includes('hidden-value'))
  const rendered = screen.lines.map(line => line.map(cell => cell[1]).join(''))
  const y = rendered.findIndex(line => line.includes('red line'))
  const x = rendered[y].indexOf('red line')
  assert.equal((screen.lines[y][x][0] >> 9) & 0x1ff, blessed.colors.convert('red'))
  assert.equal(calls[0].signal.aborted, false)
  execution.resolve({code: 0, signal: null})
  await delay(20)
  assert.match(d.modal.children.map(child => clean(child.content)).join('\n'), /Completed successfully/)
  await key('q')
  assert.equal(d.modal, null)
  assert.match(d.message, /command completed/i)
})

test('custom command prompt browses shared history and saves the confirmed command', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const added = []
  const calls = []
  const commandHistory = {
    entries: ['config:get API_URL', 'logs --tail'],
    async add(value) { added.push(value) },
  }
  const {dashboard: d, key} = await harness(t, {...demo, demo: false, commandHistory,
    executeHeroku: async args => { calls.push(args); return {code: 0, signal: null} }})
  await key('\r')
  await key(':')
  const input = d.modal.children.find(child => child.type === 'textbox')
  assert.match(d.modal.children.map(child => clean(child.content)).join('\n'), /↑\/↓ history/)
  await key('draft command')
  await key('\x10')
  assert.equal(input.getValue(), 'logs --tail')
  await key('\x1b[A')
  assert.equal(input.getValue(), 'config:get API_URL')
  await key('\x0e')
  assert.equal(input.getValue(), 'logs --tail')
  await key('\x1b[B')
  assert.equal(input.getValue(), 'draft command')
  await key('\x1b[A')
  await key('\r')
  assert.deepEqual(added, [])
  await key('\r')
  assert.deepEqual(added, ['logs --tail'])
  assert.deepEqual(calls, [['logs', '--tail', '--app', 'constellation-staging']])
})

test('custom command prompt supports readline editing shortcuts', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const {dashboard: d, key} = await harness(t, {...demo, demo: false})
  await key('\r')
  await key(':')
  const input = d.modal.children.find(child => child.type === 'textbox')
  await key('helo')
  await key('\x02\x02')
  await key('l')
  assert.equal(input.getValue(), 'hello')
  await key('\x01')
  await key('say ')
  await key('\x05')
  await key(' now')
  assert.equal(input.getValue(), 'say hello now')
  await key('\x02\x02\x02')
  await key('\x0b')
  assert.equal(input.getValue(), 'say hello ')
  await key('\x19')
  assert.equal(input.getValue(), 'say hello now')
  await key('\x17')
  assert.equal(input.getValue(), 'say hello ')
  await key('\x19')
  await key('\x05\x15')
  assert.equal(input.getValue(), '')
  await key('acb')
  await key('\x02')
  await key('\x14')
  assert.equal(input.getValue(), 'abc')
  await key('\x01\x06\x04')
  assert.equal(input.getValue(), 'ac')
  await key('\x05\x15')
  await key('one three')
  await key('\x1bb')
  await key('two ')
  assert.equal(input.getValue(), 'one two three')
  await key('\x1bd')
  assert.equal(input.getValue(), 'one two ')
  await key('\r')
  assert.match(d.modal.children.map(child => clean(child.content)).join('\n'), /heroku one two --app constellation-staging/)
  await key('n')
})

test('app-confirm commands inject the current app and require one exact-name confirmation', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const calls = []
  const {dashboard: d, screen, key} = await harness(t, {...demo, demo: false,
    appConfirm: new Map([['pg:upgrade:run', 'c']]),
    executeHeroku: async args => { calls.push(args); return {code: 0, signal: null} }})
  await key('\r')
  await key(':')
  await key('pg:upgrade:run DATABASE_URL')
  await key('\r')
  const invocation = 'heroku pg:upgrade:run DATABASE_URL --confirm constellation-staging --app constellation-staging'
  assert.match(d.modal.children.map(child => child.content).join('\n'), new RegExp(invocation))
  assert.match(d.modal._label.content, /Confirm remote change/)
  assert.ok(!d.modal.children.some(child => clean(child.content) === 'Continue (y)'))
  const confirmation = screen.lines.map(line => line.map(cell => cell[1]).join(''))
  const confirmationY = confirmation.findIndex(line => line.includes(invocation))
  const confirmationX = confirmation[confirmationY].indexOf(invocation)
  assert.equal((screen.lines[confirmationY][confirmationX][0] >> 9) & 0x1ff, blessed.colors.convert(palette.warning))
  await key('wrong-app')
  await key('\r')
  assert.equal(calls.length, 0)
  assert.match(d.message, /App name did not match/)
  await key(':')
  await key('pg:upgrade:run DATABASE_URL --confirm constellation-staging')
  await key('\r')
  await key('constellation-staging')
  await key('\r')
  assert.deepEqual(calls, [[
    'pg:upgrade:run', 'DATABASE_URL', '--confirm', 'constellation-staging', '--app', 'constellation-staging',
  ]])
})

test('interactive console commands temporarily take over and restore the terminal', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const calls = []
  let screen
  const executeInteractiveHeroku = async (args, options) => {
    calls.push({args, signal: options.signal})
    assert.equal(screen.program.isAlt, false)
    assert.equal(screen.program.input.isPaused(), true)
    return {code: 0, signal: null}
  }
  const result = await harness(t, {...demo, demo: false, executeInteractiveHeroku,
    executeHeroku: async () => assert.fail('Interactive commands must not use captured output')})
  const {dashboard: d, key} = result
  screen = result.screen
  const clears = []
  const clear = screen.program.clear.bind(screen.program)
  screen.program.clear = () => { clears.push(screen.program.isAlt); return clear() }
  await key('\r')
  await key('C')
  assert.match(d.modal.children.map(child => child.content).join('\n'), /temporarily take over the terminal/)
  await key('\r')
  assert.deepEqual(calls[0].args, ['console', '--app', 'constellation-staging'])
  assert.equal(calls[0].signal.aborted, false)
  assert.deepEqual(clears.filter(isAlt => !isAlt), [false, false])
  assert.equal(screen.program.isAlt, true)
  assert.equal(screen.program.input.isPaused(), false)
  assert.equal(d.interactiveRequest, null)
  assert.equal(d.busy, false)
  assert.match(d.message, /Interactive Heroku command completed/)
})

test('custom commands support cancellation, button selection, and reject retargeting and unavailable modes', async t => {
  let calls = 0
  const {dashboard: d, screen, key, click} = await harness(t, {executeHeroku: async () => { calls++; return {code: 0, signal: null} }})
  await key('\r')
  await key(':')
  assert.equal(d.modal, undefined)
  assert.match(d.message, /Read-only/)
  d.api.readOnly = false
  d.demo = true
  await key(':')
  assert.equal(d.modal, undefined)
  assert.match(d.message, /offline demo/)
  d.demo = false
  await key(':')
  await key('logs --app another-app')
  await key('\r')
  assert.equal(d.modal, null)
  assert.match(d.message, /selectors are not allowed/)
  await key(':')
  await key('logs')
  await key('\r')
  await key('n')
  assert.equal(d.modal, null)
  assert.match(d.message, /Command cancelled/)
  await key(':')
  await key('logs')
  await key('\r')
  const proceed = d.modal.children.find(child => clean(child.content) === 'Continue (y)')
  const cancel = d.modal.children.find(child => clean(child.content) === 'Cancel (n)')
  assert.equal((screen.lines[proceed.lpos.yi][proceed.lpos.xi][0] >> 9) & 0x1ff, blessed.colors.convert(palette.success))
  await key('\x1b[C')
  assert.equal((screen.lines[cancel.lpos.yi][cancel.lpos.xi][0] >> 9) & 0x1ff, blessed.colors.convert(palette.success))
  await key('\r')
  assert.equal(d.modal, null)
  assert.equal(calls, 0)
  await key(':')
  await key('logs')
  await key('\r')
  await key('\x1b[C')
  await key('\x1b[D')
  await key('\r')
  assert.equal(calls, 1)
  assert.ok(d.modal.children.some(child => child.scrollable))
  await key('q')
  await key(':')
  await key('logs')
  await key('\r')
  const clickCancel = d.modal.children.find(child => clean(child.content) === 'Cancel (n)')
  await click(Math.floor((clickCancel.lpos.xi + clickCancel.lpos.xl) / 2), Math.floor((clickCancel.lpos.yi + clickCancel.lpos.yl) / 2))
  assert.equal(d.modal, null)
  assert.equal(calls, 1)
})

test('read-only action keys do not open mutation prompts', async t => {
  const {dashboard: d, key} = await harness(t)
  await key('\r')
  for (const tab of ['1', '2']) {
    await key(tab)
    d.main.select(d.rows.findIndex(row => row.kind === 'formation'))
    await key('s')
    assert.equal(d.modal, undefined)
    assert.match(d.message, /Read-only/)
  }
  await key('2')
  for (const kind of ['formation', 'dyno']) {
    d.main.select(d.rows.findIndex(row => row.kind === kind))
    for (const action of ['x', 'r']) {
      await key(action)
      assert.equal(d.modal, undefined)
      assert.match(d.message, /Read-only/)
    }
  }
})

test('Resources scales stopped processes to zero and restarts processes and dynos', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const writes = []
  demo.api.scale = async (...args) => { writes.push(['scale', ...args]) }
  demo.api.stop = async () => assert.fail('The UI must not stop configured dynos directly')
  demo.api.restart = async (...args) => { writes.push(['restart', ...args]) }
  const {dashboard: d, key} = await harness(t, demo)
  await key('\r')
  await key('2')
  const cases = [
    ['formation:web', 'x', 'Stop process web', ['scale', 'constellation-staging', 'web', 0, 'Standard-1X', 'constellation-staging']],
    ['formation:worker', 'r', 'Restart process worker', ['restart', 'constellation-staging', 'worker', 'process', 'constellation-staging']],
    ['dyno:worker.1', 'r', 'Restart dyno worker.1', ['restart', 'constellation-staging', 'worker.1', 'dyno', 'constellation-staging']],
  ]
  for (const [id, keybinding, description, expected] of cases) {
    d.main.select(d.rows.findIndex(row => row.id === id))
    await key(keybinding)
    const prompt = d.modal.children.map(child => child.content).join('\n')
    assert.match(prompt, new RegExp(description))
    if (keybinding === 'x') assert.match(prompt, /scaling it from 2 × Standard-1X to 0 × Standard-1X/i)
    await key('constellation-staging')
    await key('\r')
    assert.deepEqual(writes.at(-1), expected)
    assert.equal(d.rows[d.main.selected].id, id)
  }
  const before = writes.length
  d.main.select(d.rows.findIndex(row => row.id === 'dyno:web.1'))
  await key('x')
  assert.equal(d.modal, null)
  assert.equal(writes.length, before)
  assert.match(d.message, /Individual dynos can only be restarted/)
})

test('Overview scales inactive and active process rows through the confirmed flow', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  let quantity = 0
  const writes = []
  const original = demo.api.appData
  demo.api.appData = async id => {
    const data = await original(id)
    const [web, worker] = data.formation
    data.formation = [{...worker, quantity}, web]
    return data
  }
  demo.api.scale = async (...args) => { writes.push(args); quantity = args[2] }
  const {dashboard: d, key} = await harness(t, demo)
  await key('\r')
  for (const desired of [2, 0]) {
    d.main.select(d.rows.findIndex(row => row.id === 'overview:formation:worker'))
    const before = writes.length
    await key('s')
    assert.match(d.modal.children.map(child => child.content).join('\n'), /constellation-staging \/ worker/)
    await key('\x15')
    await key(String(desired))
    await key('\r')
    await key('\r') // Retain the current dyno size.
    assert.equal(writes.length, before)
    await key('constellation-staging')
    await key('\r')
    assert.deepEqual(writes.at(-1), ['constellation-staging', 'worker', desired, 'Standard-2X', 'constellation-staging'])
    assert.equal(d.tab, 0)
    assert.equal(d.rows[d.main.selected].id, 'overview:formation:worker')
    assert.equal(d.rows[d.main.selected].value.quantity, desired)
  }
})

test('Overview scaling ignores non-process rows and can be canceled', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  demo.api.scale = async () => assert.fail('No scaling should be submitted')
  const {dashboard: d, key} = await harness(t, demo)
  await key('\r')
  for (const [index, row] of d.rows.entries()) {
    if (row.kind === 'formation') continue
    d.main.select(index)
    await key('s')
    assert.ok(!d.modal)
    assert.match(d.message, /Select a process type/)
  }
  d.main.select(d.rows.findIndex(row => row.kind === 'formation'))
  await key('s')
  assert.ok(d.modal)
  await key('\x1b')
  await delay(50)
  assert.equal(d.modal, null)
})

test('scale cancellation and mismatched confirmation never call the API', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  let writes = 0
  demo.api.scale = async () => { writes++ }
  const {dashboard: d, key} = await harness(t, demo)
  await key('\r')
  await key('2')
  await key('s')
  await key('\x1b')
  await delay(50)
  assert.equal(writes, 0)
  assert.equal(d.modal, null)
  await key('s')
  await key('\x15') // Ctrl-U clears the pre-filled quantity.
  await key('0')
  await key('\r')
  await key('\r') // Keep size.
  assert.match(d.modal.children.map(child => child.content).join('\n'), /2 × Standard-1X → 0 × Standard-1X/)
  await key('wrong-app')
  await key('\r')
  assert.equal(writes, 0)
  assert.match(d.message, /did not match/)
})

test('scaling prompts edit pre-filled inputs with readline and send exact values to the API', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const writes = []
  demo.api.scale = async (...args) => { writes.push(args) }
  const {dashboard: d, key} = await harness(t, demo)
  await key('\r')
  await key('2')
  await key('s')
  await key('\x01\x04')
  await key('3')
  await key('\r')
  await key('\x02\x02\x04')
  await key('2')
  assert.equal(d.modal.children.find(child => child.type === 'textbox').getValue(), 'Standard-2X')
  await key('\r')
  await key('constellation-staging')
  await key('\r')
  assert.deepEqual(writes, [['constellation-staging', 'web', 3, 'Standard-2X', 'constellation-staging']])
})

test('slow app response cannot overwrite a newer selection', async t => {
  const {dashboard: d} = await harness(t)
  const original = d.api.appData
  let finish
  d.api.appData = async id => {
    if (id === 'app-staging') await new Promise(resolve => { finish = resolve })
    return original(id)
  }
  const first = d.openApp(d.catalog.apps[0])
  await d.openApp(d.catalog.apps[1])
  finish()
  await first
  assert.equal(d.app.name, 'constellation-production')
  assert.equal(d.data.app.name, 'constellation-production')
})

test('config name and masked value prompts support readline editing and require app-name confirmation', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const writes = []
  demo.api.setConfig = async (...args) => { writes.push(args) }
  const {dashboard: d, screen, key} = await harness(t, demo)
  await key('\r')
  await key('4')
  await key('n')
  await key('NEW_SCRET')
  await key('\x01' + '\x06'.repeat(5))
  await key('E')
  assert.equal(d.modal.children.find(child => child.type === 'textbox').getValue(), 'NEW_SECRET')
  await key('\r')
  const input = d.modal.children.find(child => child.type === 'textbox')
  const assertMasked = (value, cursor = [...value].length) => {
    assert.equal(input.getValue(), value)
    assert.equal(input.content, '*'.repeat([...value].length))
    assert.equal(screen.program.x, input.lpos.xi + input.ileft + cursor)
    const visible = screen.lines.map(line => line.map(cell => cell[1]).join('')).join('\n')
    assert.ok(!visible.includes('display-'))
    assert.ok(!visible.includes('密'))
    assert.ok(!visible.includes('🔑'))
  }
  await key('display-密🔑')
  assertMasked('display-密🔑')
  await key('\x01')
  assertMasked('display-密🔑', 0)
  await key('never-')
  assertMasked('never-display-密🔑', 6)
  await key('\x05\x02\x02\x0b')
  assertMasked('never-display-')
  await key('\x19')
  assertMasked('never-display-密🔑')
  await key('\x17')
  assertMasked('')
  await key('\x19')
  assertMasked('never-display-密🔑')
  await key('\r')
  assert.equal(writes.length, 0)
  await key('constellation-staging')
  await key('\r')
  assert.deepEqual(writes, [['constellation-staging', 'NEW_SECRET', 'never-display-密🔑', 'constellation-staging']])
  assert.equal(d.modal, null)
})

test('config deletion and maintenance toggle target the confirmed app', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const writes = []
  demo.api.setConfig = async (...args) => { writes.push(['config', ...args]) }
  demo.api.maintenance = async (...args) => { writes.push(['maintenance', ...args]) }
  const {dashboard: d, key} = await harness(t, demo)
  await key('\r')
  await key('4')
  await key('d')
  assert.ok(!d.modal)
  await key('x')
  await key('constellation-staging')
  await key('\r')
  await key('5')
  await key('m')
  await key('onstellation-staging')
  await key('\x01')
  await key('c')
  await key('\r')
  assert.deepEqual(writes, [
    ['config', 'constellation-staging', 'EXAMPLE_SECRET', null, 'constellation-staging'],
    ['maintenance', 'constellation-staging', true, 'constellation-staging'],
  ])
})

test('Ctrl-C exits while a textbox has captured terminal input', async t => {
  const {dashboard: d, key} = await harness(t)
  await key('/')
  assert.ok(d.modal)
  await key('\x03')
  assert.equal(d.closed, true)
  assert.equal(d.screen.destroyed, true)
})

test('styled config rows preserve literal tags and reject remote terminal escapes', async t => {
  const {dashboard: d, screen, key} = await harness(t)
  d.api.config = async () => ({TOKEN: '{red-fg}literal{/red-fg}\x1b[2Jsecret'})
  await key('\r')
  await key('4')
  const visible = () => screen.lines.map(line => line.map(cell => cell[1]).join('')).join('\n')
  assert.ok(!visible().includes('literal'))
  await key('v')
  assert.ok(visible().includes('{red-fg}literal{/red-fg}secret'))
  assert.ok(!d.main.items[0].content.includes('\x1b[2J'))
  await key('v')
  assert.ok(!visible().includes('literal'))
})

test('loading scanner advances and reverses without disturbing selection or scrolling', async t => {
  const {dashboard: d, screen} = await harness(t)
  await d.openApp(d.catalog.apps[0])
  const data = d.data
  const request = Promise.withResolvers()
  d.api.appData = () => request.promise
  t.mock.timers.enable({apis: ['setInterval']})
  d.main.select(1)
  d.detail.setContent(Array.from({length: 40}, (_, i) => `Detail line ${i}`).join('\n'))
  d.detail.setScroll(5)
  d.detail.focus()
  const scroll = d.detail.getScroll()
  const loading = d.loadApp(true)
  const scanner = () => clean(d.status.content).slice(0, 8)
  assert.equal(scanner(), '■⬝⬝⬝⬝⬝⬝⬝')
  t.mock.timers.tick(40)
  assert.equal(scanner(), '■■⬝⬝⬝⬝⬝⬝')
  t.mock.timers.tick(40 * 6)
  assert.equal(scanner(), '⬝⬝⬝⬝■■■■')
  t.mock.timers.tick(40 * 4)
  assert.equal(scanner(), '⬝⬝⬝⬝⬝⬝⬝■')
  t.mock.timers.tick(40)
  assert.equal(scanner(), '⬝⬝⬝⬝⬝⬝■■')
  assert.equal(d.main.selected, 1)
  assert.equal(screen.focused, d.detail)
  assert.equal(d.detail.getScroll(), scroll)
  request.resolve(data)
  await loading
  assert.equal(d.loadingTimer, null)
  assert.ok(!clean(d.status.content).includes('■'))
})

test('loading continues until overlapping app and config requests finish', async t => {
  const {dashboard: d} = await harness(t)
  await d.openApp(d.catalog.apps[0])
  const data = d.data
  const app = Promise.withResolvers()
  const config = Promise.withResolvers()
  d.api.appData = () => app.promise
  d.api.config = () => config.promise
  const appLoading = d.loadApp()
  const configLoading = d.loadConfig()
  app.resolve(data)
  await appLoading
  assert.match(clean(d.status.content), /Loading config vars/)
  assert.ok(d.loadingTimer)
  config.resolve({TOKEN: 'masked'})
  await configLoading
  assert.equal(d.loadingTimer, null)
  assert.equal(d.loading.size, 0)
})

test('an old config response cannot stop a newer request animation', async t => {
  const {dashboard: d} = await harness(t)
  await d.openApp(d.catalog.apps[0])
  const old = Promise.withResolvers()
  const latest = Promise.withResolvers()
  d.api.config = () => old.promise
  const oldLoading = d.loadConfig()
  d.api.config = () => latest.promise
  const latestLoading = d.loadConfig()
  old.resolve({TOKEN: 'old'})
  await oldLoading
  assert.ok(d.loadingTimer)
  assert.equal(d.config, null)
  latest.resolve({TOKEN: 'latest'})
  await latestLoading
  assert.equal(d.config.TOKEN, 'latest')
  assert.equal(d.loadingTimer, null)
})

test('catalog failure and terminal destruction clean up loading timers', async t => {
  const {dashboard: d, screen} = await harness(t)
  await d.back()
  const catalog = Promise.withResolvers()
  d.api.catalog = () => catalog.promise
  const reload = d.reload()
  assert.match(clean(d.status.content), /Refreshing teams/)
  assert.ok(d.loadingTimer)
  catalog.reject(new Error('Network unavailable'))
  await reload
  assert.equal(d.loadingTimer, null)
  assert.match(clean(d.status.content), /Network unavailable/)

  const pipeline = Promise.withResolvers()
  d.api.pipelineApps = () => pipeline.promise
  const opening = d.openPipeline(d.catalog.pipelines[0])
  assert.match(clean(d.status.content), /Loading pipeline/)
  assert.ok(d.loadingTimer)
  screen.destroy()
  assert.equal(d.closed, true)
  assert.equal(d.loadingTimer, null)
  pipeline.resolve([])
  await opening
  assert.equal(d.loading.size, 0)
  assert.equal(d.loadingTimer, null)
})

test('leaving an app clears its outstanding loading indicator', async t => {
  const {dashboard: d} = await harness(t)
  await d.openApp(d.catalog.apps[0])
  const config = Promise.withResolvers()
  d.api.config = () => config.promise
  const loading = d.loadConfig()
  await d.back()
  assert.equal(d.app, null)
  assert.equal(d.loadingTimer, null)
  config.resolve({TOKEN: 'old-app'})
  await loading
  assert.equal(d.config, null)
  assert.equal(d.loadingTimer, null)
})

const costData = monthlyCost => ({formations: Object.fromEntries(['web', 'worker'].map(type => [type, {
  ramPerDynoMb: 512, allocatedRamMb: 1024, cpuPerDyno: '1x shared', cpu: '2x shared', monthlyCost, unitMonthlyCost: 25,
}])), instances: {}})

test('cost enrichment is lazy, preserves selection and scroll, and refreshes with R', async t => {
  const pending = Promise.withResolvers()
  const calls = []
  const resources = {available: true, version: '0.5.1',
    async dynos(data, options) { calls.push(['dynos', data.app.id, options.force]); return calls.length === 1 ? pending.promise : costData(75) },
    async addons() { calls.push(['addons']); return {byId: {postgres: {costCents: 500, costUnit: 'month'}}} },
  }
  const {dashboard: d, key} = await harness(t, {resources})
  await key('\r')
  assert.deepEqual(calls, [])
  await key('2')
  assert.equal(calls.length, 1)
  assert.match(clean(d.status.content), /Loading dyno costs/)
  d.main.select(d.rows.findIndex(row => row.id === 'formation:worker'))
  d.detail.setContent(Array.from({length: 40}, (_, i) => `Detail ${i}`).join('\n'))
  d.detail.setScroll(3)
  pending.resolve(costData(50))
  await delay(15)
  assert.equal(d.rows[d.main.selected].id, 'formation:worker')
  assert.equal(d.detail.childBase, 3)
  assert.match(d.detail.content, /\$50\.00\/month/)
  await key('3')
  assert.match(d.detail.content, /\$5\.00\/month/)
  await key('2')
  assert.equal(calls.length, 2)
  await key('R')
  assert.equal(calls.length, 3)
  assert.equal(calls.at(-1)[2], true)
  assert.match(d.detail.content, /\$75\.00\/month/)
})

test('grouped dynos cannot be scaled directly and resource selection survives refresh reordering', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  demo.api.scale = async () => assert.fail('No scaling should be submitted')
  const {dashboard: d, key} = await harness(t, demo)
  await key('\r')
  await key('2')
  await key('j')
  assert.equal(d.rows[d.main.selected].id, 'dyno:web.1')
  await key('s')
  assert.ok(!d.modal)
  assert.match(d.message, /Select a process type/)
  await key('j')
  await key('j')
  assert.equal(d.rows[d.main.selected].id, 'formation:worker')
  await key('s')
  assert.match(d.modal.children.map(child => child.content).join('\n'), /constellation-staging \/ worker/)
  await key('\x1b')
  await delay(50)
  const original = d.api.appData
  d.api.appData = async id => {
    const data = await original(id)
    data.dynos.push({...data.dynos[0], name: 'web.3'})
    return data
  }
  await d.loadApp()
  assert.equal(d.main.selected, 4)
  assert.equal(d.rows[d.main.selected].id, 'formation:worker')
  assert.match(d.detail.content, /Process\s+worker/)
})

test('failed optional cost lookup does not block the app and can be retried', async t => {
  const resources = {available: true, version: '0.5.1', async dynos() { throw new Error('Cost API unavailable') }}
  const {dashboard: d, key} = await harness(t, {resources})
  await key('\r')
  await key('2')
  assert.equal(d.rows[0].kind, 'formation')
  assert.match(d.detail.content, /Cost API unavailable/)
  assert.equal(d.loadingTimer, null)
  resources.dynos = async () => costData(50)
  await key('R')
  assert.match(d.detail.content, /\$50\.00\/month/)
  assert.equal(d.resourceErrors.dynos, undefined)
})

test('late cost data from another app cannot overwrite the current resource details', async t => {
  const pending = Promise.withResolvers()
  const resources = {available: true, version: '0.5.1',
    async dynos(data) { return data.app.id === 'app-staging' ? pending.promise : costData(100) },
  }
  const {dashboard: d, key} = await harness(t, {resources})
  await key('\r')
  await key('2')
  await d.openApp(d.catalog.apps[1])
  assert.equal(d.tab, 1)
  await delay(15)
  assert.match(d.detail.content, /\$100\.00\/month/)
  pending.resolve(costData(50))
  await delay(15)
  assert.equal(d.resourceData.dynos.formations.web.monthlyCost, 100)
  assert.match(d.detail.content, /\$100\.00\/month/)
})

test('telemetry loads lazily, preserves selected metric and scroll, caches tab switches, and refreshes with R', async t => {
  const pending = Promise.withResolvers()
  const calls = []
  const {dashboard: d, key} = await harness(t, {fetchMetrics: async (data, options) => {
    calls.push({data, options})
    return calls.length === 1 ? pending.promise : demoTelemetry(data)
  }})
  await key('\r')
  assert.equal(calls.length, 0)
  await key('7')
  assert.equal(calls.length, 1)
  assert.match(clean(d.status.content), /Loading performance metrics/)
  d.main.select(2)
  await d.loadApp(true)
  assert.equal(calls.length, 1, 'Automatic refresh must not restart an in-flight metrics request')
  d.detail.setContent(Array.from({length: 40}, (_, i) => `Line ${i}`).join('\n'))
  d.detail.setScroll(2)
  pending.resolve(demoTelemetry(calls[0].data))
  await delay(15)
  assert.equal(d.rows[d.main.selected].id, 'telemetry:latency:p95')
  assert.equal(d.detail.childBase, 2)
  assert.match(d.detail.content, /api.metrics.heroku.com/)
  assert.equal(d.metricsRequest, null)
  assert.equal(d.loadingTimer, null)
  await key('1')
  await key('7')
  assert.equal(calls.length, 1)
  await key('R')
  assert.equal(calls.length, 2)
  assert.ok(d.telemetry)
})

test('T cycles Metrics timeframes, preserves the selected metric, and ignores superseded responses', async t => {
  const calls = []
  const first = Promise.withResolvers()
  const second = Promise.withResolvers()
  const {dashboard: d, key} = await harness(t, {fetchMetrics: async (data, options) => {
    calls.push({data, options})
    if (calls.length === 1) return first.promise
    if (calls.length === 2) return second.promise
    return demoTelemetry(data, Date.now(), options.windowHours)
  }})
  await key('T')
  assert.equal(calls.length, 0)
  await key('\r')
  await key('7')
  assert.equal(calls[0].options.windowHours, 2)
  assert.match(clean(d.main._label.content), /Past 2 hours/)
  d.main.select(d.rows.findIndex(row => row.id === 'telemetry:memory:web'))
  await key('T')
  assert.equal(calls[0].options.signal.aborted, true)
  assert.equal(calls[1].options.windowHours, 24)
  assert.equal(d.telemetry, null)
  assert.match(clean(d.main._label.content), /Past 24 hours/)
  first.resolve(demoTelemetry(calls[0].data))
  await delay(15)
  assert.equal(d.telemetry, null)
  assert.equal(d.metricsRequest.controller.signal, calls[1].options.signal)
  await key('T')
  assert.equal(calls[1].options.signal.aborted, true)
  assert.equal(d.telemetry.windowHours, 72)
  second.resolve(demoTelemetry(calls[1].data, Date.now(), 24))
  await delay(15)
  assert.equal(d.telemetry.windowHours, 72)
  for (const [hours, label] of [[168, 'Past 7 days'], [2, 'Past 2 hours']]) {
    await key('T')
    assert.equal(d.telemetry.windowHours, hours)
    assert.equal(d.metricsWindowHours, hours)
    assert.match(clean(d.main._label.content), new RegExp(label))
    assert.match(clean(d.detail.content), new RegExp(label))
    assert.equal(d.rows[d.main.selected].id, 'telemetry:memory:web')
  }
  assert.equal(d.loadingTimer, null)
})

test('the selected Metrics range persists across tab/app changes and R refreshes that range', async t => {
  const calls = []
  const {dashboard: d, key} = await harness(t, {fetchMetrics: async (data, options) => {
    calls.push({app: data.app.id, hours: options.windowHours})
    return demoTelemetry(data, Date.now(), options.windowHours)
  }})
  await key('\r')
  await key('7')
  await key('T')
  const snapshot = d.telemetry
  await key('1')
  await key('T')
  assert.equal(d.metricsWindowHours, 24, 'Timeframe control is Metrics-only')
  await key('7')
  assert.equal(d.telemetry, snapshot)
  assert.equal(calls.length, 2)
  await key('R')
  assert.equal(calls.at(-1).hours, 24)
  assert.notEqual(d.telemetry, snapshot)
  await d.openApp(d.catalog.apps[1])
  assert.equal(d.metricsWindowHours, 24)
  assert.equal(d.telemetry.windowHours, 24)
  assert.deepEqual(calls.at(-1), {app: 'app-production', hours: 24})
})

test('old app telemetry is aborted and cannot replace the newly selected app', async t => {
  const pending = Promise.withResolvers()
  let firstData, firstSignal
  const {dashboard: d, key} = await harness(t, {fetchMetrics: async (data, {signal}) => {
    if (data.app.id === 'app-staging') { firstData = data; firstSignal = signal; return pending.promise }
    return demoTelemetry(data)
  }})
  await key('\r')
  await key('7')
  await d.openApp(d.catalog.apps[1])
  assert.equal(firstSignal.aborted, true)
  assert.equal(d.tab, 6)
  pending.resolve(demoTelemetry(firstData))
  await delay(15)
  assert.equal(d.telemetry.appId, 'app-production')
  assert.equal(d.metricsRequest, null)
})

test('telemetry refresh failure preserves old readings as stale and supports retry', async t => {
  const {dashboard: d, key} = await harness(t)
  await key('\r')
  await key('7')
  const snapshot = d.telemetry
  d.fetchMetrics = async () => { throw new Error('Metrics service unavailable') }
  await key('R')
  assert.equal(d.telemetry, snapshot)
  assert.equal(d.rows[0].columns[3], 'Stale')
  assert.match(d.detail.content, /Metrics service unavailable/)
  assert.equal(d.loadingTimer, null)
  d.fetchMetrics = async data => demoTelemetry(data)
  await key('R')
  assert.equal(d.metricsError, null)
  assert.notEqual(d.rows[0].columns[3], 'Stale')
})

test('closing the terminal aborts telemetry and ignores a late response', async t => {
  const pending = Promise.withResolvers()
  let signal, data
  const {dashboard: d, key} = await harness(t, {fetchMetrics: async (value, options) => {
    data = value; signal = options.signal
    return pending.promise
  }})
  await key('\r')
  await key('7')
  d.close()
  assert.equal(signal.aborted, true)
  assert.equal(d.loadingTimer, null)
  pending.resolve(demoTelemetry(data))
  await delay(15)
  assert.equal(d.telemetry, null)
})

test('metric detail charts reflow with axes on one line and preserve selection on resize', async t => {
  const {dashboard: d, screen, key} = await harness(t)
  await key('\r')
  await key('7')
  d.main.select(d.rows.findIndex(row => row.id === 'telemetry:memory:web'))
  assert.match(clean(d.detail.content), /Quota \(max\)/)
  assert.match(clean(d.detail.content), /◆ latest/)
  for (const [width, height] of [[120, 36], [80, 36], [140, 45]]) {
    screen.program.cols = width
    screen.program.rows = height
    screen.program.emit('resize')
    d.render()
    assert.equal(d.rows[d.main.selected].id, 'telemetry:memory:web')
    const source = d.detail.content.split('\n').findIndex(line => clean(line).startsWith('UTC'))
    assert.ok(source >= 0)
    assert.equal(d.detail._clines.ftor[source].length, 1, 'Time-axis labels must not wrap onto another line')
    assert.ok(d.detail.top < Math.floor(height * 0.4) + 7, 'Metrics reserves more room for the detail chart')
  }
  await key('4')
  assert.equal(d.chartLayout, null)
  assert.equal(d.main.position.height, '40%-4')
  await key('v')
  assert.ok(d.detail.content.includes('demo-only-value'))
})
