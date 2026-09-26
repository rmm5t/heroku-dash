import assert from 'node:assert/strict'
import {PassThrough, Writable} from 'node:stream'
import {setTimeout as delay} from 'node:timers/promises'
import test from 'node:test'
import blessed from 'blessed'
import {createDemo} from '../src/demo.js'
import {Dashboard} from '../src/ui/dashboard.js'
import {clean} from '../src/ui/text.js'

async function harness(t, override = {}) {
  const input = new PassThrough()
  input.isTTY = true
  input.setRawMode = () => {}
  const output = new Writable({write(_chunk, _encoding, callback) { callback() }})
  Object.assign(output, {isTTY: true, columns: 140, rows: 45})
  const screen = blessed.screen({input, output, terminal: 'xterm-256color', fullUnicode: true, smartCSR: false})
  const demo = createDemo()
  const dashboard = new Dashboard({...demo, ...override, screen, refresh: 0})
  t.after(() => { dashboard.close(); input.destroy(); output.destroy() })
  await dashboard.start()
  return {dashboard, screen, input, async key(value) { input.write(value); await delay(15) }}
}

test('keyboard opens pipeline apps and switches all app views', async t => {
  const {dashboard: d, key} = await harness(t)
  assert.equal(d.rows[0].kind, 'app')
  await key('\r')
  assert.equal(d.app.name, 'constellation-staging')
  for (let tab = 1; tab <= 7; tab++) {
    await key(String(tab))
    assert.equal(d.tab, tab - 1)
    assert.ok(d.rows.length)
  }
  await key('\x1b')
  await delay(50)
  assert.equal(d.app, null)
  assert.equal(d.rows[0].kind, 'app')
})

test('config reveal is scoped to selection and hidden on changing views', async t => {
  const {dashboard: d, key} = await harness(t)
  await key('\r')
  await key('4')
  assert.equal(d.config.EXAMPLE_SECRET, 'demo-only-value')
  assert.ok(!d.detail.content.includes('demo-only-value'))
  await key('v')
  assert.equal(d.revealed, 'EXAMPLE_SECRET')
  assert.ok(d.detail.content.includes('demo-only-value'))
  await key('j')
  assert.equal(d.revealed, null)
  assert.ok(!d.main.content.includes('demo-only-value'))
  await key('1')
  await key('4')
  assert.equal(d.revealed, null)
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

test('filter input receives shortcut letters without changing navigation', async t => {
  const {dashboard: d, key} = await harness(t)
  await key('/')
  assert.ok(d.modal)
  await key('constellation')
  assert.equal(d.mode, 'pipelines')
  assert.equal(d.closed, false)
  await key('\r')
  assert.equal(d.modal, null)
  assert.equal(d.filter, 'constellation')
  assert.equal(d.navItems.length, 1)
})

test('read-only action keys do not open mutation prompts', async t => {
  const {dashboard: d, key} = await harness(t)
  await key('\r')
  await key('2')
  await key('s')
  assert.equal(d.modal, undefined)
  assert.match(d.message, /Read-only/)
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

test('confirmed scaling sends exact app, process, count, and size to mocked API', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const writes = []
  demo.api.scale = async (...args) => { writes.push(args) }
  const {key} = await harness(t, demo)
  await key('\r')
  await key('2')
  await key('s')
  await key('\x15')
  await key('3')
  await key('\r')
  await key('\r')
  await key('constellation-staging')
  await key('\r')
  assert.deepEqual(writes, [['constellation-staging', 'web', 3, 'Standard-1X', 'constellation-staging']])
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

test('config editing masks typed secrets and requires app-name confirmation', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const writes = []
  demo.api.setConfig = async (...args) => { writes.push(args) }
  const {dashboard: d, screen, key} = await harness(t, demo)
  await key('\r')
  await key('4')
  await key('n')
  await key('NEW_SECRET')
  await key('\r')
  await key('never-display-this')
  const visible = screen.lines.map(line => line.map(cell => cell[1]).join('')).join('\n')
  assert.ok(!visible.includes('never-display-this'))
  await key('\r')
  assert.equal(writes.length, 0)
  await key('constellation-staging')
  await key('\r')
  assert.deepEqual(writes, [['constellation-staging', 'NEW_SECRET', 'never-display-this', 'constellation-staging']])
  assert.equal(d.modal, null)
})

test('config deletion and maintenance toggle target the confirmed app', async t => {
  const demo = createDemo()
  demo.api.readOnly = false
  const writes = []
  demo.api.setConfig = async (...args) => { writes.push(['config', ...args]) }
  demo.api.maintenance = async (...args) => { writes.push(['maintenance', ...args]) }
  const {key} = await harness(t, demo)
  await key('\r')
  await key('4')
  await key('d')
  await key('constellation-staging')
  await key('\r')
  await key('5')
  await key('m')
  await key('constellation-staging')
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
