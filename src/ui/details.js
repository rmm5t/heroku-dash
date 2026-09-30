import blessed from 'blessed'
import {clean} from './text.js'
import {highlightKeys, paint} from './theme.js'
import {metricDetailContent} from './metric-chart.js'

export function detailContent(row, dimensions) {
  if (row?.metricChart) return metricDetailContent(row.metricChart, dimensions)
  const text = clean(row?.detail ?? '')
  const ranges = row?.copyRanges ?? (row?.valueRange ? [row.valueRange] : [])
  let content = ''
  let offset = 0
  for (const {start, end} of ranges) {
    content += `${highlightKeys(text.slice(offset, start))}${paint(text.slice(start, end), 'cyan')}`
    offset = end
  }
  return content + highlightKeys(text.slice(offset))
}

export function domainValueAt(detail, row, mouse) {
  if (row?.kind !== 'domain' || mouse.button !== 'left' || !detail.lpos) return null
  const pos = detail.lpos
  const left = pos.xi + detail.ileft
  const top = pos.yi + detail.itop
  const right = pos.xl - detail.iright - (detail.scrollbar ? 1 : 0)
  if (mouse.x < left || mouse.x >= right || mouse.y < top || mouse.y >= pos.yl - detail.ibottom) return null
  const wrappedLine = mouse.y - top + pos.base
  const sourceLine = detail._clines.rtof[wrappedLine]
  if (sourceLine === undefined) return null
  const text = clean(row.detail)
  const lines = text.split('\n')
  const lineStart = lines.slice(0, sourceLine).reduce((offset, line) => offset + line.length + 1, 0)
  // Follow Blessed's actual wrapping so offsets remain correct after resizing
  // and scrolling, including the terminal cells occupied by wide characters.
  const precedingWidth = detail._clines.ftor[sourceLine].filter(line => line < wrappedLine)
    .reduce((width, line) => width + blessed.unicode.strWidth(clean(detail._clines[line])), 0)
  const column = mouse.x - left + precedingWidth
  return row.copyRanges?.find(range => range.start >= lineStart && range.end <= lineStart + lines[sourceLine].length
    && column >= blessed.unicode.strWidth(text.slice(lineStart, range.start))
    && column < blessed.unicode.strWidth(text.slice(lineStart, range.end))) ?? null
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
