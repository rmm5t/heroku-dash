import assert from 'node:assert/strict'
import {PassThrough, Writable} from 'node:stream'
import {setTimeout as delay} from 'node:timers/promises'
import test from 'node:test'
import blessed from 'blessed'
import {createDemo} from '../src/demo.js'
import {Dashboard} from '../src/ui/dashboard.js'
import {clean} from '../src/ui/text.js'
import {icons, palette} from '../src/ui/theme.js'

const breadcrumbs = dashboard => clean(dashboard.header.content).split('\n')[1]
  .split(icons.chevron).map(part => part.trim().replace(/^\S+\s+/, ''))

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
