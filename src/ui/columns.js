import blessed from 'blessed'
import {single} from './text.js'
import {TAB_DEFINITIONS} from './tabs.js'

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
  'Pipeline apps': [
    {label: 'Stage', width: 11},
    {label: 'App', min: 18, weight: 1},
    {label: 'Region', width: 10},
    {label: 'Stack', width: 12, hideBelow: 72},
  ],
  ...Object.fromEntries(TAB_DEFINITIONS.filter(tab => tab.columns).map(tab => [tab.name, tab.columns])),
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
