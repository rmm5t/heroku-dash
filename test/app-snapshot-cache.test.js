import assert from 'node:assert/strict'
import test from 'node:test'
import {AppSnapshotCache} from '../src/app-snapshot-cache.js'

test('app snapshots expire without extending freshness on access and evict the least recently used app', () => {
  let now = 0
  const cache = new AppSnapshotCache({limit: 2, ttl: 100, now: () => now})
  const snapshot = id => ({app: {id}, formation: [], errors: {}})
  cache.set(snapshot('a'))
  cache.set(snapshot('b'))
  now = 50
  assert.equal(cache.get('a').app.id, 'a')
  cache.set(snapshot('c'))
  assert.equal(cache.get('b'), null)
  assert.equal(cache.entries.size, 2)
  now = 100
  assert.equal(cache.get('a'), null)
  assert.equal(cache.get('c').app.id, 'c')
  now = 150
  assert.equal(cache.get('c'), null)
})

test('cached snapshots are isolated from live mutations and incomplete reads cannot replace completed snapshots', () => {
  const cache = new AppSnapshotCache()
  const data = {app: {id: 'app'}, formation: [{type: 'web', quantity: 1}], errors: {}}
  cache.set(data)
  data.formation[0].quantity = 2
  const cached = cache.get('app')
  assert.equal(cached.formation[0].quantity, 1)
  cached.formation[0].quantity = 3
  cached.errors.hierarchy = 'Live breadcrumb warning'
  cache.set({...data, pending: ['dynos']})
  assert.equal(cache.get('app').formation[0].quantity, 1)
  assert.deepEqual(cache.get('app').errors, {})
})
