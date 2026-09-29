import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {COMMAND_HISTORY_LIMIT, loadCommandHistory} from '../src/command-history.js'

test('command history persists privately, deduplicates entries, and keeps the newest commands', async t => {
  const root = await mkdtemp(join(tmpdir(), 'heroku-dash-history-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const history = await loadCommandHistory(root)
  assert.deepEqual(history.entries, [])
  await history.add(' logs --tail ')
  await history.add('config:get API_URL')
  await history.add('logs --tail')
  assert.deepEqual(history.entries, ['config:get API_URL', 'logs --tail'])

  const file = join(root, 'dash', 'command-history.json')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), history.entries)
  assert.equal((await stat(file)).mode & 0o777, 0o600)

  await writeFile(file, JSON.stringify(Array.from({length: COMMAND_HISTORY_LIMIT + 5}, (_, index) => `command ${index}`)))
  const limited = await loadCommandHistory(root)
  assert.equal(limited.entries.length, COMMAND_HISTORY_LIMIT)
  assert.equal(limited.entries[0], 'command 5')
})

test('invalid command history is ignored and replaced on the next command', async t => {
  const root = await mkdtemp(join(tmpdir(), 'heroku-dash-history-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  await mkdir(join(root, 'dash'))
  await writeFile(join(root, 'dash', 'command-history.json'), 'not json')
  const history = await loadCommandHistory(root)
  assert.deepEqual(history.entries, [])
  await history.add('logs')
  assert.deepEqual(JSON.parse(await readFile(join(root, 'dash', 'command-history.json'), 'utf8')), ['logs'])
})
