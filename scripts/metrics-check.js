// Opt-in telemetry integration check. No app settings, features, logs, or
// deployments are changed; the transport accepts only GET requests.
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {HerokuAPI} from '../src/api.js'
import {fetchTelemetry, memoryUsage, requestSeries, summarizeSeries} from '../src/metrics.js'
import {appRows} from '../src/ui/views.js'

const names = process.argv.slice(2)
if (!names.length) throw new Error('Usage: npm run test:metrics -- APP [APP...]')
const {stdout} = await promisify(execFile)('heroku', ['auth:token'])
const token = stdout.trim()
assert.ok(token)
let requests = 0
const api = new HerokuAPI({async request(path, options) {
  assert.equal(options.method, 'GET', 'Live checks may only send GET requests')
  const url = new URL(path, 'https://api.heroku.com')
  assert.equal(url.protocol, 'https:')
  assert.ok(['api.heroku.com', 'api.metrics.heroku.com'].includes(url.hostname))
  requests++
  const response = await fetch(url, {method: 'GET', redirect: 'error', headers: {...options.headers, Authorization: `Bearer ${token}`},
    signal: AbortSignal.timeout(options.timeout ?? 30_000)})
  const body = await response.json()
  if (!response.ok) throw Object.assign(new Error(body.message ?? `HTTP ${response.status}`), {statusCode: response.status})
  return {body, headers: Object.fromEntries(response.headers)}
}}, {readOnly: true})
for (const name of names) {
  const data = await api.appData(name)
  assert.ok(data.app.id)
  const snapshot = await fetchTelemetry(api, data)
  assert.equal(snapshot.appId, data.app.id)
  assert.deepEqual(snapshot.errors, {}, `${name}: metrics should be accessible for this check`)
  const throughput = summarizeSeries(snapshot.router.status, requestSeries(snapshot.router.status).rpm)
  const latency = summarizeSeries(snapshot.router.latency, snapshot.router.latency?.series['latency.ms.p95'])
  const rows = appRows('Metrics', data, {metrics: {snapshot}})
  assert.ok(rows.some(row => row.id === 'telemetry:throughput'))
  console.log(`PASS ${name}: ${throughput.count} throughput buckets, ${latency.count} p95 buckets`)
  for (const [type, metrics] of Object.entries(snapshot.processes)) {
    const memory = summarizeSeries(metrics.memory, memoryUsage(metrics.memory).values)
    const load = summarizeSeries(metrics.load, metrics.load?.series['load.avg.1m.mean'])
    console.log(`  ${type}: ${memory.count} memory buckets, ${load.count} load buckets; ${metrics.memory?.stepMinutes ?? '?'} minute resolution`)
  }
}
console.log(`${requests} GET requests; zero remote writes.`)
