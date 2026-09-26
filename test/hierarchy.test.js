import assert from 'node:assert/strict'
import test from 'node:test'
import {resolveHierarchy} from '../src/hierarchy.js'

const team = {id: 'team-1', name: 'acme'}
const pipeline = {id: 'pipeline-1', name: 'service', owner: {type: 'team', id: team.id}}
const catalog = {teams: [team], pipelines: [pipeline]}

test('pipeline hierarchy enriches coupling references from the catalog without requests', async () => {
  const result = await resolveHierarchy({get() { assert.fail('Catalog has all parent metadata') }}, catalog, {
    pipeline: {id: pipeline.id, name: pipeline.name},
  })
  assert.deepEqual(result, {pipeline, team, errors: {}})
})

test('uncatalogued pipeline and team parents are fetched by ID', async () => {
  const paths = []
  const result = await resolveHierarchy({async get(path) {
    paths.push(path)
    return path.startsWith('/pipelines/') ? pipeline : team
  }}, {teams: [], pipelines: []}, {pipeline: {id: pipeline.id, name: pipeline.name}})
  assert.deepEqual(paths, ['/pipelines/pipeline-1', '/teams/team-1'])
  assert.deepEqual(result, {pipeline, team, errors: {}})
})

test('an app supplies its team directly, including for standalone apps', async () => {
  const api = {get() { assert.fail('App contains its team name') }}
  const app = {team}
  const result = await resolveHierarchy(api, {teams: [], pipelines: []}, {app, pipeline: {id: pipeline.id, name: pipeline.name}})
  assert.deepEqual(result.team, team)
  const standalone = await resolveHierarchy(api, catalog, {app})
  assert.equal(standalone.pipeline, null)
  assert.deepEqual(standalone.team, team)
})

test('personal ownership and inaccessible parent metadata have explicit labels', async () => {
  const personal = await resolveHierarchy({}, catalog, {app: {team: null}})
  assert.equal(personal.team.name, 'Personal')
  const result = await resolveHierarchy({async get() { throw {http: {statusCode: 403}} }}, {teams: [], pipelines: []}, {
    pipeline: {id: pipeline.id, name: pipeline.name},
  })
  assert.equal(result.team.name, 'Team unavailable')
  assert.equal(result.pipeline.name, pipeline.name)
  assert.match(result.errors.hierarchy, /permission/)
})
