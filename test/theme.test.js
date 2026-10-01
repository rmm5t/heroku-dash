import assert from 'node:assert/strict'
import test from 'node:test'
import blessed from 'blessed'
import {palettes} from '../src/ui/theme.js'

// Check actual xterm-256 colors, since Blessed quantizes the hex palette.
function luminance(color) {
  const rgb = blessed.colors.vcolors[blessed.colors.convert(color)]
    .map(channel => channel / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
}

test('both themes provide readable text and semantic colors after terminal quantization', () => {
  assert.deepEqual(Object.keys(palettes.light).sort(), Object.keys(palettes.dark).sort())
  for (const [name, palette] of Object.entries(palettes)) {
    const contrast = (foreground, background) => {
      const values = [luminance(palette[foreground]), luminance(palette[background])].sort((a, b) => b - a)
      assert.ok((values[0] + 0.05) / (values[1] + 0.05) >= 4.5, `${name}: ${foreground} on ${background}`)
    }
    for (const foreground of ['fg', 'muted', 'accent', 'success', 'warning', 'error', 'info', 'cyan']) {
      contrast(foreground, 'bg')
      contrast(foreground, 'panel')
    }
    contrast('selectedFg', 'selected')
    contrast('selectedInactiveFg', 'selectedInactive')
    contrast('logMatchFg', 'logMatch')
  }
})
