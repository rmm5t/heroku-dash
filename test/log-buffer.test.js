import assert from 'node:assert/strict'
import test from 'node:test'
import {LogBuffer} from '../src/ui/log-buffer.js'

test('log buffering joins fragmented records, sanitizes controls, and filters literal text case-insensitively', () => {
  const buffer = new LogBuffer()
  buffer.append('2026 app[web.1]: ER')
  buffer.append('ROR literal {red-fg} [.*]\n\x1b[31mnormal\x1b[0m\n\x1b]52;c;private')
  buffer.append('-payload\x07last line\n')
  assert.equal(buffer.content, '2026 app[web.1]: ERROR literal {red-fg} [.*]\nnormal\nlast line\n')
  buffer.filter = 'error'
  assert.equal(buffer.content, '2026 app[web.1]: ERROR literal {red-fg} [.*]')
  buffer.filter = '[.*]'
  assert.match(buffer.content, /ERROR/)
  buffer.filter = 'missing'
  assert.equal(buffer.content, '')
  buffer.filter = ''
  assert.match(buffer.content, /normal/)
})

test('log buffering bounds both record count and long unterminated lines', () => {
  const buffer = new LogBuffer({lines: 3, characters: 50})
  buffer.append('one\ntwo\nthree\nfour\n')
  assert.equal(buffer.content, 'two\nthree\nfour\n')
  buffer.append('five')
  assert.equal(buffer.content, 'three\nfour\nfive')
  buffer.append('x'.repeat(100))
  assert.equal(buffer.raw.length, 50)
  assert.equal(buffer.content, 'x'.repeat(50))
  buffer.append('\nnew record\n')
  assert.equal(buffer.content, 'new record\n')
  buffer.append('y'.repeat(100) + '\n')
  assert.equal(buffer.raw.length, 50)
  assert.equal(buffer.content, 'y'.repeat(49) + '\n')
  const aligned = new LogBuffer({characters: 8})
  aligned.append('old\none\ntwo\n')
  assert.equal(aligned.content, 'one\ntwo\n')
})

test('pausing freezes the displayed snapshot while new logs remain bounded and resuming shows the latest tail', () => {
  const buffer = new LogBuffer({lines: 2, characters: 100})
  buffer.append('old one\nold two\n')
  buffer.pause()
  buffer.append('new one\nnew two\nnew three\n')
  buffer.pause()
  assert.equal(buffer.content, 'old one\nold two\n')
  assert.equal(buffer.raw, 'new two\nnew three\n')
  buffer.filter = 'two'
  assert.equal(buffer.content, 'old two')
  buffer.resume()
  assert.equal(buffer.content, 'new two')
  buffer.clear()
  assert.equal(buffer.content, '')
  assert.equal(buffer.paused, false)
  assert.equal(buffer.filter, '')
})
