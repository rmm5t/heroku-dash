import assert from 'node:assert/strict'
import {PassThrough, Writable} from 'node:stream'
import {setTimeout as delay} from 'node:timers/promises'
import test from 'node:test'
import blessed from 'blessed'
import {Parser} from '@oclif/core'
import Dash from '../src/commands/dash.js'
import {createDemo} from '../src/demo.js'
import {runDashboard} from '../src/ui/dashboard.js'
import {palettes} from '../src/ui/theme.js'
import {ThemeInput} from '../src/ui/terminal-theme.js'

function dashEnvironment(t, values = {}) {
  const names = ['HEROKU_DASH_TEAM', 'HEROKU_DASH_PIPELINE', 'HEROKU_DASH_REFRESH']
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  const apply = values => {
    for (const name of names) {
      if (values[name] === undefined) delete process.env[name]
      else process.env[name] = values[name]
    }
  }
  apply(values)
  t.after(() => apply(previous))
  return apply
}

const parseOptions = argv => new Dash(argv, {bin: 'heroku', runHook: async () => ({successes: []})}).parseOptions()

function terminal(t, response) {
  const source = new PassThrough()
  Object.assign(source, {isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value }})
  const input = new ThemeInput(source)
  const queried = Promise.withResolvers()
  const writes = []
  const output = new Writable({write(chunk, _encoding, callback) {
    const text = chunk.toString()
    writes.push(text)
    if (text.includes('\x1b]11;?\x07')) {
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
  return {source, input, screen, writes, queried: queried.promise, ready: ready.promise}
}

test('theme flag defaults to auto and validates explicit overrides', async t => {
  dashEnvironment(t)
  for (const theme of ['auto', 'light', 'dark']) {
    const args = theme === 'auto' ? [] : ['--theme', theme]
    const {flags} = await Parser.parse(args, {flags: Dash.flags})
    assert.equal(flags.theme, theme)
  }
  await assert.rejects(Parser.parse(['--theme', 'invalid'], {flags: Dash.flags}))
})

test('Dash environment variables supply team, pipeline, and refresh options', async t => {
  const setEnv = dashEnvironment(t, {HEROKU_DASH_TEAM: 'env-team', HEROKU_DASH_REFRESH: '120'})
  const teamFlags = (await parseOptions([])).flags
  assert.equal(teamFlags.team, 'env-team')
  assert.equal(teamFlags.pipeline, undefined)
  assert.equal(teamFlags.refresh, 120)
  setEnv({HEROKU_DASH_PIPELINE: 'env-pipeline', HEROKU_DASH_REFRESH: '0'})
  const pipelineFlags = (await parseOptions([])).flags
  assert.equal(pipelineFlags.pipeline, 'env-pipeline')
  assert.equal(pipelineFlags.team, undefined)
  assert.equal(pipelineFlags.refresh, 0)
})

test('explicit context options override all environment context choices, including short and attached flags', async t => {
  dashEnvironment(t, {HEROKU_DASH_TEAM: 'env-team', HEROKU_DASH_PIPELINE: 'env-pipeline', HEROKU_DASH_REFRESH: '120'})
  for (const [argv, name, value] of [
    [['--team', 'cli-team'], 'team', 'cli-team'],
    [['-tcli-team'], 'team', 'cli-team'],
    [['--pipeline=cli-pipeline'], 'pipeline', 'cli-pipeline'],
    [['-p', 'cli-pipeline'], 'pipeline', 'cli-pipeline'],
    [['--app', 'cli-app'], 'app', 'cli-app'],
    [['-acli-app'], 'app', 'cli-app'],
    [['--remote=staging'], 'remote', 'staging'],
    [['-r', 'staging'], 'remote', 'staging'],
  ]) {
    const {flags} = await parseOptions(argv)
    for (const context of ['app', 'pipeline', 'remote', 'team']) assert.equal(flags[context], context === name ? value : undefined)
    assert.equal(flags.refresh, 120)
  }
  assert.equal(process.env.HEROKU_DASH_TEAM, 'env-team')
  assert.equal(process.env.HEROKU_DASH_PIPELINE, 'env-pipeline')
})

test('explicit refresh options override environment values, including zero and invalid defaults', async t => {
  const setEnv = dashEnvironment(t, {HEROKU_DASH_TEAM: 'env-team', HEROKU_DASH_REFRESH: '120'})
  assert.equal((await parseOptions(['--refresh', '0'])).flags.refresh, 0)
  assert.equal((await parseOptions(['--refresh=90'])).flags.refresh, 90)
  setEnv({HEROKU_DASH_REFRESH: 'not-an-integer'})
  assert.equal((await parseOptions(['--refresh', '60'])).flags.refresh, 60)
})

test('environment options retain integer, interval, and context exclusivity validation', async t => {
  const setEnv = dashEnvironment(t)
  for (const value of ['not-an-integer', '1.5', '-1', '5']) {
    setEnv({HEROKU_DASH_REFRESH: value})
    await assert.rejects(parseOptions([]), /refresh|integer/i)
  }
  setEnv({HEROKU_DASH_TEAM: 'env-team', HEROKU_DASH_PIPELINE: 'env-pipeline'})
  await assert.rejects(parseOptions([]), /cannot also be provided/)
  await assert.rejects(parseOptions(['--team', 'cli-team', '--pipeline', 'cli-pipeline']), /cannot also be provided/)
})

test('unset or empty Dash environment variables retain built-in defaults', async t => {
  const setEnv = dashEnvironment(t)
  assert.equal((await parseOptions([])).flags.refresh, 60)
  setEnv({HEROKU_DASH_TEAM: '', HEROKU_DASH_PIPELINE: '', HEROKU_DASH_REFRESH: ''})
  const {flags} = await parseOptions([])
  assert.equal(flags.team, undefined)
  assert.equal(flags.pipeline, undefined)
  assert.equal(flags.refresh, 60)
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

test('interactive commands release and restore the filtered terminal input', {timeout: 3000}, async t => {
  const io = terminal(t, '\x1b]11;rgb:0000/0000/0000\x07')
  const demo = createDemo()
  demo.api.readOnly = false
  const started = Promise.withResolvers()
  const finished = Promise.withResolvers()
  let clearsAtStart
  const running = runDashboard({...demo, screen: io.screen, refresh: 0, executeInteractiveHeroku: async args => {
    assert.deepEqual(args, ['console', '--app', 'constellation-staging'])
    assert.equal(io.source.isRaw, false)
    assert.equal(io.source.listenerCount('data'), 0)
    assert.match(io.writes.join(''), /\x1b\[\?1003l/)
    clearsAtStart = io.writes.join('').split('\x1b[H\x1b[2J').length - 1
    assert.ok(clearsAtStart > 0)
    started.resolve()
    await finished.promise
    return {code: 0, signal: null}
  }})
  await io.ready
  const key = async value => { io.source.write(value); await delay(20) }
  await key('\r')
  await key(':')
  await key('console')
  await key('\r')
  io.writes.length = 0
  await key('\r')
  await started.promise
  // Resolving the child models the process close emitted after EOF/Ctrl-D.
  finished.resolve()
  await delay(30)
  assert.equal(io.source.isRaw, true)
  assert.ok(io.source.listenerCount('data') > 0)
  assert.ok(io.writes.join('').split('\x1b[H\x1b[2J').length - 1 > clearsAtStart)
  await key('q')
  await running
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
