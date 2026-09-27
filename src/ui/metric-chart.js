import {cell} from './columns.js'
import {metricNumber, metricValue} from './metric-format.js'
import {clean, single} from './text.js'
import {paint} from './theme.js'

const valid = value => Number.isFinite(value) && value >= 0

function ceiling(value) {
  if (value <= 0) return 1
  // Decimal parsing rounds each boundary once. Multiplying by 10 ** exponent
  // can put an exact boundary one ULP below the input on some Node versions
  // (e.g. 4 * 10 ** -5 on Node 22), incorrectly advancing to the next step.
  const exponent = value.toExponential().split('e')[1]
  const upper = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
    .map(step => Number(`${step}e${exponent}`)).find(boundary => boundary >= value)
  return Number.isFinite(upper) ? upper : value
}

// Preserve bucket timing: coarse samples occupy their actual time interval;
// dense samples are grouped by their midpoint, retaining their min/max range.
export function chartModel(chart, width, height) {
  const {metric, values, unit, reference} = chart
  const start = Date.parse(metric?.startTime)
  const end = Date.parse(metric?.endTime)
  if (!metric || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || !values.some(valid)) return null
  width = Math.max(1, Math.floor(width))
  height = Math.max(2, Math.floor(height))
  const factor = unit === 'bytes' ? 1024 ** 2 : 1
  const primary = values.filter(valid)
  const refValues = reference?.values?.filter(valid) ?? []
  const maximum = Math.max(...primary, ...refValues) / factor
  const upper = ceiling(maximum)
  const interval = metric.stepMinutes * 60_000
  const duration = (end - start) / width
  const bins = Array.from({length: width}, (_, x) => {
    const from = start + x * duration
    const to = from + duration
    const indices = []
    for (const [index, time] of metric.times.entries()) {
      if (interval >= duration ? time <= (from + to) / 2 && (from + to) / 2 < time + interval
        : time + interval / 2 >= from && time + interval / 2 < to) indices.push(index)
    }
    const samples = indices.map(index => values[index]).filter(valid)
    const refs = indices.map(index => reference?.values?.[index]).filter(valid)
    return {
      mean: samples.length ? samples.reduce((sum, value) => sum + value / samples.length, 0) / factor : null,
      min: samples.length ? Math.min(...samples) / factor : null,
      max: samples.length ? Math.max(...samples) / factor : null,
      complete: indices.length > 0 && samples.length === indices.length,
      reference: refs.length ? (reference.aggregation === 'mean' ? refs.reduce((sum, value) => sum + value / refs.length, 0) : Math.max(...refs)) / factor : null,
    }
  })
  const index = values.findLastIndex(valid)
  const x = Math.max(0, Math.min(width - 1, Math.floor((metric.times[index] + interval / 2 - start) / (end - start) * width)))
  return {bins, upper, factor, width, height, start, end, hasReference: refValues.length > 0,
    latest: {x, value: values[index] / factor, aboveLimit: reference?.limit && valid(reference.values?.[index]) && values[index] > reference.values[index]}}
}

function plotRows(model, tone, reference) {
  const {width, height, upper, bins, latest} = model
  const middle = Math.floor((height - 1) / 2)
  const ticks = new Set([0, middle, height - 1])
  const grid = Array.from({length: height}, (_, y) => Array.from({length: width}, () => ({ch: ticks.has(y) ? '┄' : ' ', tone: 'border'})))
  const y = value => Math.max(0, Math.min(height - 1, Math.round((1 - value / upper) * (height - 1))))
  for (const [x, bin] of bins.entries()) {
    if (bin.mean !== null) {
      const level = y(bin.mean)
      if (bin.complete) for (let row = level + 1; row < height; row++) grid[row][x] = {ch: '░', tone: 'loadingDim'}
      for (let row = y(bin.max); row <= y(bin.min); row++) grid[row][x] = {ch: '│', tone: bin.complete ? tone : 'muted'}
      grid[level][x] = {ch: bin.complete ? '━' : '○', tone: bin.complete ? tone : 'muted'}
    }
    if (bin.reference !== null) grid[y(bin.reference)][x] = {ch: '┄', tone: reference.tone}
    if (!bin.complete) grid[height - 1][x] = {ch: '·', tone: 'muted'}
  }
  grid[y(latest.value)][latest.x] = {ch: '◆', tone: latest.aboveLimit ? 'error' : 'fg'}
  return grid.map(row => {
    const runs = []
    for (const point of row) {
      const last = runs.at(-1)
      if (last?.tone === point.tone) last.text += point.ch
      else runs.push({tone: point.tone, text: point.ch})
    }
    return runs.map(run => paint(run.text, run.tone)).join('')
  })
}

function timeAxis(model, width) {
  const labels = Array(width).fill(' ')
  const at = (time, x) => {
    for (const [index, char] of new Date(time).toISOString().slice(11, 16).split('').entries()) labels[x + index] = char
  }
  at(model.start, 0)
  if (width >= 24) at((model.start + model.end) / 2, Math.floor(width / 2) - 2)
  at(model.end, width - 5)
  return labels.join('')
}

export function metricChartLines(chart, {width = 80, height = 6} = {}) {
  if (width < 24) return [paint(cell('Widen terminal to see chart', Math.max(0, width)), 'muted')]
  const preview = chartModel(chart, 1, height)
  if (!preview) return []
  const middle = Math.floor((preview.height - 1) / 2)
  const tick = row => metricValue(preview.upper * (1 - row / (preview.height - 1)) * preview.factor, chart.unit, true)
  const axisWidth = Math.min(Math.max(tick(0).length, tick(middle).length, tick(preview.height - 1).length), Math.floor(width / 3))
  const plotWidth = width - axisWidth - 2
  const model = chartModel(chart, plotWidth, height)
  const tone = chart.state === 'Stale' ? 'muted' : chart.unit === 'ms' ? 'accent' : 'cyan'
  const rows = plotRows(model, tone, chart.reference)
  const lines = rows.map((line, row) => `${paint(cell([0, middle, model.height - 1].includes(row) ? tick(row) : '', axisWidth, true), 'muted')}${paint(' │', 'border')}${line}`)
  lines.push(paint(`${' '.repeat(axisWidth + 1)}└${'─'.repeat(plotWidth)}`, 'border'))
  lines.push(paint(`${cell('UTC', axisWidth + 2)}${timeAxis(model, plotWidth)}`, 'muted'))
  return lines
}

export function metricDetailContent(chart, {width = 80, height = 16} = {}) {
  // Reserve a cell so Blessed doesn't word-wrap the final time label while
  // processing a trailing ANSI reset on an otherwise exactly full line.
  width = Math.max(1, Math.floor(width) - 1)
  const stateTone = chart.state === 'Stale' ? 'warning' : chart.state === 'Unavailable' ? 'error' : 'muted'
  const state = `[${chart.state.toUpperCase()}]`
  const heading = `${paint(cell(`${single(chart.title)} · ${single(chart.scope)}`, Math.max(0, width - state.length - 1)), 'accent', true)} ${paint(state, stateTone)}`
  if (!chart.stats.count) return `${heading}\n\n${clean(chart.details)}`
  const cards = [['LATEST', chart.stats.latest], ['MEAN', chart.stats.mean], ['MIN', chart.stats.min], ['MAX', chart.stats.max]]
  const count = width >= 78 ? 4 : 2
  const cardWidth = Math.floor((width - (count - 1) * 2) / count)
  const summary = []
  for (let i = 0; i < cards.length; i += count) {
    summary.push(cards.slice(i, i + count).map(([label, value]) => paint(cell(`${label} ${metricValue(value, chart.unit, true)}`, cardWidth), label === 'LATEST' ? 'cyan' : 'fg', label === 'LATEST')).join('  '))
  }
  const plotHeight = Math.min(10, Math.max(3, height - summary.length - 5))
  const plot = metricChartLines(chart, {width, height: plotHeight})
  const reference = chart.reference?.values?.some(valid)
  const legend = [paint('◆ latest', 'fg'), paint('│ range', 'cyan'), paint('○/· gaps', 'muted'),
    ...(reference ? [paint(`┄ ${chart.reference.label}`, chart.reference.tone)] : [])].join('  ')
  const coverage = chart.metric.times.length ? chart.stats.count / chart.metric.times.length * 100 : 0
  const caption = `${chart.metric.stepMinutes}m buckets · ${chart.stats.count}/${chart.metric.times.length} samples (${metricNumber(coverage)}%)`
  return [heading, ...summary, ...plot, legend, paint(caption, 'muted'), '',
    paint('SAMPLE DETAILS', 'accent', true), clean(chart.details), '',
    'Chart: filled columns are complete; ○ marks partial groups, · marks gaps.',
    'The line shows the mean of available buckets in each column; │ preserves their min–max range.',
    ...(reference ? [`The ${chart.reference.label.toLowerCase()} guide uses the ${chart.reference.aggregation === 'mean' ? 'mean' : 'maximum'} reported reference in each column.`] : []),
    '◆ marks the midpoint of the actual latest bucket. The time axis is UTC.',
  ].join('\n')
}
