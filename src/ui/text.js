// Remote text is never allowed to supply terminal control sequences. Widgets
// keep Blessed tag parsing disabled, so literal {tags} remain ordinary text.
export function clean(value) {
  return String(value ?? '—').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

// Command output may retain SGR colors and text styles, but never cursor,
// clipboard, title, hyperlink, or other terminal control sequences.
export function ansi(value) {
  return String(value ?? '—')
    .replace(/(?:\x1b\]|\x9d)[^\x07]*?(?:\x07|\x1b\\|\x9c)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b./gs,
      sequence => /^\x1b\[[\d;:]*m$/.test(sequence) ? sequence : '')
    .replace(/\x1b(?!\[[\d;:]*m)/g, '')
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f]/g, '')
}

export function single(value) { return clean(value).replace(/[\r\n\t]/g, ' ') }
