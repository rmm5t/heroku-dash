import assert from 'node:assert/strict'
import test from 'node:test'
import {ReadRequests} from '../src/read-requests.js'
import {runRead} from '../src/ui/read-operation.js'

function harness() {
  const events = []
  const loading = new Map()
  const owner = {closed: false, loading,
    beginLoading(key, label) {
      const operation = {label}
      loading.set(key, operation)
      return () => {
        events.push('loading-finished')
        if (loading.get(key) === operation) loading.delete(key)
      }
    },
  }
  owner.readRequests = new ReadRequests(() => !owner.closed)
  return {owner, events}
}

test('read operations distinguish successful empty values and release requests before cleanup', async () => {
  for (const value of [undefined, null, [], {}]) {
    const {owner, events} = harness()
    let signal
    const result = await runRead(owner, 'config', {
      label: 'Loading config',
      onStart: request => () => {
        assert.equal(request.current(), false)
        events.push('cleanup')
      },
      read: options => { signal = options.signal; return value },
      onSuccess: received => { assert.equal(received, value); events.push('success') },
      onFinish: () => events.push('finish'),
    })
    assert.deepEqual(result, {value})
    assert.equal(signal.aborted, false)
    assert.equal(owner.readRequests.requests.size, 0)
    assert.equal(owner.loading.size, 0)
    assert.deepEqual(events, ['success', 'finish', 'cleanup', 'loading-finished'])
  }
})

test('replacing a read settles canceled work and preserves the replacement indicator and callbacks', async () => {
  const {owner, events} = harness()
  const old = Promise.withResolvers()
  const next = Promise.withResolvers()
  let signal
  const obsolete = () => assert.fail('Canceled reads cannot apply, report errors, or finish the current view')
  const first = runRead(owner, 'config', {
    label: 'Old config',
    read: options => { signal = options.signal; return old.promise },
    onSuccess: obsolete, onError: obsolete, onFinish: obsolete,
    onStart: () => () => events.push('old-cleanup'),
  })
  const second = runRead(owner, 'config', {label: 'New config', read: () => next.promise})
  assert.equal(signal.aborted, true)
  assert.equal(await first, null)
  assert.equal(owner.loading.get('config').label, 'New config')
  assert.equal(owner.readRequests.has('config'), true)
  old.reject(new Error('Late old failure'))
  next.resolve({CURRENT: 'value'})
  assert.deepEqual(await second, {value: {CURRENT: 'value'}})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(owner.readRequests.requests.size, 0)
  assert.equal(owner.loading.size, 0)
  assert.deepEqual(events, ['old-cleanup', 'loading-finished', 'loading-finished'])
})

test('reads suppress results and errors after losing their context or dashboard ownership', async () => {
  for (const destination of ['context', 'shutdown']) {
    for (const outcome of ['success', 'failure']) {
      const {owner, events} = harness()
      const pending = Promise.withResolvers()
      let current = true
      const obsolete = () => assert.fail('Obsolete callbacks must not run')
      const operation = runRead(owner, 'resources', {
        label: 'Loading resources', isCurrent: () => current, read: () => pending.promise,
        onSuccess: obsolete, onError: obsolete, onFinish: obsolete,
        onStart: () => () => events.push('cleanup'),
      })
      if (destination === 'context') current = false
      else { owner.closed = true; owner.readRequests.cancelAll() }
      if (outcome === 'success') pending.resolve({formations: {}})
      else pending.reject(new Error('Late failure'))
      assert.equal(await operation, null)
      assert.deepEqual(events, ['cleanup', 'loading-finished'])
      assert.equal(owner.readRequests.requests.size, 0)
      assert.equal(owner.loading.size, 0)
    }
  }
})

test('current failures can be handled or propagated while always finishing loading and cleanup', async () => {
  for (const handled of [false, true]) {
    const {owner, events} = harness()
    const failure = new Error('Current read failed synchronously')
    const operation = runRead(owner, 'preparation', {
      label: 'Preparing action', read: () => { throw failure },
      onStart: () => () => events.push('cleanup'),
      onError: handled ? error => { assert.equal(error, failure); events.push('error') } : undefined,
      onFinish: () => events.push('finish'),
    })
    if (handled) assert.equal(await operation, null)
    else await assert.rejects(operation, error => error === failure)
    assert.deepEqual(events, [...(handled ? ['error'] : []), 'finish', 'cleanup', 'loading-finished'])
    assert.equal(owner.readRequests.requests.size, 0)
    assert.equal(owner.loading.size, 0)
  }
})

test('read cleanup and loading finalization still run if a view finalizer throws', async () => {
  const {owner, events} = harness()
  await assert.rejects(runRead(owner, 'config', {
    label: 'Loading config', read: () => ({}),
    onStart: () => () => events.push('cleanup'),
    onFinish: () => { throw new Error('View redraw failed') },
  }), /View redraw failed/)
  assert.deepEqual(events, ['cleanup', 'loading-finished'])
  assert.equal(owner.readRequests.requests.size, 0)
  assert.equal(owner.loading.size, 0)
})

test('inactive read scopes do not create loading indicators or start transport', async () => {
  const {owner} = harness()
  const obsolete = () => assert.fail('Inactive scopes must not start')
  assert.equal(await runRead(owner, 'config', {
    label: 'Loading config', isCurrent: () => false, read: obsolete,
    onStart: obsolete, onSuccess: obsolete, onError: obsolete, onFinish: obsolete,
  }), null)
  assert.equal(owner.readRequests.requests.size, 0)
  assert.equal(owner.loading.size, 0)
})
