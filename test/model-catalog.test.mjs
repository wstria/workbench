import assert from 'node:assert/strict'
import test from 'node:test'
import { dollarLabel, filterModels, tokenLabel } from '../src/renderer/lib/model-catalog.mjs'

const models = [
  { id: 'swift', name: 'Swift 2', provider: 'Core', images: true, contextWindow: 128000, pricing: { input: 0.2, output: 0.5 } },
  { id: 'vision-pro', name: 'Vision Pro', provider: 'Local', images: true, reasoning: true, contextWindow: 32000 },
  { id: 'large', name: 'Large Chat', provider: 'Core', reasoning: true, contextWindow: 1000000, pricing: { input: 0, output: 0 } },
]

test('catalog combines normalized text search, provider and capability filters', () => {
  assert.deepEqual(filterModels(models, { query: ' CORE  swift ', provider: 'Core', capability: 'images' }), [models[0]])
  assert.deepEqual(filterModels(models, { query: 'large', capability: 'images' }), [])
})

test('catalog sorts known metadata before missing values without changing the source order', () => {
  assert.deepEqual(filterModels(models, { sort: 'price' }), [models[2], models[0], models[1]])
  assert.deepEqual(filterModels(models, { sort: 'context' }), [models[2], models[0], models[1]])
  assert.equal(models[0].id, 'swift')
  assert.equal(tokenLabel(128000), '128K')
  assert.equal(dollarLabel(0), '$0.00')
})
