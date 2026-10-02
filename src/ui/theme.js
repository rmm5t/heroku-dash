import blessed from 'blessed'
import {clean, single} from './text.js'
import {tableColumns} from './columns.js'

export const palettes = {
  dark: {
    bg: '#161b22', panel: '#1c212b', fg: '#c9d1d9', muted: '#8b949e',
    accent: '#bc8cff', border: '#484f58', selected: '#3a3a3a', selectedFg: '#eeeeee',
    selectedInactive: '#262626', selectedInactiveFg: '#bcbcbc', selectionMarker: '#af87ff',
    logMatch: '#333399', logMatchFg: '#ffffff',
    success: '#7ee787', warning: '#e3b341', error: '#ff7b72', info: '#79c0ff', cyan: '#76e3ea',
    loadingTrail: '#916bbb', loadingFade: '#5e467e', loadingDim: '#362b48',
  },
  light: {
    bg: '#fafafa', panel: '#eeeeee', fg: '#303030', muted: '#626262',
    accent: '#5f0087', border: '#a8a8a8', selected: '#d7d7d7', selectedFg: '#262626',
    selectedInactive: '#eeeeee', selectedInactiveFg: '#626262', selectionMarker: '#5f0087',
    logMatch: '#eeeeee', logMatchFg: '#303030',
    success: '#005f00', warning: '#875f00', error: '#af0000', info: '#005faf', cyan: '#005f5f',
    loadingTrail: '#875faf', loadingFade: '#af87af', loadingDim: '#d7d7df',
  },
}

// Choose once at startup, before creating widgets or their ANSI-styled content.
export let palette = palettes.dark
export function setTheme(name) {
  if (!Object.hasOwn(palettes, name)) throw new Error(`Unknown theme: ${name}`)
  palette = palettes[name]
}

// Nerd Fonts' BMP glyphs stay one terminal cell wide with a Nerd Font Mono.
export const icons = {
  heroku: '\ue77b', teams: '\uf0c0', pipelines: '\uf0e8', apps: '\uf1b2',
  overview: '\uf05a', resources: '\uf233', addons: '\uf12e', config: '\uf084',
  settings: '\uf013', releases: '\uf135', metrics: '\uf080',
  success: '\uf058', warning: '\uf071', error: '\uf057', stopped: '\uf28d',
  refresh: '\uf021', lock: '\uf023', eye: '\uf06e', globe: '\uf0ac',
  stack: '\uf1b3', clock: '\uf017', search: '\uf002', code: '\uf121',
  review: '\uf126', staging: '\uf0c3', database: '\uf1c0', help: '\uf059',
  keyboard: '\uf11c', chevron: '\uf105',
}

export const stageStyles = {
  development: {icon: 'code', tone: 'info'},
  review: {icon: 'review', tone: 'accent'},
  staging: {icon: 'staging', tone: 'warning'},
  production: {icon: 'releases', tone: 'success'},
}

const KEY = '(?:Ctrl-[A-Z]|Alt-[A-Z]|Shift-Tab|Enter|Esc|Tab|1–7|[a-zA-Z?:/←→↑↓\\[\\]])'
const KEYS = `${KEY}(?:\\s*(?:/|,|or)\\s*${KEY})*`
const keyPatterns = [
  new RegExp(`\\[(${KEYS})\\]`, 'g'),
  /\(([yn])\)/g,
  /\b((?:Ctrl|Alt)-[A-Z]|Shift-Tab|Enter|Esc|Tab)\b/g,
  new RegExp(`\\b(?:[Pp]ress|[Uu]se|with|or|also)\\s+(${KEYS})(?=$|[\\s.,;)])`, 'g'),
  new RegExp(`^ {2}(${KEYS})(?=\\s)`, 'gm'),
  new RegExp(`^(${KEYS})(?= (?:to |cycles |filters |displays ))`, 'gm'),
  /^(j\/k)(?=,)/gm,
]

function keybindingRanges(value) {
  const text = clean(value)
  const matches = keyPatterns.flatMap(pattern => [...text.matchAll(pattern)].map(match => {
    const start = match.index + match[0].lastIndexOf(match[1])
    return {start, end: start + match[1].length}
  })).sort((a, b) => a.start - b.start || a.end - b.end)
  const ranges = []
  for (const range of matches) {
    const previous = ranges.at(-1)
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else ranges.push(range)
  }
  return ranges
}

export function highlightKeys(value, tone, bold = false) {
  const text = clean(value)
  const surrounding = value => tone === undefined ? value : paint(value, tone, bold)
  let content = ''
  let offset = 0
  for (const {start, end} of keybindingRanges(text)) {
    content += surrounding(text.slice(offset, start)) + paint(text.slice(start, end), 'accent', true)
    offset = end
  }
  return content + surrounding(text.slice(offset))
}

export function styleListSelection(list) {
  const focused = () => list.screen.focused === list
  Object.assign(list.style.selected, {
    fg: () => focused() ? palette.selectedFg : palette.selectedInactiveFg,
    bg: () => focused() ? palette.selected : palette.selectedInactive,
  })
  // An overlay keeps its purple foreground when Blessed overrides the selected
  // row's ANSI colors. It occupies the label's existing leading space.
  const marker = blessed.box({parent: list, top: 0, left: 0, width: 1, height: 1,
    fixed: true, autoFocus: false, tags: false, hidden: true, content: '▎',
    style: {fg: palette.selectionMarker, bg: palette.selected}})
  const shortcuts = []
  list.on('prerender', () => {
    const top = list.selected - list.childBase
    const item = list.items[list.selected]
    const visible = item && top >= 0 && top < list.height - list.iheight
    marker.hide()
    for (const overlay of shortcuts) overlay.hide()
    if (!visible) return
    if (focused()) {
      marker.top = top
      marker.show()
      marker.setFront()
    }
    const text = clean(item.content)
    const ranges = keybindingRanges(text).filter(({start, end}) => item.content.includes(paint(text.slice(start, end), 'accent', true)))
    for (const [index, {start, end}] of ranges.entries()) {
      const key = text.slice(start, end)
      const left = blessed.unicode.strWidth(text.slice(0, start))
      const width = blessed.unicode.strWidth(key)
      if (left + width > list.width - list.iwidth - (list.scrollbar ? 1 : 0)) continue
      const overlay = shortcuts[index] ??= blessed.box({parent: list, height: 1, fixed: true, autoFocus: false, tags: false,
        style: {fg: palette.accent, bold: true, bg: () => focused() ? palette.selected : palette.selectedInactive}})
      Object.assign(overlay, {top, left, width})
      overlay.setContent(key)
      overlay.show()
      overlay.setFront()
    }
  })
}

// Only these helpers introduce ANSI styles, after sanitizing their payloads.
// Reset foreground alone so row selection backgrounds remain intact.
export function paint(value, tone = 'fg', bold = false) {
  const color = blessed.colors.convert(palette[tone] ?? palette.fg)
  return `\x1b[38;5;${color}m${bold ? '\x1b[1m' : ''}${clean(value)}${bold ? '\x1b[22m' : ''}\x1b[39m`
}

export function badge(icon, value, tone = 'accent') {
  return `${paint(icons[icon] ?? icons.overview, tone)} ${highlightKeys(single(value), tone)}`
}

export const SCANNER_INTERVAL = 40

export function scannerFrame(frame) {
  // OpenCode-inspired square/dot scanner: light trails behind the moving head,
  // then fades during a brief hold before the direction reverses.
  const width = 8
  const halfCycle = width - 1 + 4
  const phase = frame % (halfCycle * 2)
  const forward = phase < halfCycle
  const step = phase % halfCycle
  const position = Math.min(step, width - 1)
  const head = forward ? position : width - 1 - position
  const fade = Math.max(0, step - (width - 1))
  const trail = ['accent', 'loadingTrail', 'loadingFade', 'loadingDim']
  return Array.from({length: width}, (_, index) => {
    const distance = forward ? head - index : index - head
    if (distance === 0) return paint('■', 'accent', true)
    if (distance > 0 && distance + fade < trail.length) return paint('■', trail[distance + fade])
    return paint('⬝', 'loadingDim')
  }).join('')
}

export function stateStyle(state) {
  if (['up', 'succeeded', 'provisioned', 'active'].includes(state)) return {icon: 'success', tone: 'success'}
  if (['crashed', 'failed', 'error'].includes(state)) return {icon: 'error', tone: 'error'}
  if (['starting', 'pending', 'provisioning', 'deprovisioning', 'maintenance', 'upgrade pending', 'plan change pending'].includes(state)) return {icon: 'clock', tone: 'warning'}
  return {icon: 'stopped', tone: 'muted'}
}

export function rowLabel(row, width = 90) {
  const icon = icons[row.icon] ?? icons.overview
  const nested = row.kind === 'dyno' && row.treeBranch && row.columns
  const columns = nested ? [`${icon} ${single(row.value?.name)}`, ...row.columns.slice(1)] : row.columns
  const text = columns ? tableColumns(columns, Math.max(0, width - 4), row.columnLayout) : single(row.label)
  const emphasis = row.emphasis ? single(row.emphasis) : ''
  let offset = emphasis ? text.indexOf(emphasis) : -1
  // A state such as "up" must highlight the state column, not "backup.1".
  while (offset >= 0 && ((offset > 0 && !/\s/.test(text[offset - 1]))
    || (offset + emphasis.length < text.length && !/\s/.test(text[offset + emphasis.length])))) {
    offset = text.indexOf(emphasis, offset + 1)
  }
  // Config labels contain literal values rather than shortcut hints.
  const highlight = row.kind === 'config' ? value => value : highlightKeys
  let label = highlight(text)
  if (offset >= 0) {
    const emphasized = row.kind === 'config' ? paint(emphasis, row.tone) : highlightKeys(emphasis, row.tone ?? 'fg')
    label = `${highlight(text.slice(0, offset))}${emphasized}${highlight(text.slice(offset + emphasis.length))}`
  }
  if (nested) {
    label = label.replace(icon, paint(icon, row.tone ?? 'accent'))
    return ` ${paint(row.treeBranch, 'muted')} ${label}`
  }
  return ` ${paint(icon, row.tone ?? 'accent')}  ${label}`
}

export function shortcut(key, description) {
  return `${paint(key, 'accent', true)} ${paint(description, 'muted')}`
}
