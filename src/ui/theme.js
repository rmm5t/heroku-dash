import blessed from 'blessed'
import {clean, single} from './text.js'
import {tableColumns} from './columns.js'

export const palette = {
  bg: '#161b22', panel: '#1c212b', fg: '#c9d1d9', muted: '#8b949e',
  accent: '#bc8cff', border: '#484f58', selected: '#30304b',
  success: '#7ee787', warning: '#e3b341', error: '#ff7b72', info: '#79c0ff', cyan: '#76e3ea',
  loadingTrail: '#916bbb', loadingFade: '#5e467e', loadingDim: '#362b48',
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

export const tabIcons = ['overview', 'resources', 'addons', 'config', 'settings', 'releases', 'metrics']
export const stageStyles = {
  development: {icon: 'code', tone: 'info'},
  review: {icon: 'review', tone: 'accent'},
  staging: {icon: 'staging', tone: 'warning'},
  production: {icon: 'releases', tone: 'success'},
}

// Only these helpers introduce ANSI styles, after sanitizing their payloads.
// Reset foreground alone so row selection backgrounds remain intact.
export function paint(value, tone = 'fg', bold = false) {
  const color = blessed.colors.convert(palette[tone] ?? palette.fg)
  return `\x1b[38;5;${color}m${bold ? '\x1b[1m' : ''}${clean(value)}${bold ? '\x1b[22m' : ''}\x1b[39m`
}

export function badge(icon, value, tone = 'accent') {
  return `${paint(icons[icon] ?? icons.overview, tone)} ${paint(single(value), tone)}`
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
  if (['up', 'idle', 'succeeded', 'provisioned', 'active'].includes(state)) return {icon: 'success', tone: 'success'}
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
  let label = offset < 0 ? text : `${text.slice(0, offset)}${paint(emphasis, row.tone)}${text.slice(offset + emphasis.length)}`
  if (nested) {
    label = label.replace(icon, paint(icon, row.tone ?? 'accent'))
    return ` ${paint(row.treeBranch, 'muted')} ${label}`
  }
  return ` ${paint(icon, row.tone ?? 'accent')}  ${label}`
}

export function shortcut(key, description) {
  return `${paint(key, 'accent', true)} ${paint(description, 'muted')}`
}
