import assert from 'node:assert/strict'
import test from 'node:test'
import {HerokuAPI} from '../src/api.js'
import {fetchTelemetry, memoryUsage, metricProcesses, metricsScope, METRICS_TIMEFRAMES, normalizeMetric, requestSeries, sparkline, summarizeSeries} from '../src/metrics.js'

const start = Date.parse('2026-09-26T10:00:00Z')
const window = {start, end: start + 30 * 60_000}
const body = data => ({start_time: new Date(start).toISOString(), end_time: new Date(window.end).toISOString(), step: 10, data})
const appData = () => ({app: {id: 'canonical-id', name: 'app-name', generation: {name: 'cedar'}},
  formation: [{type: 'web', quantity: 1, size: 'Standard-1X'}, {type: 'worker', quantity: 1, size: 'Basic'}, {type: 'release', quantity: 0, size: 'Basic'}],
  dynos: [{type: 'web'}, {type: 'worker'}, {type: 'run'}],
})
const reply = url => ({start_time: url.searchParams.get('start_time'), end_time: url.searchParams.get('end_time'),
  step: Number.parseInt(url.searchParams.get('step')) * (url.searchParams.get('step').endsWith('h') ? 60 : 1), data: {'200': [1, 2, 3]},
})

test('normalization uses minute steps, excludes incomplete buckets, and preserves missing samples', () => {
  const metric = normalizeMetric(body({value: [0, null, 30, 999]}), window)
  assert.deepEqual(metric.times, [start, start + 600_000, start + 1_200_000])
  assert.deepEqual(metric.series.value, [0, null, 30])
  const clipped = normalizeMetric(body({value: [0, 10, 20, 30]}), {start: start + 1, end: window.end - 1})
  assert.deepEqual(clipped.series.value, [10])
  assert.deepEqual(normalizeMetric(body({value: ['0', NaN, -1]}), window).series.value, [null, null, null])
  assert.throws(() => normalizeMetric({...body({}), step: 0}, window), /Unexpected response/)
  assert.throws(() => normalizeMetric(body({value: 'invalid'}), window), /Unexpected metric series/)
})

test('throughput divides counts by minutes and handles null categories without inventing traffic', () => {
  const metric = normalizeMetric(body({'200': [600, null, 0], '500': [60, null, null], total: [9999, 9999, 9999]}), window)
  assert.deepEqual(requestSeries(metric), {counts: [660, null, 0], rpm: [66, null, 0], errors: [60, null, 0]})
  const empty = normalizeMetric(body({}), window)
  assert.deepEqual(requestSeries(empty).rpm, [null, null, null])
  const grouped = normalizeMetric(body({status_2xx: [100, 200, 0], status_5xx: [10, 0, 0]}), window)
  assert.deepEqual(requestSeries(grouped).rpm, [11, 20, 0])
  grouped.series['200'] = [50, 50, 50]
  assert.deepEqual(requestSeries(grouped).counts, [50, 50, 50], 'Grouped and detailed series must not be summed together')
})

test('series summaries retain zero, skip gaps, and memory falls back only to reported usage', () => {
  const metric = normalizeMetric(body({value: [3, null, 0]}), window)
  const stats = summarizeSeries(metric, metric.series.value)
  assert.equal(stats.latest, 0)
  assert.equal(stats.index, 2)
  assert.equal(stats.time, start + 1_200_000)
  assert.equal(stats.mean, 1.5)
  assert.equal(stats.count, 2)
  assert.equal(summarizeSeries(metric, [null, null]).latest, null)
  assert.equal(summarizeSeries(metric, []).sum, null)
  const memory = normalizeMetric(body({'memory.used.bytes.mean': [12, 13, 14], 'memory.quota.bytes.max': [100, 100, 100]}), window)
  assert.equal(memoryUsage(memory).key, 'memory.used.bytes.mean')
  delete memory.series['memory.used.bytes.mean']
  assert.deepEqual(memoryUsage(memory).values, [], 'Quota alone is not usage')
})

test('sparklines preserve gaps, zero values, and constant nonzero readings', () => {
  assert.equal(sparkline([0, 0, 0]), '▁▁▁')
  assert.equal(sparkline([2, 2]), '▄▄')
  assert.equal(sparkline([1, 2, null, 4, 5, 6], 3), '▁·█')
  assert.equal(sparkline([null, null]), 'No samples')
})

test('telemetry uses canonical IDs, GET-only access, process_type, and tier-aware resolution', async () => {
  const requests = []
  const api = new HerokuAPI({async request(path, options) {
    const url = new URL(path)
    requests.push({url, options})
    assert.equal(options.method, 'GET')
    assert.equal(options.retryAuth, false)
    assert.equal(url.origin, 'https://api.metrics.heroku.com')
    assert.ok(url.pathname.startsWith('/apps/canonical-id/'))
    assert.equal(url.pathname.includes('app-name'), false)
    assert.ok(url.searchParams.get('process_type'))
    return {body: reply(url)}
  }}, {readOnly: true})
  const data = appData()
  const result = await fetchTelemetry(api, data, {now: window.end + 45_000})
  assert.deepEqual(result.errors, {})
  assert.equal(requests.length, 6)
  assert.equal(result.processes.worker.memory.stepMinutes, 10)
  assert.equal(result.processes.web.memory.stepMinutes, 1)
  assert.equal(result.router.status.stepMinutes, 1)
  assert.deepEqual(metricProcesses(data).map(p => p.type), ['web', 'worker'])
  assert.equal(result.processes.release, undefined)
})

for (const timeframe of METRICS_TIMEFRAMES) test(`${timeframe.label} requests the full range at Heroku's documented resolution`, async () => {
  const data = appData()
  data.formation = [{type: 'web', quantity: 1, size: 'Standard-1X'}]
  const now = Date.parse('2026-09-30T12:34:45Z')
  const expectedEnd = Math.floor(now / (timeframe.stepMinutes * 60_000)) * timeframe.stepMinutes * 60_000
  const count = timeframe.hours * 60 / timeframe.stepMinutes
  const result = await fetchTelemetry({async get(path) {
    const url = new URL(path)
    assert.equal(Date.parse(url.searchParams.get('end_time')), expectedEnd)
    assert.equal(Date.parse(url.searchParams.get('start_time')), expectedEnd - timeframe.hours * 60 * 60_000)
    assert.equal(url.searchParams.get('step'), timeframe.stepMinutes >= 60 ? `${timeframe.stepMinutes / 60}h` : `${timeframe.stepMinutes}m`)
    return {...reply(url), data: {'200': Array.from({length: count + 1}, (_, index) => index)}}
  }}, data, {now, windowHours: timeframe.hours})
  assert.equal(result.windowHours, timeframe.hours)
  assert.equal(result.router.status.stepMinutes, timeframe.stepMinutes)
  assert.equal(result.router.status.times.length, count)
  assert.equal(result.router.status.times.at(-1), expectedEnd - timeframe.stepMinutes * 60_000)
  assert.equal(result.router.status.series['200'].at(-1), count - 1)
  assert.deepEqual(result.errors, {})
})

test('longer windows respect Basic retention and cache scopes include the timeframe', async () => {
  const data = appData()
  const paths = []
  const api = {async get(path) { paths.push(path); return reply(new URL(path)) }}
  const day = await fetchTelemetry(api, data, {windowHours: 24})
  assert.equal(day.processes.worker.memory.stepMinutes, 10)
  paths.length = 0
  const week = await fetchTelemetry(api, data, {windowHours: 168})
  assert.ok(paths.every(path => !path.includes('/formation/worker/')))
  assert.match(week.errors['worker.memory'], /24 hours/)
  assert.equal(week.processes.worker.memory, null)
  assert.equal(week.processes.web.memory.stepMinutes, 120)
  assert.notEqual(metricsScope(data, 2), metricsScope(data, 24))
  await assert.rejects(fetchTelemetry({get() { assert.fail('Invalid timeframe reached transport') }}, data, {windowHours: 12}), /Metrics timeframe/)
})

test('unsupported resolution falls back once and failures are isolated by metric', async () => {
  const data = appData()
  data.formation = data.formation.slice(0, 1)
  const calls = []
  const result = await fetchTelemetry({async get(path) {
    const url = new URL(path)
    calls.push(url)
    if (url.pathname.endsWith('/latency')) throw {statusCode: 403}
    if (url.pathname.endsWith('/memory') && url.searchParams.get('step') === '1m') throw {statusCode: 400}
    return reply(url)
  }}, data, {now: window.end})
  assert.equal(calls.filter(url => url.pathname.endsWith('/memory')).length, 2)
  assert.equal(result.processes.web.memory.stepMinutes, 10)
  assert.ok(result.processes.web.load)
  assert.ok(result.router.status)
  assert.match(result.errors['router.latency'], /permission/)
})

test('Eco and Fir load restrictions produce explicit unavailable reasons', async () => {
  const data = appData()
  data.formation = [{type: 'web', quantity: 1, size: 'Eco'}]
  const eco = await fetchTelemetry({get() { assert.fail('Eco metrics must not be requested') }}, data)
  assert.match(eco.errors['router.status'], /Eco/)
  assert.match(eco.errors['web.memory'], /Eco/)
  data.app.generation.name = 'fir'
  data.formation[0].size = 'dyno-1c-0.5gb'
  const fir = await fetchTelemetry({async get(path) {
    assert.ok(!path.includes('/metrics/load'))
    return reply(new URL(path))
  }}, data)
  assert.match(fir.errors['web.load'], /Fir/)
  assert.ok(fir.processes.web.memory)
})

test('requests are bounded and cancellation or rate limits stop queued work', async () => {
  const data = appData()
  const controller = new AbortController()
  let calls = 0
  const loading = fetchTelemetry({get(_path, {signal}) {
    calls++
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), {once: true}))
  }}, data, {signal: controller.signal})
  assert.equal(calls, 4)
  controller.abort()
  await loading
  assert.equal(calls, 4)
  calls = 0
  const limited = await fetchTelemetry({async get() { calls++; throw {statusCode: 429, headers: {'retry-after': '90'}} }}, data)
  assert.equal(calls, 4)
  assert.equal(Object.keys(limited.errors).length, 6)
  assert.ok(Object.values(limited.errors).every(message => message.includes('rate limit')))
  assert.equal(Object.keys(limited.failures).length, 4)
  assert.ok(Object.values(limited.failures).every(failure => failure.statusCode === 429 && failure.retryAfterMs === 90_000))
})

test('rate limits annotate queued metrics while preserving successful in-flight results', async () => {
  const calls = []
  const loading = fetchTelemetry({get(path) {
    const pending = Promise.withResolvers()
    calls.push({url: new URL(path), ...pending})
    return pending.promise
  }}, appData())
  assert.equal(calls.length, 4)
  calls[0].reject({statusCode: 429, headers: {'retry-after': '90'}})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 4)
  for (const call of calls.slice(1).reverse()) call.resolve(reply(call.url))
  const result = await loading
  assert.ok(result.router.latency)
  assert.ok(result.processes.web.memory)
  assert.ok(result.processes.web.load)
  assert.equal(result.router.status, null)
  assert.equal(result.processes.worker.memory, null)
  assert.equal(result.processes.worker.load, null)
  assert.deepEqual(Object.keys(result.errors).sort(), ['router.status', 'worker.load', 'worker.memory'])
  assert.ok(Object.values(result.errors).every(message => message.includes('rate limit')))
  assert.deepEqual(result.failures, {'router.status': {statusCode: 429, retryAfterMs: 90_000}})
})
