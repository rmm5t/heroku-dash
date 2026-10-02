import blessed from 'blessed'
import {errorMessage} from '../api.js'
import {withAbort} from '../read-requests.js'
import {LogBuffer, LOG_LIMITS} from './log-buffer.js'
import {createOutputPane} from './output-pane.js'
import {enableReadline} from './readline.js'
import {single} from './text.js'
import {icons, paint, palette, shortcut} from './theme.js'
import {frame} from './widget-helpers.js'

export function createLogViewer({owner, appName, execute, render, setStatus, history, historyScope, closeDashboard,
  isCurrent = () => true, onClose = () => {}}) {
  const buffer = new LogBuffer()
  const matchHighlight = `\x1b[48;5;${blessed.colors.convert(palette.logMatch)}m`
  const matchForeground = `\x1b[38;5;${blessed.colors.convert(palette.logMatchFg)}m`
  const controller = new AbortController()
  let input = null
  let timer = null
  let status = 'Connecting…'
  let tone = 'info'
  let finished = false
  const {modal, lifecycle, heading, output, footer} = createOutputPane(owner, {
    label: ` ${icons.code}  Logs · ${single(appName)} `, width: '95%', heading: true, canClose: () => !input,
    onClose: ({restoreFocus}) => { if (restoreFocus) setStatus('Log viewer closed.') },
  })
  const current = () => !owner.closed && !lifecycle.closed && isCurrent()
  const draw = ({resetScroll = false} = {}) => {
    if (!current()) return
    const scroll = output.childBase
    heading.setContent(`Filter: ${buffer.filter ? single(buffer.filter) : '(none)'} · buffer ≤ ${LOG_LIMITS.lines} lines / ${LOG_LIMITS.characters / 1000}k characters`)
    output.setContent(buffer.render(matchHighlight, matchForeground) || (buffer.filter ? 'No matching log lines.' : 'Waiting for log output…'))
    if (buffer.paused) output.setScroll(resetScroll ? 0 : scroll)
    else output.setScrollPerc(100)
    footer.setContent(`${shortcut('p / Space', buffer.paused ? 'resume' : 'pause')}  ${shortcut('/', 'filter')}  ${shortcut('End', 'follow')}  ${shortcut('Esc / q', 'close')}\n${paint(`${buffer.paused ? 'Paused display' : 'Following'} · ${status}`, buffer.paused ? 'warning' : tone)}`)
    render()
  }
  lifecycle.addCleanup(() => {
    onClose()
    controller.abort()
    clearTimeout(timer)
    buffer.clear()
    input?._done?.('stop')
    input = null
  })
  const pause = () => { buffer.pause(); draw() }
  const resume = () => { buffer.resume(); draw() }
  const editFilter = () => {
    if (input || !current()) return
    output.top = 4
    input = blessed.textbox({parent: modal, top: 1, left: 2, right: 2, height: 3, ...frame(), label: ' Filter logs · text or regex · ↑/↓ history ',
      inputOnFocus: true, value: buffer.filter})
    const editor = input
    const finish = value => {
      if (input !== editor || !current()) return
      if (value !== null) {
        buffer.filter = value
        const scope = historyScope()
        if (scope) void history.add(scope, value)
      }
      input = null
      editor.destroy()
      output.top = 2
      output.focus()
      draw({resetScroll: value !== null})
    }
    editor.on('submit', value => finish(value))
    editor.on('cancel', () => finish(null))
    editor.key(['C-c'], closeDashboard)
    enableReadline(editor, history.entries(historyScope()), render)
    editor.focus()
    render()
  }
  output.key(['p', 'space'], () => { if (buffer.paused) resume(); else pause() })
  output.key(['end', 'G'], resume)
  output.key(['k', 'up', 'pageup', 'C-p'], pause)
  output.on('wheelup', pause)
  output.key(['/'], editFilter)
  const run = async args => {
    output.focus()
    draw()
    try {
      const result = await withAbort(execute(args, {
        signal: controller.signal,
        onOutput: chunk => {
          if (!current() || finished) return
          buffer.append(chunk)
          status = 'Streaming'
          if (!buffer.paused && !timer) {
            timer = setTimeout(() => { timer = null; draw() }, 100)
            timer.unref()
          }
        },
      }), controller.signal)
      if (!current()) return
      finished = true
      status = result.code === 0 ? 'Stream ended. Close and press L to reconnect.' : `Stream exited with ${result.signal ?? `code ${result.code}`}.`
      tone = result.code === 0 ? 'muted' : 'error'
      clearTimeout(timer)
      timer = null
      draw()
    } catch (error) {
      if (!current()) return
      finished = true
      status = `Log stream failed: ${errorMessage(error)}`
      tone = 'error'
      buffer.append(`\n${errorMessage(error)}\n`)
      clearTimeout(timer)
      timer = null
      draw()
    }
  }
  return {controller, modal, output, close: options => lifecycle.close(options), run}
}
