import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {loadLogFilterHistory, LOG_FILTER_HISTORY_LIMIT} from '../src/log-filter-history.js'

test('log-filter history persists per scope, deduplicates searches, and preserves significant spaces', async t => {
  const root = await mkdtemp(join(tmpdir(), 'heroku-dash-log-history-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const history = await loadLogFilterHistory(root)
  assert.deepEqual(history.entries('pipeline:first'), [])
  await history.add('pipeline:first', 'error|warn')
  await history.add('pipeline:first', ' status=5\\d{2} ')
  await history.add('pipeline:second', 'worker')
  await history.add('pipeline:first', 'error|warn')
  await history.add('pipeline:first', '   ')
  await history.add(null, 'unknown pipeline')
  await history.add('app:first', 'standalone')

  const restored = await loadLogFilterHistory(root)
  assert.deepEqual(restored.entries('pipeline:first'), [' status=5\\d{2} ', 'error|warn'])
  assert.deepEqual(restored.entries('pipeline:second'), ['worker'])
  assert.deepEqual(restored.entries('app:first'), ['standalone'])
  assert.deepEqual(restored.entries('app:second'), [])
  const file = join(root, 'dash', 'log-filter-history.json')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    'pipeline:first': [' status=5\\d{2} ', 'error|warn'], 'pipeline:second': ['worker'], 'app:first': ['standalone'],
  })
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal((await stat(join(root, 'dash'))).mode & 0o777, 0o700)
})

test('log-filter history validates stored entries and independently bounds each scope on load and add', async t => {
  const root = await mkdtemp(join(tmpdir(), 'heroku-dash-log-history-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  await mkdir(join(root, 'dash'))
  const file = join(root, 'dash', 'log-filter-history.json')
  await writeFile(file, JSON.stringify({
    'pipeline:first': [null, 42, '', ' ', ...Array.from({length: LOG_FILTER_HISTORY_LIMIT + 5}, (_, index) => `search ${index}`)],
    'pipeline:second': ['second'], 'pipeline:invalid': {entries: ['invalid']},
  }))
  const history = await loadLogFilterHistory(root)
  assert.equal(history.entries('pipeline:first').length, LOG_FILTER_HISTORY_LIMIT)
  assert.equal(history.entries('pipeline:first')[0], 'search 5')
  assert.deepEqual(history.entries('pipeline:invalid'), [])
  await history.add('pipeline:first', 'newest')
  assert.equal(history.entries('pipeline:first').length, LOG_FILTER_HISTORY_LIMIT)
  assert.equal(history.entries('pipeline:first')[0], 'search 6')
  assert.equal(history.entries('pipeline:first').at(-1), 'newest')
  const restored = await loadLogFilterHistory(root)
  assert.deepEqual(restored.entries('pipeline:first'), history.entries('pipeline:first'))
  assert.deepEqual(restored.entries('pipeline:second'), ['second'])
})

test('invalid log-filter history is ignored and storage failures retain usable in-memory history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'heroku-dash-log-history-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  await mkdir(join(root, 'dash'))
  const file = join(root, 'dash', 'log-filter-history.json')
  for (const content of ['not json', 'null', '["unscoped"]']) {
    await writeFile(file, content)
    const history = await loadLogFilterHistory(root)
    assert.deepEqual(history.entries('pipeline:first'), [])
    await history.add('pipeline:first', 'error')
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {'pipeline:first': ['error']})
  }
  await rm(join(root, 'dash'), {recursive: true})
  await writeFile(join(root, 'dash'), 'not a directory')
  const history = await loadLogFilterHistory(root)
  await history.add('pipeline:first', 'error')
  assert.deepEqual(history.entries('pipeline:first'), ['error'])
})
