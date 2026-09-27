import {memoryUsage, metricProcesses, requestSeries, sparkline, summarizeSeries} from '../metrics.js'
import {clean, single} from './text.js'

const number = (value, compact = false) => Number.isFinite(value)
  ? new Intl.NumberFormat('en-US', {maximumFractionDigits: 2, ...(compact && value >= 10_000 ? {notation: 'compact'} : {})}).format(value) : '—'
const format = (value, unit, compact = false) => value === null || value === undefined ? '—'
  : unit === 'bytes' ? `${number(value / 1024 ** 2, compact)} MiB`
    : `${number(value, compact)}${unit ? ` ${compact && unit === 'req/min' ? 'rpm' : unit}` : ''}`
const field = (name, value) => `${name.padEnd(18)} ${value}`

export function telemetryRows(data, state = {}) {
  const snapshot = state.snapshot
  const rows = []
  const add = ({id, title, scope, metric, values = [], unit = '', errorKey, note, extra = () => []}) => {
    const stats = summarizeSeries(metric, values)
    const error = state.error ?? snapshot?.errors[errorKey]
    const stale = stats.time !== null && Date.now() - (stats.time + metric.stepMinutes * 60_000) > metric.stepMinutes * 120_000
    const status = error ? stats.count ? 'Stale' : 'Unavailable' : !snapshot ? 'Loading…' : !stats.count ? 'No samples' : stale ? 'Stale' : null
    const detail = [title, field('Scope', scope), '',
      ...(error ? [`Lookup failed: ${error}`, ''] : []),
      ...(stats.count ? [
        field('Latest', format(stats.latest, unit)),
        sparkline(values, 40), 'Oldest → newest; · marks gaps.',
        field('Sample end', new Date(stats.time + metric.stepMinutes * 60_000).toISOString()),
        field('Resolution', `${metric.stepMinutes} minute buckets`),
        ...(stale || error ? ['Stale: this is the last available sample, not current usage.'] : []),
        '',
        field('Sample start', new Date(stats.time).toISOString()),
        field('Minimum bucket', format(stats.min, unit)), field('Maximum bucket', format(stats.max, unit)),
        field('Mean of buckets', format(stats.mean, unit)), '',
      ] : [snapshot ? 'No samples available for this metric in the requested window. This is not a zero reading.' : 'Loading performance metrics…', '']),
      ...extra(stats), '',
      field('App', data.app.name), field('Source', 'api.metrics.heroku.com'),
      ...(metric ? [field('Window start', metric.startTime), field('Window end', metric.endTime),
        field('Coverage', `${stats.count} / ${metric.times.length} complete buckets`)] : []),
      ...(snapshot ? [field('Fetched', snapshot.fetchedAt)] : []),
      '', 'Sparkline bars average complete groups of buckets; gaps stay visible.', note,
    ].join('\n')
    rows.push({id: `telemetry:${id}`, label: single(`${title} · ${scope} · ${format(stats.latest, unit)}`), detail: clean(detail),
      icon: title.startsWith('Latency') ? 'clock' : 'metrics', tone: status === 'Stale' ? 'warning' : error ? 'error' : status ? 'muted' : 'info',
      columns: [title, scope, format(stats.latest, unit, true), status ?? sparkline(values, 12)], emphasis: status,
    })
  }

  const status = snapshot?.router.status
  const requests = requestSeries(status)
  add({id: 'throughput', title: 'Throughput', scope: 'HTTP', metric: status, values: requests.rpm, unit: 'req/min', errorKey: 'router.status',
    note: 'Request counts are divided by the response bucket duration.\nAverages use observed buckets only; missing traffic data is not assumed to be zero.',
    extra: stats => {
      const counts = summarizeSeries(status, requests.counts)
      const errors = summarizeSeries(status, requests.errors)
      return [field('Latest req/sec', stats.latest === null ? '—' : number(stats.latest / 60)),
        field('Observed requests', number(counts.sum)), field('Observed 5xx', number(errors.sum)),
        field('Observed 5xx rate', counts.sum > 0 ? `${number(errors.sum / counts.sum * 100)}%` : '—')]
    },
  })
  const latency = snapshot?.router.latency
  for (const percentile of ['p50', 'p95', 'p99']) {
    add({id: `latency:${percentile}`, title: `Latency ${percentile}`, scope: 'HTTP', metric: latency,
      values: latency?.series[`latency.ms.${percentile}`], unit: 'ms', errorKey: 'router.latency',
      note: 'Percentiles describe individual time buckets. The mean/min/max above summarize bucket percentiles; they are not whole-window request percentiles.',
      extra: stats => [field('Bucket max latency', format(stats.index === null ? null : latency.series['latency.ms.max']?.[stats.index], 'ms'))],
    })
  }
  for (const process of metricProcesses(data)) {
    const memory = snapshot?.processes[process.type]?.memory
    const usage = memoryUsage(memory)
    add({id: `memory:${process.type}`, title: 'Memory', scope: process.type, metric: memory, values: usage.values, unit: 'bytes', errorKey: `${process.type}.memory`,
      note: `Series: ${usage.key}\nMean usage is aggregated by process type, not summed across replicas.\nQuota and maxima refer to the same bucket as the displayed usage.`,
      extra: stats => {
        const at = key => stats.index === null ? null : memory.series[key]?.[stats.index]
        const quota = at('memory.quota.bytes.max')
        return [field('Quota (max)', format(quota, 'bytes')),
          field('Usage / quota', quota > 0 && stats.latest !== null ? `${number(stats.latest / quota * 100)}%` : '—'),
          field('RSS (max)', format(at('memory.rss.bytes.max'), 'bytes')),
          field('Swap (max)', format(at('memory.swap.bytes.max'), 'bytes')),
          field('Total (max)', format(at('memory.total.bytes.max'), 'bytes'))]
      },
    })
    const load = snapshot?.processes[process.type]?.load
    add({id: `load:${process.type}`, title: 'Dyno load', scope: process.type, metric: load,
      values: load?.series['load.avg.1m.mean'], errorKey: `${process.type}.load`,
      note: 'Mean one-minute load average for this process type: runnable CPU tasks.\nThis is not CPU utilization percent or the number of queued HTTP requests.\nCedar load averages are distinct from Fir CPU usage.',
      extra: stats => [field('Bucket load max', format(stats.index === null ? null : load.series['load.avg.1m.max']?.[stats.index], ''))],
    })
  }
  return rows
}
