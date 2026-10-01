// Explicitly invoked integration check. The transport refuses every non-GET
// request, including when application code accidentally attempts a mutation.
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {resolve} from 'node:path'
import {promisify} from 'node:util'
import {HerokuAPI} from '../src/api.js'
import {inspectProject, resolveContext} from '../src/project.js'
import {appRows, TABS} from '../src/ui/views.js'

const directories = process.argv.slice(2)
if (!directories.length) throw new Error('Usage: npm run test:live -- /path/to/heroku/repository [...]')
const {stdout} = await promisify(execFile)('heroku', ['auth:token'], {encoding: 'utf8'})
const token = stdout.trim()
assert.ok(token, 'Heroku CLI returned an auth token')
let requests = 0
const api = new HerokuAPI({async request(path, options) {
  assert.equal(options.method, 'GET', 'Live checks may only send GET requests')
  assert.ok(path.startsWith('/') && !path.startsWith('//'))
  requests++
  const response = await fetch(`https://api.heroku.com${path}`, {
    method: 'GET', headers: {...options.headers, Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(30_000),
  })
  const body = await response.json()
  if (!response.ok) throw Object.assign(new Error(body.message ?? `HTTP ${response.status}`), {statusCode: response.status})
  return {body, headers: Object.fromEntries(response.headers)}
}}, {readOnly: true})
const catalog = await api.catalog()
assert.deepEqual(catalog.warnings, [])
console.log(`Catalog: ${catalog.teams.length} teams, ${catalog.pipelines.length} pipelines, ${catalog.apps.length} apps`)
for (const directory of directories) {
  const project = await inspectProject(resolve(directory))
  const context = await resolveContext(api, catalog, {}, project)
  assert.ok(context.pipeline, `Repository ${project.name} resolves to a pipeline`)
  const apps = await api.pipelineApps(context.pipeline.id)
  assert.ok(apps.length, 'Pipeline contains apps')
  assert.ok(apps.every(app => !app.loadError), 'All pipeline app details should load')
  console.log(`${project.name}: pipeline ${context.pipeline.name}, ${apps.length} apps (${context.reason})`)
  for (const app of apps) {
    const data = await api.appData(app.id)
    assert.deepEqual(data.errors, {}, `${app.name} sections should load`)
    const config = await api.config(app.id)
    for (const tab of TABS) assert.ok(appRows(tab, data, {config}).length)
    // Print counts only. No config keys, values, release descriptions, or URLs.
    console.log(`  ${app.name}: ${data.formation.length} process types, ${data.dynos.length} dynos, ${data.addons.length} add-ons, ${Object.keys(config).length} masked config vars; all 7 views rendered`)
  }
}
console.log(`PASS: ${requests} GET requests; zero remote writes.`)
