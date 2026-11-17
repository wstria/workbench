import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectMatches, replaceMatches } from '../src/renderer/lib/file-find.mjs'

test('previews literal replacements with source line numbers and case control', () => {
  const text = 'A [label]\nThe [LABEL]\n[label] again'
  const matches = inspectMatches(text, '[label]', '$&')
  assert.deepEqual(matches.preview.map((sample) => sample.line), [1, 2, 3])
  assert.deepEqual(matches.preview.map(({ before, match, after }) => [before, match, after]),
    [['A ', '[label]', ''], ['The ', '[LABEL]', ''], ['', '[label]', ' again']])
  assert.equal(replaceMatches(text, '[label]', '$&'), 'A $&\nThe $&\n$& again')
  assert.equal(replaceMatches(text, '[label]', 'literal', true), 'A literal\nThe [LABEL]\nliteral again')
})

test('limits replacement overflow and retains a bounded preview', () => {
  const result = inspectMatches('x'.repeat(10_000), 'x', 'x'.repeat(1000))
  assert.equal(result.count, 10_000)
  assert.equal(result.preview.length, 12)
  assert.equal(result.canReplace, false)
})
