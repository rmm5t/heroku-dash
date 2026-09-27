export function metricNumber(value, compact = false) {
  if (!Number.isFinite(value)) return '—'
  const magnitude = Math.abs(value)
  const precision = magnitude > 0 && magnitude < 0.01 ? {maximumSignificantDigits: 3} : {maximumFractionDigits: 2}
  return new Intl.NumberFormat('en-US', {...precision, ...(compact && magnitude >= 10_000 ? {notation: 'compact'} : {})}).format(value)
}

export function metricValue(value, unit, compact = false) {
  if (!Number.isFinite(value)) return '—'
  if (unit === 'bytes') return `${metricNumber(value / 1024 ** 2, compact)} MiB`
  return `${metricNumber(value, compact)}${unit ? ` ${compact && unit === 'req/min' ? 'rpm' : unit}` : ''}`
}
