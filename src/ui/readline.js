import blessed from 'blessed'
import {ReadlineState} from './readline-state.js'

export function enableReadline(input, history, render) {
  const state = new ReadlineState({value: input.getValue(), history})
  let viewStart = 0
  const display = value => input.censor ? '*'.repeat([...value].length) : value.replaceAll('\t', input.screen.tabc)
  const width = value => blessed.unicode.strWidth(display(value))
  const updateCursor = () => {
    if (input.screen.focused !== input) return
    const position = input._getCoords()
    if (!position) return
    input.screen.program.cup(position.yi + input.itop,
      position.xi + input.ileft + width(state.characters.slice(viewStart, state.cursor).join('')))
  }
  const refresh = () => {
    const available = Math.max(1, input.width - input.iwidth - 1)
    let used = 0
    viewStart = state.cursor
    const reserved = state.cursor < state.characters.length ? Math.min(available, width(state.characters[state.cursor])) : 0
    while (viewStart > 0 && used + width(state.characters[viewStart - 1]) <= available - reserved) {
      used += width(state.characters[--viewStart])
    }
    let viewEnd = state.cursor
    while (viewEnd < state.characters.length && used + width(state.characters[viewEnd]) <= available) {
      used += width(state.characters[viewEnd++])
    }
    const value = state.value
    input.value = value
    input._value = value
    input.setContent(display(state.characters.slice(viewStart, viewEnd).join('')))
    render()
    updateCursor()
  }
  // Blessed stores its input and cursor handlers on the textbox itself.
  input.removeListener('resize', input.__updateCursor)
  input.removeListener('move', input.__updateCursor)
  input._updateCursor = updateCursor
  input.__updateCursor = updateCursor
  input.on('resize', updateCursor)
  input.on('move', updateCursor)
  input._listener = (ch, key) => {
    const action = state.handleKey(ch, key)
    if (action === 'submit') input._done(null, state.value)
    else if (action === 'cancel') input._done(null, null)
    else if (action === 'refresh') refresh()
  }
  refresh()
}
