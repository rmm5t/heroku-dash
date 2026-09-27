import assert from 'node:assert/strict'
import test from 'node:test'
import blessed from 'blessed'
import {chartModel, metricChartLines, metricDetailContent} from '../src/ui/metric-chart.js'
import {metricNumber, metricValue} from '../src/ui/metric-format.js'
import {summarizeSeries} from '../src/metrics.js'
import {clean} from '../src/ui/text.js'

function chart(values, options = {}) {
  const start = Date.parse('2026-09-26T23:00:00Z')
  const metric = {startTime: new Date(start).toISOString(), endTime: new Date(start + values.length * 60_000).toISOString(),
    stepMinutes: 1, times: values.map((_, i) => start + i * 60_000)}
  return {title: 'Throughput', scope: 'HTTP', unit: 'req/min', metric, values,
    stats: summarizeSeries(metric, values), state: 'Recent', details: 'Source: api.metrics.heroku.com', ...options}
}

test('dense chart columns retain peaks and ranges rather than flattening them into averages', () => {
  const model = chartModel(chart([1, 99, 2, 4]), 2, 6)
  assert.equal(model.bins[0].mean, 50)
  assert.equal(model.bins[0].min, 1)
  assert.equal(model.bins[0].max, 99)
  assert.ok(model.upper >= 99)
  assert.equal(model.latest.value, 4)
  assert.equal(model.latest.x, 1)
})

test('missing and partial buckets remain distinct from measured zero', () => {
  const model = chartModel(chart([0, null, 10, null]), 4, 5)
  assert.equal(model.bins[0].mean, 0)
  assert.equal(model.bins[0].complete, true)
  assert.equal(model.bins[1].mean, null)
  assert.equal(model.bins[1].complete, false)
  assert.equal(model.latest.x, 2, 'The last sample belongs before the trailing gap')
  const partial = chartModel(chart([2, null, 4, 6]), 2, 5)
  assert.equal(partial.bins[0].mean, 2)
  assert.equal(partial.bins[0].complete, false)
  assert.equal(chartModel(chart([null, null]), 10, 5), null)
})

test('coarse buckets occupy their actual time ranges including a missing window prefix', () => {
  const input = chart([10, 20])
  const start = Date.parse(input.metric.startTime)
  input.metric = {...input.metric, stepMinutes: 10, endTime: new Date(start + 30 * 60_000).toISOString(), times: [start + 10 * 60_000, start + 20 * 60_000]}
  const model = chartModel(input, 6, 5)
  assert.deepEqual(model.bins.map(bin => bin.mean), [null, null, 10, 10, 20, 20])
  assert.equal(model.latest.x, 5)
})

test('memory axes use MiB, include changing quotas, and identify an over-quota latest value', () => {
  const mb = 1024 ** 2
  const input = chart([128 * mb, 768 * mb], {unit: 'bytes', reference: {label: 'Quota', values: [256 * mb, 512 * mb], tone: 'warning', limit: true}})
  const model = chartModel(input, 2, 6)
  assert.deepEqual(model.bins.map(bin => bin.reference), [256, 512])
  assert.equal(model.latest.value, 768)
  assert.equal(model.latest.aboveLimit, true)
  assert.ok(model.upper >= 768)
  assert.match(clean(metricChartLines(input).join('\n')), /MiB/)
})

test('percentile guides average matching buckets while maximum guides retain maxima', () => {
  const input = chart([10, 20], {reference: {label: 'p50', values: [2, 8], aggregation: 'mean', tone: 'info'}})
  assert.equal(chartModel(input, 1, 5).bins[0].reference, 5)
  input.reference.aggregation = 'max'
  assert.equal(chartModel(input, 1, 5).bins[0].reference, 8)
})

test('constant and tiny values have a valid scale and do not get reported as zero', () => {
  assert.equal(chartModel(chart([0, 0]), 10, 5).upper, 1)
  assert.ok(chartModel(chart([5, 5]), 10, 5).upper >= 5)
  assert.equal(metricNumber(0.00004), '0.00004')
  assert.equal(metricValue(0, 'bytes'), '0 MiB')
  assert.equal(metricValue(null, 'bytes'), '—')
  const tiny = chart([0.00003, 0.00004], {unit: ''})
  assert.equal(chartModel(tiny, 10, 5).upper, 0.00004)
  assert.match(clean(metricChartLines(tiny)[0]), /^\s*0\.00004\s+│/)
})

test('exact decimal scale boundaries are stable across magnitudes', () => {
  for (const value of [1e-12, 1.5e-8, 2e-7, 2.5e-6, 0.00003, 0.00004, 0.00006, 0.00008, 0.0001, 0.0015, 0.025, 0.3, 0.6, 1, 1.5, 2.5, 40, 600, 2500, 4e12]) {
    assert.equal(chartModel(chart([value]), 10, 5).upper, value, `Exact boundary ${value}`)
  }
})

test('values above a scale boundary still round the axis upward without rounding the data', () => {
  for (const [value, expected] of [[0.000039, 0.00004], [0.00004000000000000001, 0.00005], [0.000041, 0.00005], [0.1501, 0.2], [2.5001, 3], [600.01, 800]]) {
    const model = chartModel(chart([value]), 10, 5)
    assert.equal(model.upper, expected)
    assert.ok(model.upper >= value)
    assert.equal(model.latest.value, value)
  }
})

test('scale boundaries stay positive and finite at numeric extremes', () => {
  for (const value of [Number.MIN_VALUE, 1e-323, 1e-308, 1e308, Number.MAX_VALUE]) {
    const model = chartModel(chart([value]), 10, 5)
    assert.ok(Number.isFinite(model.upper))
    assert.ok(model.upper >= value)
    assert.ok(model.upper > 0)
  }
})

test('chart lines fit narrow and wide panes and show UTC times across midnight', () => {
  const input = chart(Array.from({length: 120}, (_, i) => i))
  for (const width of [24, 50, 88, 140]) {
    const lines = metricChartLines(input, {width, height: 6}).map(clean)
    assert.equal(lines.length, 8)
    assert.ok(lines.every(line => blessed.unicode.strWidth(line) <= width))
    assert.match(lines.at(-1), /UTC.*23:00.*01:00/)
  }
  const content = clean(metricDetailContent(input, {width: 88, height: 16}))
  assert.match(content, /LATEST/)
  assert.match(content, /MIN/)
  assert.match(content, /MAX/)
  assert.match(content, /samples \(100%\)/)
  const empty = clean(metricDetailContent(chart([null, null], {state: 'No samples', details: 'No usable measurements.'})))
  assert.match(empty, /NO SAMPLES/)
  assert.ok(!empty.includes('└'), 'No-data states must not draw a zero-valued plot')
})
