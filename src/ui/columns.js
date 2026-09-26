import blessed from 'blessed'
import {single} from './text.js'

function cell(value, width, right = false) {
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

export const OVERVIEW_COLUMNS = ['Item / Process', 'Size / Value', 'Qty', 'Status']

export function overviewColumns(values, width) {
  width = Math.max(0, Math.floor(width))
  if (width < 44) return cell(values.map(single).join('  '), width)
  const first = Math.min(24, Math.max(14, Math.floor(width * 0.27)))
  const widths = [first, width - first - 4 - 13 - 6, 4, 13]
  return values.map((value, index) => cell(value, widths[index], index === 2)).join('  ')
}
