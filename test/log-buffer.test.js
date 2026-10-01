import assert from 'node:assert/strict'
import test from 'node:test'
import {LogBuffer} from '../src/ui/log-buffer.js'

test('log buffering joins fragmented records, sanitizes controls, and filters literal text case-insensitively', () => {
  const buffer = new LogBuffer()
  buffer.append('2026 app[web.1]: ER')
  buffer.append('ROR literal {red-fg} [.*]\n\x1b[31mnormal\x1b[0m\n\x1b]52;c;private')
  buffer.append('-payload\x07last line\n')
  assert.equal(buffer.content, '2026 app[web.1]: ERROR literal {red-fg} [.*]\n\x1b[31mnormal\x1b[0m\nlast line\n')
  buffer.filter = 'error'
  assert.equal(buffer.content, '2026 app[web.1]: ERROR literal {red-fg} [.*]')
  buffer.filter = '[.*]'
  assert.match(buffer.content, /ERROR/)
  buffer.filter = 'missing'
  assert.equal(buffer.content, '')
  buffer.filter = ''
  assert.match(buffer.content, /normal/)
})

test('log colors survive fragmented output, filtering, and pause without matching escape codes', () => {
  const buffer = new LogBuffer()
  buffer.append('\x1b[38;5;')
  buffer.append('196mER\x1b[1mROR\x1b[0m\n\x1b[2J\x1b[38;2;10;20;30mnormal\x1b[0m\n')
  buffer.filter = 'error'
  assert.equal(buffer.content, '\x1b[38;5;196mER\x1b[1mROR\x1b[0m')
  buffer.pause()
  buffer.append('\x1b[32mnew error\x1b[0m\n')
  assert.ok(!buffer.content.includes('new error'))
  buffer.resume()
  assert.match(buffer.content, /\x1b\[32mnew error\x1b\[0m/)
  buffer.filter = '196m'
  assert.equal(buffer.content, '')
  buffer.filter = 'normal'
  assert.equal(buffer.content, '\x1b[38;2;10;20;30mnormal\x1b[0m')
})

test('regex log filters support anchors, alternation, and character classes on visible text', () => {
  const buffer = new LogBuffer()
  buffer.append('\x1b[31mER\x1b[1mROR status=500 app[web.1]\x1b[0m\nWARN status=404 app[worker.1]\nINFO status=200 app[web.2]\n')
  buffer.filter = '^(error|warn)'
  const matching = '\x1b[31mER\x1b[1mROR status=500 app[web.1]\x1b[0m\nWARN status=404 app[worker.1]'
  assert.equal(buffer.content, matching)
  assert.equal(buffer.content, matching, 'Repeated reads must not alternate matches')
  buffer.filter = 'status=5\\d{2}\\b'
  assert.match(buffer.content, /status=500/)
  assert.ok(!buffer.content.includes('status=404'))
  buffer.filter = 'app\\[web\\.\\d+\\]$'
  assert.match(buffer.content, /status=500/)
  assert.match(buffer.content, /status=200/)
  assert.ok(!buffer.content.includes('worker'))
  buffer.filter = '31m'
  assert.equal(buffer.content, '')
  buffer.filter = 'app[web.1]'
  assert.match(buffer.content, /status=500/)
  buffer.filter = ''
  assert.match(buffer.content, /worker/)
})

test('regex matching works directly with paused snapshots and invalid regex syntax matches literally', () => {
  const buffer = new LogBuffer()
  buffer.append('error old\ninfo old\n')
  buffer.filter = '^error'
  buffer.pause()
  buffer.append('error new\n')
  assert.equal(buffer.content, 'error old')
  buffer.resume()
  assert.equal(buffer.content, 'error old\nerror new')
  buffer.append('literal [ and ( characters\n')
  buffer.filter = '['
  assert.equal(buffer.content, 'literal [ and ( characters')
  buffer.filter = '('
  assert.equal(buffer.content, 'literal [ and ( characters')
  buffer.clear()
  buffer.append('info after clearing\n')
  assert.equal(buffer.content, 'info after clearing\n')
})

test('valid regex metacharacters also remain usable as literal matching strings', () => {
  const buffer = new LogBuffer()
  buffer.append('literal app[web.1]\nregex appw\nunrelated worker\n')
  buffer.filter = 'app[web.1]'
  assert.equal(buffer.content, 'literal app[web.1]\nregex appw')
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
