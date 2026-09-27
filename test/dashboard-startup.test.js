import assert from 'node:assert/strict'
import {PassThrough, Writable} from 'node:stream'
import test from 'node:test'
import blessed from 'blessed'
import {Parser} from '@oclif/core'
import Dash from '../src/commands/dash.js'
import {createDemo} from '../src/demo.js'
import {runDashboard} from '../src/ui/dashboard.js'
import {palettes} from '../src/ui/theme.js'
import {ThemeInput} from '../src/ui/terminal-theme.js'

function terminal(t, response) {
  const source = new PassThrough()
  Object.assign(source, {isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value }})
  const input = new ThemeInput(source)
  const queried = Promise.withResolvers()
  const output = new Writable({write(chunk, _encoding, callback) {
    if (chunk.toString().includes('\x1b]11;?\x07')) {
      queried.resolve()
      if (response) queueMicrotask(() => source.write(response))
    }
    callback()
  }})
  Object.assign(output, {isTTY: true, columns: 120, rows: 36})
  const screen = blessed.screen({input, output, terminal: 'xterm-256color', fullUnicode: true})
  t.after(() => { screen.destroy(); input.destroy(); source.destroy(); output.destroy() })
  const ready = Promise.withResolvers()
  screen.on('render', () => {
    if (screen.children.some(child => child.content.includes('Pipeline loaded.'))) ready.resolve()
  })
  return {source, input, screen, queried: queried.promise, ready: ready.promise}
}

test('theme flag defaults to auto and validates explicit overrides', async () => {
  for (const theme of ['auto', 'light', 'dark']) {
    const args = theme === 'auto' ? [] : ['--theme', theme]
    const {flags} = await Parser.parse(args, {flags: Dash.flags})
    assert.equal(flags.theme, theme)
  }
  await assert.rejects(Parser.parse(['--theme', 'invalid'], {flags: Dash.flags}))
})

test('startup detects a light terminal before rendering and restores raw mode on exit', {timeout: 2000}, async t => {
  const io = terminal(t, '\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
  const running = runDashboard({...createDemo(), screen: io.screen, refresh: 0})
  await io.ready
  assert.equal(io.source.isRaw, true)
  const header = io.screen.children.find(child => child.content.includes('HEROKU DASH'))
  assert.equal(header.style.bg, palettes.light.panel)
  const main = io.screen.children.find(child => child.type === 'list' && child.items.some(item => item.content.includes('STAGING')))
  assert.equal(main.style.bg, palettes.light.bg)
  io.source.write('q')
  await running
  assert.equal(io.screen.destroyed, true)
  assert.equal(io.source.isRaw, false)
  assert.equal(io.input.listenerCount('background'), 0)
})

for (const partial of ['', '\x1b]11;rgb:ffff/']) test(`Ctrl-C cancels detection with ${partial ? 'a partial' : 'no'} terminal reply`, {timeout: 2000}, async t => {
  const io = terminal(t)
  const running = runDashboard({...createDemo(), screen: io.screen, refresh: 0})
  await io.queried
  io.source.write(partial + '\x03')
  await running
  assert.equal(io.screen.destroyed, true)
  assert.equal(io.source.isRaw, false)
  assert.equal(io.input.listenerCount('background'), 0)
  assert.ok(!io.screen.children.some(child => child.content.includes('HEROKU DASH')))
})
