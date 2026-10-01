import assert from 'node:assert/strict'
import test from 'node:test'
import {LogBuffer} from '../src/ui/log-buffer.js'
import {clean} from '../src/ui/text.js'

const highlight = '\x1b[48;5;236m'
const reset = '\x1b[49m'

function rendered(raw, filter) {
  const buffer = new LogBuffer()
  buffer.append(raw)
  buffer.filter = filter
  return buffer.render(highlight)
}

test('all literal and regex matches are highlighted, including overlapping matches and invalid regex literals', () => {
  assert.equal(rendered('ERROR error Error tail', 'error'), `${highlight}ERROR${reset} ${highlight}error${reset} ${highlight}Error${reset} tail`)
  assert.equal(rendered('status=500 status=502 end', 'status=5\\d{2}'), `${highlight}status=500${reset} ${highlight}status=502${reset} end`)
  assert.equal(rendered('ababa end', 'aba'), `${highlight}ababa${reset} end`)
  assert.equal(rendered('app[web.1] ready', '['), `app${highlight}[${reset}web.1] ready`)
  assert.equal(rendered('literal app[web.1] regex appw', 'app[web.1]'), `literal ${highlight}app[web.1]${reset} regex ${highlight}appw${reset}`)
})

test('highlights span ANSI style changes and restore the original background without resetting foreground colors', () => {
  const source = '\x1b[44;31mER\x1b[1mROR tail\x1b[0m'
  assert.equal(rendered(source, 'error'), `\x1b[44;31m${highlight}ER\x1b[1m${highlight}ROR\x1b[44m tail\x1b[0m`)
  assert.equal(rendered('\x1b[41mER\x1b[0mROR tail', 'error'), `\x1b[41m${highlight}ER\x1b[0m${highlight}ROR${reset} tail`)
  assert.equal(rendered('\x1b[48;2;10;20;30mERROR tail', 'error'), `\x1b[48;2;10;20;30m${highlight}ERROR\x1b[48;2;10;20;30m tail`)
  assert.equal(rendered('\x1b[48;5;25;38;2;0;10;20mERROR tail', 'error'), `\x1b[48;5;25;38;2;0;10;20m${highlight}ERROR\x1b[48;5;25m tail`)
  assert.equal(rendered('\x1b[48:2::10:20:30mERROR tail', 'error'), `\x1b[48:2::10:20:30m${highlight}ERROR\x1b[48:2::10:20:30m tail`)
  assert.equal(rendered('\x1b[44mERROR one\nERROR two', 'error'), `\x1b[44m${highlight}ERROR\x1b[44m one\n${highlight}ERROR\x1b[44m two`)
})

test('contrasting match foregrounds override log colors only inside matches and restore extended colors', () => {
  const buffer = new LogBuffer()
  const foreground = '\x1b[38;5;15m'
  buffer.append('\x1b[44;31mER\x1b[38;2;0;10;20mROR tail\nERROR again')
  buffer.filter = 'error'
  assert.equal(buffer.render(highlight, foreground),
    `\x1b[44;31m${highlight}${foreground}ER\x1b[38;2;0;10;20m${highlight}${foreground}ROR\x1b[44m\x1b[38;2;0;10;20m tail\n${highlight}${foreground}ERROR\x1b[44m\x1b[38;2;0;10;20m again`)
  buffer.clear()
  buffer.append('\x1b[91mER\x1b[0mROR tail')
  buffer.filter = 'error'
  assert.equal(buffer.render(highlight, foreground), `\x1b[91m${highlight}${foreground}ER\x1b[0m${highlight}${foreground}ROR${reset}\x1b[39m tail`)
  buffer.filter = ''
  assert.equal(buffer.render(highlight, foreground), buffer.content)
})

test('zero-width regexes leave text unchanged, and Unicode and case-folded offsets stay intact', () => {
  assert.equal(rendered('one\ntwo', '^'), 'one\ntwo')
  assert.equal(rendered('🙂 ERROR tail', 'error'), `🙂 ${highlight}ERROR${reset} tail`)
  assert.equal(rendered('İ ERROR', 'error'), `İ ${highlight}ERROR${reset}`)
  assert.equal(rendered('İ tail', 'i'), `${highlight}İ${reset} ta${highlight}i${reset}l`)
  assert.equal(clean(rendered('🙂', '.')), '🙂')
})

test('highlighting is display-only and clears with the filter while paused snapshots remain frozen', () => {
  const buffer = new LogBuffer()
  buffer.append('\x1b[31mERROR old\x1b[0m\n')
  buffer.filter = 'error'
  buffer.pause()
  const paused = buffer.render(highlight)
  buffer.append('ERROR new\n')
  assert.equal(buffer.render(highlight), paused)
  assert.ok(!buffer.raw.includes(highlight))
  buffer.resume()
  assert.match(clean(buffer.render(highlight)), /ERROR new/)
  buffer.filter = ''
  assert.equal(buffer.render(highlight), buffer.content)
  assert.ok(!buffer.render(highlight).includes(highlight))
})
