import {spawn} from 'node:child_process'

const APP_CONFIRM_COMPATIBILITY = new Set(['pg:upgrade:run'])

function commandArguments(value) {
  const args = []
  let argument = ''
  let quote = null
  let escaped = false
  let started = false
  for (const character of String(value)) {
    if (escaped) {
      argument += character
      escaped = false
      started = true
    } else if (character === '\\' && quote !== "'") {
      escaped = true
      started = true
    } else if (quote) {
      if (character === quote) quote = null
      else argument += character
    } else if (character === '"' || character === "'") {
      quote = character
      started = true
    } else if (/\s/.test(character)) {
      if (started) { args.push(argument); argument = ''; started = false }
    } else {
      argument += character
      started = true
    }
  }
  if (quote) throw new Error(`Unterminated ${quote === "'" ? 'single' : 'double'} quote.`)
  if (escaped) throw new Error('Command cannot end with a backslash.')
  if (started) args.push(argument)
  return args
}

export function appConfirmCommands(commands) {
  const result = new Map()
  for (const command of commands ?? []) {
    const description = command.flags?.confirm?.description ?? ''
    const confirmsApp = /\bapp(?:lication)?(?:'s)? name\b|\bname of (?:the )?app(?:lication)?\b/i.test(description)
      || APP_CONFIRM_COMPATIBILITY.has(command.id)
    if (!command.flags?.app || !command.flags?.confirm || !confirmsApp) continue
    for (const id of [command.id, ...(command.aliases ?? []), ...(command.hiddenAliases ?? [])]) {
      result.set(id, command.flags.confirm.char ?? null)
    }
  }
  return result
}

export function scopedHerokuCommand(value, app, {appConfirm = new Map()} = {}) {
  const args = commandArguments(value)
  if (/^(?:.*[\\/])?heroku(?:\.cmd|\.exe)?$/i.test(args[0] ?? '')) args.shift()
  if (!args.length) throw new Error('Enter a Heroku command, such as logs --num 100.')
  if (args[0] === 'dash') throw new Error('heroku dash cannot be launched inside the dashboard.')
  if (!app?.trim()) throw new Error('Open an app before running a Heroku command.')
  const separator = args.indexOf('--')
  const options = separator < 0 ? args : args.slice(0, separator)
  if (options.some(arg => ['-a', '-r', '--app', '--remote'].includes(arg)
    || /^--(?:app|remote)=/.test(arg) || /^-[ar](?:=|\S)/.test(arg))) {
    throw new Error('App and remote selectors are not allowed; the current app is added automatically.')
  }
  if (appConfirm.has(args[0])) {
    const short = appConfirm.get(args[0])
    const values = []
    for (let offset = 0; offset < options.length; offset++) {
      const argument = options[offset]
      if (argument === '--confirm' || short && argument === `-${short}`) {
        values.push(options[++offset])
      } else if (argument.startsWith('--confirm=')) {
        values.push(argument.slice('--confirm='.length))
      } else if (short && argument.startsWith(`-${short}=`)) {
        values.push(argument.slice(short.length + 2))
      } else if (short && argument.startsWith(`-${short}`) && argument.length > 2) {
        values.push(argument.slice(2))
      }
    }
    if (values.some(confirm => confirm !== app)) {
      throw new Error(`--confirm must match the current app: ${app}`)
    }
    if (!values.length) args.splice(separator < 0 ? args.length : separator, 0, '--confirm', app)
  }
  const index = args.indexOf('--') < 0 ? args.length : args.indexOf('--')
  return [...args.slice(0, index), '--app', app, ...args.slice(index)]
}

export function formatHerokuCommand(args) {
  return `heroku ${args.map(arg => /^[a-zA-Z0-9_./:=+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`).join(' ')}`
}

export function isInteractiveHerokuCommand(args) {
  return ['console', 'run'].includes(args[0]) && !args.includes('--no-tty')
}

export function executeHerokuCommand(args, {signal, onOutput = () => {}, spawnProcess = spawn,
  executable = process.env.HEROKU_BINPATH || (process.platform === 'win32' ? 'heroku.cmd' : 'heroku'), environment = process.env,
  platform = process.platform, killProcess = process.kill} = {}) {
  if (signal?.aborted) return Promise.reject(new Error('Command cancelled.'))
  return new Promise((resolve, reject) => {
    const env = {...environment}
    if (env.NO_COLOR === undefined && env.FORCE_COLOR === undefined) env.FORCE_COLOR = '1'
    const detached = platform !== 'win32'
    const child = spawnProcess(executable, args, {
      detached,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      callback(value)
    }
    const abort = () => {
      if (detached && child.pid) {
        try { killProcess(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
      } else child.kill('SIGTERM')
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8')
      stream?.on('data', onOutput)
    }
    signal?.addEventListener('abort', abort, {once: true})
    child.once('error', error => finish(reject, error))
    child.once('close', (code, exitSignal) => finish(resolve, {code, signal: exitSignal}))
  })
}

export function executeInteractiveHerokuCommand(args, {signal, spawnProcess = spawn,
  executable = process.env.HEROKU_BINPATH || (process.platform === 'win32' ? 'heroku.cmd' : 'heroku'), environment = process.env} = {}) {
  if (signal?.aborted) return Promise.reject(new Error('Command cancelled.'))
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: 'inherit',
      env: {...environment},
    })
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      callback(value)
    }
    const abort = () => child.kill('SIGTERM')
    signal?.addEventListener('abort', abort, {once: true})
    child.once('error', error => finish(reject, error))
    child.once('close', (code, exitSignal) => finish(resolve, {code, signal: exitSignal}))
  })
}
