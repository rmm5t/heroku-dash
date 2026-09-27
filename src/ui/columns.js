import blessed from 'blessed'
import {single} from './text.js'

export function cell(value, width, right = false) {
  let text = single(value)
  if (blessed.unicode.strWidth(text) > width) {
    let clipped = ''
    let length = 0
    for (const character of text) {
      const size = blessed.unicode.strWidth(character)
      if (length + size > width - 1) break
      clipped += character
      length += size
    }
    text = width > 0 ? `${clipped}…` : ''
  }
  const padding = ' '.repeat(Math.max(0, width - blessed.unicode.strWidth(text)))
  return right ? padding + text : text + padding
}

export const TABLE_COLUMNS = {
  Overview: [
    {label: 'Item / Process', min: 14, weight: 1, max: 24},
    {label: 'Size / Value', min: 10, weight: 3},
    {label: 'Qty', width: 4, right: true},
    {label: 'Status', width: 13},
  ],
  Resources: [
    {label: 'Process / Dyno', min: 14, weight: 1, max: 26},
    {label: 'Size', min: 12, weight: 2},
    {label: 'Qty', width: 4, right: true},
    {label: 'State / Action', width: 14},
    {label: 'Age', width: 9, hideBelow: 72},
  ],
  'Add-ons': [
    {label: 'Add-on', min: 16, weight: 2},
    {label: 'Service', min: 14, weight: 1, hideBelow: 78},
    {label: 'Plan', min: 12, weight: 1},
    {label: 'State', width: 19},
  ],
  Settings: [
    {label: 'Setting / Type', min: 14, weight: 1, max: 24},
    {label: 'Value', min: 16, weight: 4},
    {label: 'Status / Action', width: 16},
  ],
  Metrics: [
    {label: 'Metric / Process', compact: 'Metric', min: 14, weight: 3},
    {label: 'Scope / Limit', compact: 'Scope/Limit', min: 11, weight: 1, max: 18},
    {label: 'Latest', min: 11, weight: 1, max: 18, right: true},
    {label: 'Trend / State', compact: 'Trend/State', min: 13, weight: 2, max: 24},
  ],
}

export function tableColumns(values, width, layout = 'Overview') {
  width = Math.max(0, Math.floor(width))
  const columns = TABLE_COLUMNS[layout].map((column, index) => ({...column, index}))
    .filter(column => width >= (column.hideBelow ?? 0))
  const widths = columns.map(column => column.width ?? column.min)
  let extra = width - widths.reduce((sum, size) => sum + size, 0) - (columns.length - 1) * 2
  const value = column => values ? values[column.index] : width < 72 ? column.compact ?? column.label : column.label
  if (extra < 0) return cell(columns.map(column => single(value(column))).join('  '), width)
  while (extra > 0) {
    const flexible = columns.map((column, index) => ({...column, position: index}))
      .filter(column => column.weight && widths[column.position] < (column.max ?? Infinity))
    if (!flexible.length) break
    const weight = flexible.reduce((sum, column) => sum + column.weight, 0)
    const remaining = extra
    for (const column of flexible) {
      const share = Math.min(extra, Math.max(1, Math.floor(remaining * column.weight / weight)), (column.max ?? Infinity) - widths[column.position])
      widths[column.position] += share
      extra -= share
    }
  }
  return columns.map((column, index) => cell(value(column), widths[index], column.right)).join('  ')
}
