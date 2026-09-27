import {Transform} from 'node:stream'
import blessed from 'blessed'

const PREFIX = '\x1b]11;'
const QUERY = `${PREFIX}?\x07`

function themeForRGB(rgb) {
  const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
  // Choose light when dark text offers more contrast than white text.
  return luminance > 0.179 ? 'light' : 'dark'
}

export function themeForBackground(value) {
  const rgb = /^rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})$/i.exec(value)
  if (rgb) return themeForRGB(rgb.slice(1).map(channel => parseInt(channel, 16) / (16 ** channel.length - 1)))
  if (/^#[\da-f]{6}$/i.test(value)) return themeForRGB(blessed.colors.hexToRGB(value).map(channel => channel / 255))
  return null
}

export function environmentTheme(env = process.env) {
  const parts = env.COLORFGBG?.split(';') ?? []
  if (parts.length < 2 || parts.length > 3 || !parts.every(part => /^(?:\d+|default)$/.test(part))) return 'dark'
  const background = parts.at(-1)
  if (!/^\d{1,3}$/.test(background)) return 'dark'
  const rgb = blessed.colors.vcolors[Number(background)]
  return rgb ? themeForRGB(rgb.map(channel => channel / 255)) : 'dark'
}

// Blessed treats OSC response bytes as keystrokes. Filter background replies
// before its input parser, including fragmented replies and replies arriving
// after detection times out. All other input is forwarded byte-for-byte.
export class ThemeInput extends Transform {
  constructor(source) {
    super()
    this.source = source
    this.isTTY = source.isTTY
    this.prefix = ''
    this.response = null
    this.overflow = false
    source.pipe(this)
  }

  get isRaw() { return this.source.isRaw }
  setRawMode(value) { this.source.setRawMode?.(value); return this }

  _transform(chunk, _encoding, callback) {
    clearTimeout(this.prefixTimer)
    let text = ''
    for (const char of chunk.toString('latin1')) {
      if (this.response !== null) {
        // A truncated reply must never swallow the user's interrupt key.
        if (char === '\x03') { this.response = null; text += char; continue }
        this.response += char
        const end = char === '\x07' ? 1 : this.response.endsWith('\x1b\\') ? 2 : 0
        if (end) {
          if (!this.overflow) this.emit('background', this.response.slice(0, -end))
          this.response = null
        } else if (this.response.length > 128 || this.overflow) {
          this.overflow = true
          this.response = this.response.slice(-1)
        }
        continue
      }
      this.prefix += char
      while (this.prefix && !PREFIX.startsWith(this.prefix)) {
        text += this.prefix[0]
        this.prefix = this.prefix.slice(1)
      }
      if (this.prefix === PREFIX) {
        this.prefix = ''
        this.response = ''
        this.overflow = false
      }
    }
    if (text) this.push(Buffer.from(text, 'latin1'))
    // A lone Escape must still work as a key, rather than waiting indefinitely
    // for the rest of a possible OSC prefix.
    if (this.prefix) this.prefixTimer = setTimeout(() => this.flushPrefix(), 50)
    this.prefixTimer?.unref()
    callback()
  }

  flushPrefix() {
    clearTimeout(this.prefixTimer)
    if (this.prefix) this.push(Buffer.from(this.prefix, 'latin1'))
    this.prefix = ''
  }

  _flush(callback) { this.flushPrefix(); callback() }
  _destroy(error, callback) {
    clearTimeout(this.prefixTimer)
    this.source.unpipe(this)
    callback(error)
  }
}

export async function detectTerminalTheme({input, output, theme = 'auto', env = process.env, timeout = 200, signal}) {
  if (!['auto', 'light', 'dark'].includes(theme)) throw new Error(`Unknown theme: ${theme}`)
  if (theme !== 'auto') return theme
  const fallback = environmentTheme(env)
  if (!(input instanceof ThemeInput) || !input.isTTY || !output.isTTY || env.TERM === 'dumb' || signal?.aborted) return fallback
  return new Promise(resolve => {
    const finish = name => {
      clearTimeout(timer)
      input.removeListener('background', onBackground)
      input.removeListener('close', onUnavailable)
      input.removeListener('end', onUnavailable)
      output.removeListener('error', onUnavailable)
      signal?.removeEventListener('abort', onUnavailable)
      resolve(name)
    }
    const onBackground = value => {
      const name = themeForBackground(value)
      if (name) finish(name)
    }
    const onUnavailable = () => finish(fallback)
    const timer = setTimeout(onUnavailable, timeout)
    input.on('background', onBackground)
    input.once('close', onUnavailable)
    input.once('end', onUnavailable)
    output.once('error', onUnavailable)
    signal?.addEventListener('abort', onUnavailable, {once: true})
    try { output.write(QUERY) }
    catch { onUnavailable() }
  })
}
