import assert from 'node:assert/strict'
import {PassThrough, Writable} from 'node:stream'
import {setTimeout as delay} from 'node:timers/promises'
import test from 'node:test'
import blessed from 'blessed'
import {createCommandViewer} from '../src/ui/command-viewer.js'
import {createLogViewer} from '../src/ui/log-viewer.js'
import {clean} from '../src/ui/text.js'

function harness(t) {
  const input = new PassThrough()
  input.isTTY = true
  input.setRawMode = () => {}
  const output = new Writable({write(_chunk, _encoding, callback) { callback() }})
  Object.assign(output, {isTTY: true, columns: 140, rows: 45})
  const screen = blessed.screen({input, output, terminal: 'xterm-256color', fullUnicode: true, smartCSR: false})
  const previous = blessed.box({parent: screen, height: 3, width: 20})
  previous.focus()
  const statuses = []
  const owner = {screen, closed: false, render() { if (!owner.closed) screen.render() }}
  const dependencies = {owner, render: () => owner.render(), setStatus: (...args) => statuses.push(args)}
  const close = () => {
    owner.closed = true
    owner.modalLifecycle?.close({restoreFocus: false})
  }
  t.after(() => { close(); screen.destroy(); input.destroy(); output.destroy() })
  return {owner, previous, statuses, dependencies, close,
    async key(value) { input.write(value); await delay(15) },
  }
}

test('command viewers present nonzero exits and startup failures through injected dependencies', async t => {
  for (const outcome of ['nonzero', 'failed']) {
    const {owner, previous, statuses, dependencies, key} = harness(t)
    let options
    let closes = 0
    const args = ['logs', '--app', 'example-app']
    const viewer = createCommandViewer({...dependencies, appName: 'example-app', onClose: () => { closes++ },
      execute: async (argv, value) => {
        assert.equal(argv, args)
        options = value
        value.onOutput('\x1b[31mred output\x1b[0m\n\x1b]52;c;hidden-value\x07')
        if (outcome === 'failed') throw new Error('CLI could not start')
        return {code: 2, signal: null}
      },
    })
    await viewer.run(args, 'heroku logs --app example-app')
    assert.match(viewer.output.content, /\x1b\[31mred output\x1b\[0m/)
    assert.ok(!viewer.output.content.includes('hidden-value'))
    const content = viewer.modal.children.map(child => clean(child.content)).join('\n')
    assert.match(content, outcome === 'failed' ? /CLI could not start.*\n[\s\S]*Command failed to start/ : /Exited with code 2/)
    assert.equal(options.signal.aborted, false)
    assert.deepEqual(statuses, [])
    await key('q')
    assert.equal(owner.modal, null)
    assert.equal(owner.screen.focused, previous)
    assert.equal(options.signal.aborted, true)
    assert.equal(closes, 1)
    assert.deepEqual(statuses, [[`Heroku command exited with ${outcome === 'failed' ? 'error' : 'code 2'}.`, 'warning']])
    assert.equal(viewer.close(), false)
  }
})

test('log viewers resolve history scope when editing and release captured input on injected shutdown', async t => {
  const {owner, dependencies, close, key} = harness(t)
  const loaded = []
  const saved = []
  let scope = null
  let closes = 0
  let shutdowns = 0
  let options
  const viewer = createLogViewer({...dependencies, appName: 'example-app',
    history: {entries(value) { loaded.push(value); return [] }, add(...args) { saved.push(args) }},
    historyScope: () => scope, onClose: () => { closes++ },
    closeDashboard: () => { shutdowns++; close() },
    execute: async (_argv, value) => {
      options = value
      value.onOutput('INFO ready\nERROR failed\n')
      return {code: 0, signal: null}
    },
  })
  await viewer.run(['logs', '--tail', '--app', 'example-app'])
  await key('/')
  assert.equal(owner.screen.grabKeys, true)
  assert.deepEqual(loaded, [null])
  scope = 'pipeline:resolved'
  await key('ERROR')
  await key('\r')
  assert.deepEqual(saved, [['pipeline:resolved', 'ERROR']])
  assert.match(clean(viewer.output.content), /ERROR failed/)
  assert.ok(!clean(viewer.output.content).includes('INFO ready'))
  await key('/')
  assert.deepEqual(loaded, [null, 'pipeline:resolved'])
  await key('\x03')
  assert.equal(shutdowns, 1)
  assert.equal(closes, 1)
  assert.equal(owner.screen.grabKeys, false)
  assert.equal(owner.modal, null)
  assert.equal(options.signal.aborted, true)
  assert.equal(saved.length, 1)
  assert.equal(viewer.close(), false)
})
