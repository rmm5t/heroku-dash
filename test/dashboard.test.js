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
  assert.ok(!clean(d.footer.content).includes('C console'))
  assert.ok(!clean(d.footer.content).includes('Esc back'))
  await key('\r')
  assert.equal(d.app.name, 'constellation-staging')
  assert.ok(clean(d.footer.content).includes(': command'))
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
  assert.match(d.modal.children.map(child => child.content).join('\n'), /Continue \(y\)/)
  assert.match(d.modal.children.map(child => child.content).join('\n'), /Cancel \(n\)/)
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
  await key('\x1b[A')
  assert.equal(input.getValue(), 'logs --tail')
  await key('\x1b[A')
  assert.equal(input.getValue(), 'config:get API_URL')
  await key('\x1b[B')
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
  assert.ok(!d.modal.children.some(child => child.content === 'Continue (y)'))
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
  const proceed = d.modal.children.find(child => child.content === 'Continue (y)')
  const cancel = d.modal.children.find(child => child.content === 'Cancel (n)')
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
  const clickCancel = d.modal.children.find(child => child.content === 'Cancel (n)')
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
