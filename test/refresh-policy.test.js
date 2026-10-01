import assert from 'node:assert/strict'
import test from 'node:test'
import {autoRefreshSections, RefreshBackoff} from '../src/refresh-policy.js'

test('automatic refresh reuses fresh metadata, retries failed sections, and refreshes metadata at five minutes', () => {
  const data = {errors: {}, sectionFetchedAt: Object.fromEntries(['coupling', 'addons', 'attachments', 'domains', 'buildpacks'].map(key => [key, 0]))}
  assert.deepEqual(autoRefreshSections(data, 299_999), ['app', 'formation', 'dynos', 'releases'])
  data.errors.domains = 'Unavailable'
  assert.ok(autoRefreshSections(data, 299_999).includes('domains'))
  assert.equal(autoRefreshSections(data, 300_000).length, 9)
  delete data.sectionFetchedAt.buildpacks
  assert.ok(autoRefreshSections(data, 0).includes('buildpacks'))
})

test('consecutive refresh failures back off exponentially, cap at five minutes, and reset on recovery', () => {
  let now = 0
  const policy = new RefreshBackoff({interval: 10_000, now: () => now})
  assert.equal(policy.record('app', [{}]), 10_000)
  now = 10_000
  assert.equal(policy.remaining, 0)
  assert.equal(policy.record('app', [{}]), 20_000)
  for (let i = 0; i < 10; i++) policy.record('app', [{}])
  assert.equal(policy.remaining, 300_000)
  assert.equal(policy.record('app', []), 0)
  assert.equal(policy.record('app', [{}]), 10_000)
})

test('rate-limit cooldowns respect Retry-After and healthy reads cannot clear another API source cooldown', () => {
  let now = 0
  const policy = new RefreshBackoff({interval: 10_000, now: () => now})
  assert.equal(policy.record('metrics', [{statusCode: 429, retryAfterMs: 600_000}]), 600_000)
  assert.equal(policy.record('app', []), 600_000)
  now = 600_000
  assert.equal(policy.remaining, 0)
  policy.record('metrics', [])
  assert.equal(policy.record('app', [{statusCode: 429}]), 60_000)
})
