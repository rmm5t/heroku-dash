import {errorMessage} from '../api.js'
import {createOutputPane} from './output-pane.js'
import {ansi, single} from './text.js'
import {icons, paint, shortcut} from './theme.js'

export function createCommandViewer({owner, appName, execute, render, setStatus, isCurrent = () => true, onClose = () => {}}) {
  let result = null
  const {modal, lifecycle, output, footer} = createOutputPane(owner, {
    label: ` ${icons.code}  Heroku CLI · ${single(appName)} `,
    onClose: ({restoreFocus}) => {
      if (!restoreFocus) return
      if (result) setStatus(result.code === 0 ? 'Heroku command completed.' : `Heroku command exited with ${result.signal ?? `code ${result.code}`}.`, result.code === 0 ? 'success' : 'warning')
      else setStatus('Heroku command stopped.', 'warning')
    },
  })
  const controller = new AbortController()
  const current = () => !owner.closed && !lifecycle.closed && isCurrent()
  lifecycle.addCleanup(() => { onClose(); controller.abort() })
  const run = async (args, invocation) => {
    footer.setContent(`${shortcut('Esc / q', 'close and stop')}   ${shortcut('j/k', 'scroll')}\n${paint('Running…', 'info')}`)
    let raw = `$ ${invocation}\n\n`
    const draw = chunk => {
      if (!current()) return
      raw = `${raw}${chunk}`.slice(-200_000)
      output.setContent(ansi(raw))
      output.setScrollPerc(100)
      render()
    }
    output.focus()
    draw('')
    try {
      result = await execute(args, {signal: controller.signal, onOutput: draw})
      if (!current()) return
      const status = result.code === 0 ? 'Completed successfully.' : `Exited with ${result.signal ?? `code ${result.code}`}.`
      footer.setContent(`${shortcut('Esc / q', 'close')}   ${shortcut('j/k', 'scroll')}\n${paint(status, result.code === 0 ? 'success' : 'warning')}`)
      render()
    } catch (error) {
      if (!current()) return
      result = {code: null, signal: 'error'}
      draw(`\n${errorMessage(error)}\n`)
      footer.setContent(`${shortcut('Esc / q', 'close')}   ${shortcut('j/k', 'scroll')}\n${paint('Command failed to start.', 'error')}`)
      render()
    }
  }
  return {controller, modal, output, close: options => lifecycle.close(options), run}
}
