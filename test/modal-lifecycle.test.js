import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import test from 'node:test'
import {ModalLifecycle} from '../src/ui/modal-lifecycle.js'

function harness() {
  const events = []
  const previous = {focus() { events.push('focus') }}
  const owner = {screen: {focused: previous, destroyed: false}, closed: false,
    render() { events.push('render') }}
  const widget = () => {
    const modal = new EventEmitter()
    modal.destroy = () => { events.push('destroy'); modal.destroyed = true; modal.emit('destroy') }
    return modal
  }
  return {owner, events, widget}
}

test('modal closing releases ownership before re-entrant cleanup and settles only once', () => {
  const {owner, events, widget} = harness()
  const modal = widget()
  const results = []
  const lifecycle = new ModalLifecycle(owner, modal, {onClose: result => results.push(result)})
  lifecycle.addCleanup(() => {
    assert.equal(owner.modal, null)
    assert.equal(owner.modalLifecycle, null)
    assert.equal(lifecycle.close({value: 're-entrant'}), false)
    events.push('cleanup')
  })
  assert.equal(owner.modal, modal)
  assert.equal(lifecycle.close({value: 'submitted'}), true)
  assert.equal(lifecycle.close(), false)
  assert.deepEqual(events, ['cleanup', 'destroy', 'focus', 'render'])
  assert.deepEqual(results, [{value: 'submitted', restoreFocus: true}])
  assert.equal(modal.listenerCount('destroy'), 0)
})

test('closing an older modal cannot clear, redraw, or steal focus from its replacement', () => {
  const {owner, events, widget} = harness()
  const results = []
  const old = new ModalLifecycle(owner, widget(), {onClose: result => results.push(result)})
  const replacement = new ModalLifecycle(owner, widget())
  old.close()
  assert.equal(owner.modal, replacement.modal)
  assert.equal(owner.modalLifecycle, replacement)
  assert.equal(replacement.closed, false)
  assert.deepEqual(events, ['destroy'])
  assert.deepEqual(results, [{value: null, restoreFocus: false}])
  replacement.close()
})

test('external widget destruction runs modal cleanup without destroying twice or restoring focus', () => {
  const {owner, events, widget} = harness()
  const modal = widget()
  const lifecycle = new ModalLifecycle(owner, modal)
  lifecycle.addCleanup(() => events.push('cleanup'))
  modal.destroy()
  assert.equal(lifecycle.closed, true)
  assert.equal(owner.modal, null)
  assert.equal(owner.modalLifecycle, null)
  assert.equal(lifecycle.close(), false)
  assert.deepEqual(events, ['destroy', 'cleanup', 'render'])
})

test('modal cleanup supports batched closing and suppresses focus and rendering during shutdown', () => {
  for (const mode of ['batched', 'dashboard-closed', 'screen-destroyed', 'focus-destroyed']) {
    const {owner, events, widget} = harness()
    const lifecycle = new ModalLifecycle(owner, widget())
    lifecycle.addCleanup(() => events.push('cleanup'))
    if (mode === 'dashboard-closed') owner.closed = true
    if (mode === 'screen-destroyed') owner.screen.destroyed = true
    if (mode === 'focus-destroyed') owner.screen.focused.destroyed = true
    lifecycle.close(mode === 'batched' ? {restoreFocus: false, render: false} : {})
    assert.deepEqual(events, mode === 'focus-destroyed' ? ['cleanup', 'destroy', 'render'] : ['cleanup', 'destroy'])
    assert.equal(owner.modal, null)
    assert.equal(owner.modalLifecycle, null)
  }
})
