import {ansi, clean} from './text.js'
import {highlightLogLine, logMatchRanges} from './log-highlights.js'

export const LOG_LIMITS = {lines: 10_000, characters: 2_000_000}

export class LogBuffer {
  constructor({lines = LOG_LIMITS.lines, characters = LOG_LIMITS.characters} = {}) {
    this.maxLines = lines
    this.maxCharacters = characters
    this.clear()
  }

  clear() {
    this.raw = ''
    this.frozen = null
    this.filter = ''
  }

  append(chunk) {
    const combined = this.raw + String(chunk)
    const cut = Math.max(0, combined.length - this.maxCharacters)
    this.raw = combined.slice(-this.maxCharacters)
    // Prefer complete records when a character limit cuts through a line.
    const boundary = this.raw.indexOf('\n')
    if (cut && combined[cut - 1] !== '\n' && boundary >= 0 && boundary < this.raw.length - 1) this.raw = this.raw.slice(boundary + 1)
    const lines = this.raw.split('\n')
    const count = lines.length - (lines.at(-1) === '' ? 1 : 0)
    if (count > this.maxLines) this.raw = lines.slice(count - this.maxLines).join('\n')
  }

  get paused() { return this.frozen !== null }
  pause() { if (!this.paused) this.frozen = this.raw }
  resume() { this.frozen = null }

  get filter() { return this.filterText }
  set filter(value) {
    // Every query can match literally or as a regex. Invalid regex syntax is
    // still useful as literal text (for example, an unmatched opening bracket).
    let expression = null
    try { expression = new RegExp(value, 'i') } catch { /* Keep literal matching. */ }
    this.filterText = value
    this.filterExpression = expression
    this.highlightExpression = expression ? new RegExp(value, 'gi') : null
  }

  get content() { return this.render() }

  render(highlight, foreground) {
    const text = ansi(this.paused ? this.frozen : this.raw)
    if (!this.filter) return text
    const query = this.filter.toLowerCase()
    let colors
    const lines = []
    for (const line of text.split('\n')) {
      const visible = clean(line)
      if (!visible.toLowerCase().includes(query) && !this.filterExpression?.test(visible)) continue
      if (!highlight) { lines.push(line); continue }
      const rendered = highlightLogLine(line, logMatchRanges(visible, this.filter, this.highlightExpression), highlight, colors, foreground)
      lines.push(rendered.content)
      colors = rendered.colors
    }
    return lines.join('\n')
  }
}
