import {palette} from './theme.js'

export const frame = () => ({border: {type: 'line'}, style: {fg: palette.fg, bg: palette.bg, border: {fg: palette.border}, focus: {border: {fg: palette.accent}}}})

export function bindMovementKeys(widget) {
  for (const [key, direction] of [['C-n', 1], ['C-p', -1]]) {
    widget.key([key], () => {
      if (widget.type === 'list') widget.move(direction)
      else widget.scroll(direction)
      widget.screen.render()
    })
  }
}
