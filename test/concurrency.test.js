import assert from 'node:assert/strict'
import test from 'node:test'
import {mapConcurrent} from '../src/concurrency.js'

test('concurrent mapping refills free slots while preserving input order', async () => {
  const gates = Array.from({length: 5}, () => Promise.withResolvers())
  const started = []
  let active = 0
  let peak = 0
  const loading = mapConcurrent([0, 1, 2, 3, 4], async (value, index) => {
    assert.equal(index, value)
    started.push(value)
    peak = Math.max(peak, ++active)
    await gates[value].promise
    active--
    return value * 2
  }, {concurrency: 2})
  assert.deepEqual(started, [0, 1])
  // Keep the first job pending while the second worker drains the queue.
  for (const index of [1, 2, 3, 4]) {
    gates[index].resolve()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(started, Array.from({length: Math.min(index + 2, 5)}, (_, value) => value))
  }
  assert.equal(active, 1)
  gates[0].resolve()
  assert.deepEqual(await loading, [0, 2, 4, 6, 8])
  assert.equal(active, 0)
  assert.equal(peak, 2)
})

test('empty inputs and already-canceled queues never invoke the mapper', async () => {
  const action = () => assert.fail('No jobs should start')
  assert.deepEqual(await mapConcurrent([], action), [])
  const controller = new AbortController()
  controller.abort()
  const result = await mapConcurrent([1, 2], action, {signal: controller.signal})
  assert.equal(result.length, 2)
  assert.equal(Object.keys(result).length, 0)
})

test('cancellation stops queued jobs and leaves in-flight completion to the caller', async () => {
  const controller = new AbortController()
  const gates = [Promise.withResolvers(), Promise.withResolvers()]
  const started = []
  let settled = false
  const loading = mapConcurrent([0, 1, 2, 3], async value => {
    started.push(value)
    await gates[value].promise
    return `result-${value}`
  }, {concurrency: 2, signal: controller.signal})
  loading.then(() => { settled = true })
  controller.abort()
  gates[1].resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  assert.deepEqual(started, [0, 1])
  gates[0].resolve()
  const result = await loading
  assert.equal(result[0], 'result-0')
  assert.equal(result[1], 'result-1')
  assert.equal(result.length, 4)
  assert.deepEqual(Object.keys(result), ['0', '1'])
  assert.deepEqual(started, [0, 1])
})

test('mapper failures propagate while late failures from other workers are consumed', async () => {
  const first = Promise.withResolvers()
  const second = Promise.withResolvers()
  const failure = new Error('First job failed')
  const loading = mapConcurrent([first.promise, second.promise], promise => promise)
  const rejected = assert.rejects(loading, error => error === failure)
  first.reject(failure)
  await rejected
  second.reject(new Error('Later job failed'))
  await new Promise(resolve => setImmediate(resolve))
})

test('invalid concurrency cannot silently skip work or start a mapper', async () => {
  for (const concurrency of [0, -1, 1.5, NaN, Infinity, '4']) {
    await assert.rejects(mapConcurrent([1], () => assert.fail('Invalid concurrency must not start jobs'), {concurrency}), /positive integer/)
  }
})
