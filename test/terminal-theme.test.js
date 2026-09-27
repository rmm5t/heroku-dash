import assert from 'node:assert/strict'
import {PassThrough, Writable} from 'node:stream'
import {setImmediate as tick} from 'node:timers/promises'
import test from 'node:test'
import {detectTerminalTheme, environmentTheme, ThemeInput, themeForBackground} from '../src/ui/terminal-theme.js'

function terminal(t) {
  const source = new PassThrough()
  Object.assign(source, {isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value }})
  const input = new ThemeInput(source)
  const writes = []
  const output = new Writable({write(chunk, _encoding, callback) { writes.push(chunk.toString()); callback() }})
  output.isTTY = true
  const forwarded = []
  input.on('data', chunk => forwarded.push(chunk))
  t.after(() => { input.destroy(); source.destroy(); output.destroy() })
  return {source, input, output, writes, text: () => Buffer.concat(forwarded).toString(),
    detect: options => detectTerminalTheme({input, output, env: {}, ...options})}
}

test('background detection normalizes RGB channel widths and uses luminance', () => {
  for (const value of ['rgb:f/f/f', 'rgb:ff/ff/ff', 'rgb:fff/fff/fff', 'rgb:ffff/ffff/ffff', 'rgb:FFFF/EEEE/DDDD', '#ffffff', '#ffff00']) {
    assert.equal(themeForBackground(value), 'light', value)
  }
  for (const value of ['rgb:0/0/0', 'rgb:00/00/00', 'rgb:000/000/000', 'rgb:1616/1b1b/2222', '#000000', '#0000ff']) {
    assert.equal(themeForBackground(value), 'dark', value)
  }
  for (const value of ['', '?', 'white', 'rgb:zz/ff/ff', 'rgb:fffff/0/0', 'rgb:ff/ff', '#fffzzz']) {
    assert.equal(themeForBackground(value), null, value)
  }
})

test('COLORFGBG fallback recognizes ANSI and 256-color backgrounds', () => {
  for (const COLORFGBG of ['0;15', '0;7', '0;default;15', '0;231', '0;255']) assert.equal(environmentTheme({COLORFGBG}), 'light')
  for (const COLORFGBG of ['15;0', '15;default;0', '15;232', '15;235', '', '15', '0;', '0;999', '0;light', '0;-1']) {
    assert.equal(environmentTheme({COLORFGBG}), 'dark')
  }
  assert.equal(environmentTheme({}), 'dark')
})

test('reported background takes precedence over COLORFGBG and is not forwarded as input', async t => {
  const terminalIO = terminal(t)
  const detected = terminalIO.detect({env: {COLORFGBG: '15;0'}})
  terminalIO.source.write('\x1b]11;rgb:ffff/ffff/ffff\x07')
  assert.equal(await detected, 'light')
  assert.deepEqual(terminalIO.writes, ['\x1b]11;?\x07'])
  assert.equal(terminalIO.text(), '')
  assert.equal(terminalIO.input.listenerCount('background'), 0)
})

test('fragmented background replies preserve neighboring navigation and Unicode input', async t => {
  const terminalIO = terminal(t)
  const detected = terminalIO.detect()
  const before = '\x1b[Aé🔑'
  const after = '\tvg'
  const bytes = Buffer.from(`${before}\x1b]11;rgb:ffff/eeee/dddd\x1b\\${after}`)
  for (const byte of bytes) terminalIO.source.write(Buffer.from([byte]))
  assert.equal(await detected, 'light')
  await tick()
  assert.equal(terminalIO.text(), before + after)
})

test('malformed and oversized replies are discarded before accepting a valid background', async t => {
  const terminalIO = terminal(t)
  const detected = terminalIO.detect()
  terminalIO.source.write(`\x1b]11;invalid\x07\x1b]11;${'x'.repeat(1000)}\x1b\\`)
  terminalIO.source.write('j\x1b]11;rgb:0000/0000/0000\x07k')
  assert.equal(await detected, 'dark')
  await tick()
  assert.equal(terminalIO.text(), 'jk')
})

test('timeout falls back promptly and late replies never become keybindings', async t => {
  t.mock.timers.enable({apis: ['setTimeout']})
  const terminalIO = terminal(t)
  const detected = terminalIO.detect({env: {COLORFGBG: '0;15'}})
  t.mock.timers.tick(200)
  assert.equal(await detected, 'light')
  assert.equal(terminalIO.input.listenerCount('background'), 0)
  terminalIO.source.write('\x1b]11;rgb:1111/2222/3333\x07j')
  await tick()
  assert.equal(terminalIO.text(), 'j')
})

test('a partial reply remains filtered across the detection timeout', async t => {
  t.mock.timers.enable({apis: ['setTimeout']})
  const terminalIO = terminal(t)
  const detected = terminalIO.detect()
  terminalIO.source.write('\x1b]11;rgb:ffff/')
  await tick()
  t.mock.timers.tick(200)
  assert.equal(await detected, 'dark')
  terminalIO.source.write('ffff/ffff\x1b\\q')
  await tick()
  assert.equal(terminalIO.text(), 'q')
})

test('Escape is released as a key and raw-mode changes reach the original terminal', async t => {
  t.mock.timers.enable({apis: ['setTimeout']})
  const terminalIO = terminal(t)
  terminalIO.input.setRawMode(true)
  assert.equal(terminalIO.source.isRaw, true)
  assert.equal(terminalIO.input.isRaw, true)
  terminalIO.source.write('\x1b')
  await tick()
  t.mock.timers.tick(50)
  assert.equal(terminalIO.text(), '\x1b')
  terminalIO.input.setRawMode(false)
  assert.equal(terminalIO.source.isRaw, false)
  terminalIO.input.destroy()
  assert.equal(terminalIO.source.listenerCount('data'), 0)
  assert.equal(terminalIO.source.destroyed, false)
})

test('explicit themes bypass terminal queries and environment hints', async t => {
  const terminalIO = terminal(t)
  assert.equal(await terminalIO.detect({theme: 'light', env: {COLORFGBG: '15;0'}}), 'light')
  assert.equal(await terminalIO.detect({theme: 'dark', env: {COLORFGBG: '0;15'}}), 'dark')
  assert.deepEqual(terminalIO.writes, [])
  await assert.rejects(terminalIO.detect({theme: 'invalid'}), /Unknown theme/)
})

test('non-TTY, dumb, and unfiltered terminals use the environment without querying', async t => {
  const terminalIO = terminal(t)
  terminalIO.output.isTTY = false
  assert.equal(await terminalIO.detect({env: {COLORFGBG: '0;15'}}), 'light')
  terminalIO.output.isTTY = true
  terminalIO.input.isTTY = false
  assert.equal(await terminalIO.detect(), 'dark')
  terminalIO.input.isTTY = true
  assert.equal(await terminalIO.detect({env: {TERM: 'dumb', COLORFGBG: '0;15'}}), 'light')
  assert.equal(await terminalIO.detect({input: terminalIO.source}), 'dark')
  assert.deepEqual(terminalIO.writes, [])
})

test('cancellation and unavailable terminal output clean up the pending query', async t => {
  const terminalIO = terminal(t)
  const controller = new AbortController()
  const detected = terminalIO.detect({signal: controller.signal})
  controller.abort()
  assert.equal(await detected, 'dark')
  assert.equal(terminalIO.input.listenerCount('background'), 0)
  const unavailable = terminalIO.detect({env: {COLORFGBG: '0;15'}})
  terminalIO.output.emit('error', new Error('Terminal unavailable'))
  assert.equal(await unavailable, 'light')
  assert.equal(terminalIO.output.listenerCount('error'), 0)
})
