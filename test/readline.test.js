import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import test from 'node:test'
import {enableReadline} from '../src/ui/readline.js'

function textbox(value, {width = 8, censor = false} = {}) {
  const input = new EventEmitter()
  const positions = []
  const completed = []
  const rendered = []
  const coords = {xi: 10, yi: 5}
  Object.assign(input, {value, width, censor, iwidth: 2, itop: 1, ileft: 1,
    getValue() { return this.value },
    setContent(value) { this.content = value },
    _getCoords() { return coords },
    _done(error, value) { completed.push({error, value}) },
    __updateCursor() { assert.fail('The original Blessed cursor handler must be replaced') },
    screen: {focused: input, tabc: '    ', program: {cup(y, x) { positions.push({y, x}) }}},
  })
  input.on('move', input.__updateCursor)
  input.on('resize', input.__updateCursor)
  enableReadline(input, [], () => rendered.push(input.content))
  return {input, positions, completed, rendered, coords,
    key(name, modifiers = {}) { input._listener(null, {name, ...modifiers}) },
    type(value) { input._listener(value, {}) },
  }
}

test('readline adapter scrolls long input while retaining its complete value and cursor position', () => {
  const {input, key, positions, completed} = textbox('abcdef')
  assert.equal(input.content, 'bcdef')
  assert.deepEqual(positions.at(-1), {y: 6, x: 16})
  key('home')
  assert.equal(input.content, 'abcde')
  assert.deepEqual(positions.at(-1), {y: 6, x: 11})
  key('right')
  key('right')
  assert.deepEqual(positions.at(-1), {y: 6, x: 13})
  key('end')
  assert.equal(input.content, 'bcdef')
  assert.equal(input.getValue(), 'abcdef')
  assert.equal(input._value, 'abcdef')
  key('enter')
  assert.deepEqual(completed, [{error: null, value: 'abcdef'}])
})

test('readline adapter measures wide characters and expanded tabs in terminal columns', () => {
  const wide = textbox('a密b界c')
  assert.equal(wide.input.content, 'b界c')
  assert.deepEqual(wide.positions.at(-1), {y: 6, x: 15})
  wide.key('left')
  wide.key('left')
  assert.equal(wide.input.content, '密b界')
  assert.deepEqual(wide.positions.at(-1), {y: 6, x: 14})
  const tabs = textbox('a\tb')
  assert.equal(tabs.input.content, '    b')
  assert.deepEqual(tabs.positions.at(-1), {y: 6, x: 16})
  assert.equal(tabs.input.getValue(), 'a\tb')
})

test('readline adapter masks code points throughout editing while submitting the exact secret', () => {
  const {input, key, type, rendered, positions, completed} = textbox('密🔑secret', {censor: true})
  assert.equal(input.content, '*****')
  assert.deepEqual(positions.at(-1), {y: 6, x: 16})
  key('home')
  type('X')
  assert.equal(input.getValue(), 'X密🔑secret')
  assert.equal(input.content, '*****')
  assert.deepEqual(positions.at(-1), {y: 6, x: 12})
  key('e', {ctrl: true})
  key('u', {ctrl: true})
  assert.equal(input.content, '')
  key('y', {ctrl: true})
  assert.ok(rendered.every(content => /^\**$/.test(content)))
  key('return')
  assert.deepEqual(completed, [{error: null, value: 'X密🔑secret'}])
})

test('readline adapter replaces cursor hooks, honors focus and missing coordinates, and cancels cleanly', () => {
  const {input, key, coords, positions, completed} = textbox('draft')
  assert.equal(input.listenerCount('move'), 1)
  assert.equal(input.listenerCount('resize'), 1)
  assert.equal(input._updateCursor, input.__updateCursor)
  coords.xi = 20
  input.emit('move')
  assert.deepEqual(positions.at(-1), {y: 6, x: 26})
  input.screen.focused = null
  const count = positions.length
  input.emit('resize')
  assert.equal(positions.length, count)
  input.screen.focused = input
  input._getCoords = () => null
  input.emit('move')
  assert.equal(positions.length, count)
  key('escape')
  assert.deepEqual(completed, [{error: null, value: null}])
})
