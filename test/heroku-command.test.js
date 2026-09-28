import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import test from 'node:test'
import {executeHerokuCommand, executeInteractiveHerokuCommand, formatHerokuCommand, isInteractiveHerokuCommand, scopedHerokuCommand} from '../src/heroku-command.js'

test('custom command parsing preserves quoted arguments and forces the current app', () => {
  assert.deepEqual(scopedHerokuCommand('logs --num "100" --source app', 'exact-app'),
    ['logs', '--num', '100', '--source', 'app', '--app', 'exact-app'])
  assert.deepEqual(scopedHerokuCommand("heroku config:get 'LONG KEY'", 'exact-app'),
    ['config:get', 'LONG KEY', '--app', 'exact-app'])
  assert.equal(formatHerokuCommand(['config:get', 'LONG KEY', '--app', 'exact-app']),
    "heroku config:get 'LONG KEY' --app exact-app")
})

test('the app selector is inserted before passthrough and cannot be overridden', () => {
  assert.deepEqual(scopedHerokuCommand('run -- node script.js --app inside-dyno', 'exact-app'),
    ['run', '--app', 'exact-app', '--', 'node', 'script.js', '--app', 'inside-dyno'])
  for (const command of ['logs -a other', 'logs -aother', 'logs --app other', 'logs --app=other', 'logs -r prod', 'logs --remote=prod']) {
    assert.throws(() => scopedHerokuCommand(command, 'exact-app'), /selectors are not allowed/)
  }
  assert.throws(() => scopedHerokuCommand('heroku', 'exact-app'), /Enter a Heroku command/)
  assert.throws(() => scopedHerokuCommand('dash', 'exact-app'), /cannot be launched/)
  assert.throws(() => scopedHerokuCommand('logs "unfinished', 'exact-app'), /Unterminated/)
  assert.equal(isInteractiveHerokuCommand(['console', '--app', 'exact-app']), true)
  assert.equal(isInteractiveHerokuCommand(['run', 'console', '--app', 'exact-app']), true)
  assert.equal(isInteractiveHerokuCommand(['run', '--no-tty', 'rake', '--app', 'exact-app']), false)
  assert.equal(isInteractiveHerokuCommand(['logs', '--tail', '--app', 'exact-app']), false)
})

test('command execution uses argv without a shell, streams output, and supports cancellation', async () => {
  const calls = []
  const signals = []
  let child
  const spawnProcess = (command, args, options) => {
    child = new EventEmitter()
    child.pid = 4321
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => assert.fail('POSIX cancellation should terminate the process group')
    calls.push({command, args, options})
    return child
  }
  const output = []
  const controller = new AbortController()
  const running = executeHerokuCommand(['logs', '--app', 'exact-app'], {
    executable: '/bin/heroku', environment: {PATH: '/bin'}, platform: 'darwin', spawnProcess, signal: controller.signal,
    killProcess(pid, signal) { signals.push([pid, signal]); queueMicrotask(() => child.emit('close', null, signal)) },
    onOutput: chunk => output.push(chunk),
  })
  child.stdout.write('standard output\n')
  child.stderr.write('standard error\n')
  controller.abort()
  assert.deepEqual(await running, {code: null, signal: 'SIGTERM'})
  assert.deepEqual(signals, [[-4321, 'SIGTERM']])
  assert.equal(child.stdout.destroyed, true)
  assert.equal(child.stderr.destroyed, true)
  assert.deepEqual(output, ['standard output\n', 'standard error\n'])
  assert.equal(calls[0].command, '/bin/heroku')
  assert.deepEqual(calls[0].args, ['logs', '--app', 'exact-app'])
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.detached, true)
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(calls[0].options.env.NO_COLOR, undefined)
  assert.equal(calls[0].options.env.FORCE_COLOR, '1')
})

test('explicit color environment preferences are preserved', async () => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  let options
  const running = executeHerokuCommand(['logs'], {
    environment: {NO_COLOR: '1'}, spawnProcess(_command, _args, value) { options = value; queueMicrotask(() => child.emit('close', 0, null)); return child },
  })
  await running
  assert.equal(options.env.NO_COLOR, '1')
  assert.equal(options.env.FORCE_COLOR, undefined)
})

test('interactive command execution inherits the terminal and supports cancellation', async () => {
  const child = new EventEmitter()
  child.kill = signal => { queueMicrotask(() => child.emit('close', null, signal)); return true }
  let call
  const controller = new AbortController()
  const running = executeInteractiveHerokuCommand(['run', 'console', '--app', 'exact-app'], {
    executable: '/bin/heroku', environment: {PATH: '/bin'}, signal: controller.signal,
    spawnProcess(command, args, options) { call = {command, args, options}; return child },
  })
  controller.abort()
  assert.deepEqual(await running, {code: null, signal: 'SIGTERM'})
  assert.equal(call.command, '/bin/heroku')
  assert.deepEqual(call.args, ['run', 'console', '--app', 'exact-app'])
  assert.equal(call.options.shell, false)
  assert.equal(call.options.stdio, 'inherit')
  assert.deepEqual(call.options.env, {PATH: '/bin'})
})
