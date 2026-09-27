import {errorMessage, statusCode} from './api.js'

export const METRICS_HOST = 'https://api.metrics.heroku.com'
export const METRICS_WINDOW_MS = 2 * 60 * 60_000
const MINUTE = 60_000
const sample = value => Number.isFinite(value) && value >= 0 ? value : null

export function metricProcesses(data) {
  const running = new Set(data.dynos.map(dyno => dyno.type))
  return data.formation.filter(process => process.type === 'web' || process.quantity > 0 || running.has(process.type))
    .map(({type, size}) => ({type, size})).sort((a, b) => a.type.localeCompare(b.type))
}

export function metricsScope(data) {
  return JSON.stringify([data.app.id, data.app.generation?.name, metricProcesses(data)])
}

export function normalizeMetric(body, window) {
  const start = Date.parse(body?.start_time)
  const end = Date.parse(body?.end_time)
  const step = body?.step
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !Number.isFinite(step) || step <= 0
    || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    throw new Error('Unexpected response from the Heroku Metrics API.')
  }
  const interval = step * MINUTE // The response step is in minutes, not seconds.
  const first = Math.max(0, Math.ceil((window.start - start) / interval))
  const last = Math.floor((Math.min(end, window.end) - start) / interval)
  // The service includes a point at end_time. Exclude that bucket, and any
  // partially overlapping first bucket, rather than presenting partial counts.
  const indices = Array.from({length: Math.min(1200, Math.max(0, last - first))}, (_, i) => first + i)
  const series = Object.fromEntries(Object.entries(body.data).map(([key, values]) => {
    if (!Array.isArray(values)) throw new Error('Unexpected metric series from the Heroku Metrics API.')
    return [key, indices.map(index => sample(values[index]))]
  }))
  return {
    startTime: new Date(window.start).toISOString(), endTime: new Date(window.end).toISOString(),
    stepMinutes: step, times: indices.map(index => start + index * interval), series,
  }
}

export async function fetchTelemetry(api, data, {now = Date.now(), signal} = {}) {
  if (!data.app.id) throw new Error('An app ID is required to fetch performance metrics.')
  const processes = metricProcesses(data)
  const result = {
    appId: data.app.id, fetchedAt: new Date(now).toISOString(), windowHours: 2,
    router: {status: null, latency: null},
    processes: Object.fromEntries(processes.map(process => [process.type, {memory: null, load: null}])),
    errors: {},
  }
  const jobs = []
  const add = (key, route, process, target, field) => {
    if (process?.size === 'Eco') {
      result.errors[key] = 'Heroku application metrics are not available for Eco dynos.'
      return
    }
    if (field === 'load' && data.app.generation?.name === 'fir') {
      result.errors[key] = 'Dyno load averages apply to Cedar apps. Fir CPU usage is not supplied by this load endpoint.'
      return
    }
    jobs.push({key, route, process: process?.type ?? 'web', target, field,
      step: ['Basic', 'Hobby'].includes(process?.size) ? 10 : 1})
  }
  const base = `/apps/${encodeURIComponent(data.app.id)}`
  const web = data.formation.find(process => process.type === 'web')
  add('router.status', `${base}/router-metrics/status`, web, result.router, 'status')
  add('router.latency', `${base}/router-metrics/latency`, web, result.router, 'latency')
  for (const process of processes) {
    for (const metric of ['memory', 'load']) {
      add(`${process.type}.${metric}`, `${base}/formation/${encodeURIComponent(process.type)}/metrics/${metric}`,
        process, result.processes[process.type], metric)
    }
  }
  let next = 0
  let rateLimit = null
  const load = async (job, step) => {
    const end = Math.floor(now / (step * MINUTE)) * step * MINUTE
    const window = {start: end - METRICS_WINDOW_MS, end}
    const query = new URLSearchParams({start_time: new Date(window.start).toISOString(), end_time: new Date(end).toISOString(),
      step: `${step}m`, process_type: job.process})
    // process_type is required even on the formation routes. Names can return
    // empty data for existing apps, so routes always use the canonical app ID.
    const body = await api.get(`${METRICS_HOST}${job.route}?${query}`, {method: 'GET', retryAuth: false, timeout: 15_000, signal})
    return normalizeMetric(body, window)
  }
  await Promise.all(Array.from({length: Math.min(4, jobs.length)}, async () => {
    while (next < jobs.length && !signal?.aborted) {
      const job = jobs[next++]
      if (rateLimit) { result.errors[job.key] = rateLimit; continue }
      try {
        try { job.target[job.field] = await load(job, job.step) }
        catch (error) {
          // Some app tiers only accept the coarser resolution.
          if (job.step !== 1 || statusCode(error) !== 400 || signal?.aborted) throw error
          job.target[job.field] = await load(job, 10)
        }
      } catch (error) {
        if (signal?.aborted) return
        result.errors[job.key] = errorMessage(error)
        if (statusCode(error) === 429) rateLimit = result.errors[job.key]
      }
    }
  }))
  return result
}

export function summarizeSeries(metric, values = []) {
  const valid = values.map((value, index) => ({value: sample(value), index})).filter(point => point.value !== null)
  if (!valid.length) return {count: 0, latest: null, index: null, time: null, min: null, max: null, mean: null, sum: null}
  const last = valid.at(-1)
  const sum = valid.reduce((total, point) => total + point.value, 0)
  return {count: valid.length, latest: last.value, index: last.index, time: metric.times[last.index],
    min: Math.min(...valid.map(point => point.value)), max: Math.max(...valid.map(point => point.value)), mean: sum / valid.length, sum}
}

export function requestSeries(metric) {
  if (!metric) return {counts: [], rpm: [], errors: []}
  // Accept individual HTTP codes and the grouped keys used by some versions
  // of the service, without counting both representations twice.
  const keys = Object.keys(metric.series)
  const detailed = keys.filter(key => /^[1-5]\d\d$/.test(key))
  const selected = detailed.length ? detailed : keys.filter(key => /^status_[1-5]xx$/.test(key))
  const counts = metric.times.map((_, index) => {
    const values = selected.map(key => metric.series[key][index]).filter(value => sample(value) !== null)
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null
  })
  const errors = counts.map((count, index) => count === null ? null : selected.filter(key => /^(5|status_5)/.test(key))
    .reduce((sum, key) => sum + (sample(metric.series[key][index]) ?? 0), 0))
  return {counts, errors, rpm: counts.map(count => count === null ? null : count / metric.stepMinutes)}
}

export function memoryUsage(metric) {
  const keys = ['memory.swap-plus-rss.bytes.mean', 'memory.used.bytes.mean']
  const key = keys.find(name => metric?.series[name]?.some(value => sample(value) !== null)) ?? keys[0]
  return {key, values: metric?.series[key] ?? []}
}

export function sparkline(values, width = 40) {
  if (!values.length || !values.some(value => sample(value) !== null)) return 'No samples'
  const length = Math.min(width, values.length)
  const reduced = Array.from({length}, (_, i) => {
    const group = values.slice(Math.floor(i * values.length / length), Math.floor((i + 1) * values.length / length))
    // A gap remains visible even when several source buckets share one glyph.
    return group.some(value => sample(value) === null) ? null : group.reduce((sum, value) => sum + value, 0) / group.length
  })
  const valid = reduced.filter(value => value !== null)
  const min = Math.min(...valid)
  const max = Math.max(...valid)
  const bars = '▁▂▃▄▅▆▇█'
  return reduced.map(value => value === null ? '·' : bars[max === min ? max === 0 ? 0 : 3 : Math.round((value - min) / (max - min) * 7)]).join('')
}
