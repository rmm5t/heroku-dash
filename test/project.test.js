import assert from 'node:assert/strict'
import test from 'node:test'
import {parseRemotes, resolveContext, uniquePipeline} from '../src/project.js'

const pipelines = [{id: 'p1', name: 'example-app'}, {id: 'p2', name: 'other-app'}]
const catalog = {pipelines}
const api = {
  async get(path) { return {id: path.split('/').at(-1), name: path.split('/').at(-1)} },
  async coupling(app) { return {pipeline: pipelines[app.startsWith('other-app') ? 1 : 0]} },
}

test('recognizes HTTPS, SSH, and account alias Heroku remotes; deduplicates fetch/push', () => {
  assert.deepEqual(parseRemotes('origin git@github.com:org/repo.git (fetch)\nproduction https://git.heroku.com/example-app-production.git (fetch)\nproduction https://git.heroku.com/example-app-production.git (push)\nstaging git@heroku.com:example-app-staging.git (fetch)\nalias git@heroku.personal:personal-app.git (fetch)\nssh ssh://git@git.heroku.com/ssh-app.git (fetch)'), [
    {remote: 'production', app: 'example-app-production'}, {remote: 'staging', app: 'example-app-staging'},
    {remote: 'alias', app: 'personal-app'}, {remote: 'ssh', app: 'ssh-app'},
  ])
})

test('multiple remotes in the same pipeline default to pipeline overview', async () => {
  const result = await resolveContext(api, catalog, {}, {name: 'unrelated', remotes: [{app: 'example-app-production'}, {app: 'example-app-staging'}]})
  assert.equal(result.pipeline.id, 'p1')
  assert.equal(result.app, undefined)
})

test('ambiguous remotes do not silently select production or a directory-name match', async () => {
  const result = await resolveContext(api, catalog, {}, {name: 'example-app', remotes: [{app: 'example-app-production'}, {app: 'other-app-production'}]})
  assert.equal(result.pipeline, undefined)
  assert.match(result.reason, /multiple pipelines/)
})

test('directory name fallback works without Heroku remotes', async () => {
  assert.equal((await resolveContext(api, catalog, {}, {name: 'example-app'})).pipeline.id, 'p1')
  assert.equal((await resolveContext(api, catalog, {}, {})).pipeline, undefined)
})

test('explicit app, remote, pipeline, and team override auto-detection', async () => {
  const project = {name: 'example-app', remotes: [{remote: 'staging', app: 'other-app-staging'}]}
  assert.equal((await resolveContext(api, catalog, {pipeline: 'other-app'}, project)).pipeline.id, 'p2')
  assert.equal((await resolveContext(api, catalog, {app: 'example-app-production'}, project)).app.name, 'example-app-production')
  assert.equal((await resolveContext(api, catalog, {remote: 'staging'}, project)).app.name, 'other-app-staging')
  assert.equal((await resolveContext(api, catalog, {team: 'team'}, project)).pipeline, undefined)
  await assert.rejects(resolveContext(api, catalog, {remote: 'missing'}, project), /No Heroku Git remote/)
})

test('duplicate pipeline names require IDs', () => {
  const duplicates = [...pipelines, {id: 'p3', name: 'example-app'}]
  assert.throws(() => uniquePipeline(duplicates, 'example-app'), /Multiple pipelines/)
  assert.equal(uniquePipeline(duplicates, 'p3').id, 'p3')
})

test('inaccessible remote produces a warning and permits directory fallback', async () => {
  const result = await resolveContext({async get() { throw new Error('Forbidden') }}, catalog, {}, {name: 'example-app', remotes: [{remote: 'old', app: 'old-app'}]})
  assert.equal(result.pipeline.id, 'p1')
  assert.match(result.warnings[0], /old: Forbidden/)
})
