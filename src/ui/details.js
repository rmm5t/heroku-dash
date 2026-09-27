import blessed from 'blessed'
import {clean} from './text.js'
import {paint} from './theme.js'
import {metricDetailContent} from './metric-chart.js'

export function detailContent(row, dimensions) {
  if (row?.metricChart) return metricDetailContent(row.metricChart, dimensions)
  const text = clean(row?.detail ?? '')
  if (!row?.valueRange) return text
  const {start, end} = row.valueRange
  return `${text.slice(0, start)}${paint(text.slice(start, end), 'cyan')}${text.slice(end)}`
}

export function isValueClick(detail, row, mouse) {
  if (row?.kind !== 'config' || !row.valueRange || mouse.button !== 'left') return false
  const pos = detail.lpos
  if (!pos) return false
  const left = pos.xi + detail.ileft
  const top = pos.yi + detail.itop
  const right = pos.xl - detail.iright - (detail.scrollbar ? 1 : 0)
  const bottom = pos.yl - detail.ibottom
  if (mouse.x < left || mouse.x >= right || mouse.y < top || mouse.y >= bottom) return false

  // Use Blessed's rendered-line map rather than reimplementing wrapping. It
  // accounts for resizing, tabs, Unicode widths, and the current scroll offset.
  const wrappedLine = mouse.y - top + pos.base
  const sourceLine = detail._clines.rtof[wrappedLine]
  const text = clean(row.detail)
  const first = text.slice(0, row.valueRange.start).split('\n').length - 1
  const last = text.slice(0, row.valueRange.end).split('\n').length - 1
  if (sourceLine === undefined || sourceLine < first || sourceLine > last) return false

  // Exclude the unused area after short lines, plus borders and the scrollbar.
  const line = clean(detail._clines[wrappedLine])
  return mouse.x - left < blessed.unicode.strWidth(line)
}
