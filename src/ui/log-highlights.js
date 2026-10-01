const DEFAULT_BACKGROUND = '\x1b[49m'
const DEFAULT_FOREGROUND = '\x1b[39m'

function colorsAfter(sequence, colors) {
  const parameters = sequence.slice(2, -1).split(';')
  for (let index = 0; index < parameters.length; index++) {
    const parameter = parameters[index]
    const code = Number(parameter.split(':')[0])
    if (code === 0) { colors.background = DEFAULT_BACKGROUND; colors.foreground = DEFAULT_FOREGROUND }
    else if (code === 49) colors.background = DEFAULT_BACKGROUND
    else if (code === 39) colors.foreground = DEFAULT_FOREGROUND
    else if (code >= 40 && code <= 47 || code >= 100 && code <= 107) colors.background = `\x1b[${code}m`
    else if (code >= 30 && code <= 37 || code >= 90 && code <= 97) colors.foreground = `\x1b[${code}m`
    else if ([38, 48, 58].includes(code)) {
      // Extended foreground/underline colors also contain numeric parameters;
      // don't mistake a zero RGB component for a style reset.
      const length = parameter.includes(':') ? 1 : parameters[index + 1] === '5' ? 3 : parameters[index + 1] === '2' ? 5 : 1
      const sequence = `\x1b[${parameters.slice(index, index + length).join(';')}m`
      if (code === 48) colors.background = sequence
      else if (code === 38) colors.foreground = sequence
      index += length - 1
    }
  }
  return colors
}

// Ranges use visible-text UTF-16 offsets. Restore original colors after each
// match; text styles remain exactly as supplied by the logs.
export function highlightLogLine(line, ranges, highlight, colors = {background: DEFAULT_BACKGROUND, foreground: DEFAULT_FOREGROUND}, foreground = '') {
  const matchStyle = highlight + foreground
  const restore = () => colors.background + (foreground ? colors.foreground : '')
  let content = '', offset = 0, range = 0, active = false
  for (const [token] of line.matchAll(/\x1b\[[\d;:]*m|[^\x1b]+/g)) {
    if (token.startsWith('\x1b')) {
      colors = colorsAfter(token, colors)
      content += token + (active ? matchStyle : '')
      continue
    }
    for (const character of token) {
      while (ranges[range]?.end <= offset) range++
      const matching = ranges[range]?.start < offset + character.length && ranges[range]?.end > offset
      if (matching && !active) { content += matchStyle; active = true }
      content += character
      offset += character.length
      if (active && offset >= ranges[range].end) { content += restore(); active = false }
    }
  }
  if (active) content += restore()
  return {content, colors}
}

export function logMatchRanges(visible, query, expression) {
  if (!query) return []
  const ranges = []
  const folded = visible.toLowerCase()
  const foldedQuery = query.toLowerCase()
  // Unicode lowercasing can expand a character, so map offsets back to the
  // original string only when necessary.
  const originalOffset = (index, end = false) => {
    if (folded.length === visible.length) return index
    let original = 0, lower = 0
    for (const character of visible) {
      const length = character.toLowerCase().length
      if (index < lower + length) return original + (end ? character.length : 0)
      lower += length
      original += character.length
      if (index === lower) return original
    }
    return original
  }
  for (let offset = 0; offset <= folded.length - foldedQuery.length;) {
    const start = folded.indexOf(foldedQuery, offset)
    if (start < 0) break
    ranges.push({start: originalOffset(start), end: originalOffset(start + foldedQuery.length, true)})
    offset = start + 1
  }
  if (expression) for (const match of visible.matchAll(expression)) {
    if (match[0].length) ranges.push({start: match.index, end: match.index + match[0].length})
  }
  const merged = []
  for (const match of ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1)
    if (previous && match.start <= previous.end) previous.end = Math.max(previous.end, match.end)
    else merged.push({...match})
  }
  return merged
}
