export function filterModels(models, { query = '', provider = '', capability = '', sort = 'catalog' } = {}) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const result = models.filter((model) => {
    const index = [model.name, model.provider, model.modelId, model.id, model.images && 'images', model.reasoning && 'reasoning'].join(' ').toLowerCase()
    return (!provider || model.provider === provider) && (!capability || model[capability] === true) &&
      words.every((word) => index.includes(word))
  })
  if (sort === 'context') result.sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0))
  if (sort === 'price') result.sort((a, b) => (a.pricing?.input ?? Infinity) - (b.pricing?.input ?? Infinity))
  if (sort === 'name') result.sort((a, b) => a.name.localeCompare(b.name))
  return result
}

export function tokenLabel(value) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(value)
}

export function dollarLabel(value) {
  return '$' + new Intl.NumberFormat('en', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)
}
