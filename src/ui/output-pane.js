import blessed from 'blessed'
import {ModalLifecycle} from './modal-lifecycle.js'
import {palette} from './theme.js'
import {bindMovementKeys, frame} from './widget-helpers.js'

export function createOutputPane(owner, {label, width = '90%', heading = false, canClose = () => true, onClose}) {
  const modal = blessed.box({parent: owner.screen, top: 'center', left: 'center', width, height: '85%', ...frame(),
    label, style: {...frame().style, border: {fg: palette.accent}}})
  const lifecycle = new ModalLifecycle(owner, modal, {onClose})
  const title = heading ? blessed.box({parent: modal, top: 0, left: 2, right: 2, height: 1, tags: false,
    style: {fg: palette.muted, bg: palette.bg}}) : null
  const output = blessed.box({parent: modal, top: heading ? 2 : 1, bottom: 3, left: 2, right: 2, scrollable: true,
    alwaysScroll: true, keys: true, vi: true, mouse: true, tags: false,
    scrollbar: {ch: '│', style: {bg: palette.border}}, style: {fg: palette.fg, bg: palette.bg}})
  bindMovementKeys(output)
  const footer = blessed.box({parent: modal, bottom: 0, height: 2, left: 2, right: 2, tags: false,
    style: {fg: palette.muted, bg: palette.bg}})
  modal.key(['escape', 'q'], () => { if (canClose()) lifecycle.close() })
  output.key(['escape', 'q'], () => lifecycle.close())
  return {modal, lifecycle, heading: title, output, footer}
}
