import assert from 'node:assert/strict'
import test from 'node:test'
import { PRESETS, accentInk, normalizeCustomThemes, resolvePalette } from '../src/renderer/lib/palettes.mjs'

test('restores custom theme colors and scheme while filling missing palette colors safely', () => {
  const [custom] = normalizeCustomThemes([
    { id: 'minimal', name: 'Collision', scheme: 'dark' },
    { id: 'custom-test', name: ' My palette ', scheme: 'light', accent: '#004aad',
      colors: { '--shell-stage': '#fbf8fe', '--shell-line': 'red', '--radius': '100px' } },
  ])
  assert.equal(custom.name, 'My palette')
  assert.equal(custom.colors['--shell-stage'], '#fbf8fe')
  assert.equal(custom.colors['--shell-line'], PRESETS.paper.colors['--shell-line'])
  assert.equal(custom.colors['--radius'], undefined)
  assert.equal(resolvePalette({ preset: custom.id, customThemes: [custom] }).scheme, 'light')
  assert.equal(resolvePalette({ preset: custom.id, accent: '#ffeedd', customThemes: [custom] }).accent, '#ffeedd')
  assert.equal(resolvePalette({ preset: 'missing' }).name, 'Minimal')
})

test('accent foreground changes with the accent luminance', () => {
  assert.equal(accentInk('#191919'), '#ffffff')
  assert.equal(accentInk('#ffe256'), '#000000')
})
