import { useDeferredValue, useMemo, useState } from 'react'
import { Brain, Check, Cpu, Image, Route, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CatalogDialog } from '@/components/catalog-dialog'
import { autoModelId } from '@/lib/harnesses'
import { dollarLabel, filterModels, tokenLabel } from '@/lib/model-catalog.mjs'

const pageSize = 40
const providerHue = { openai: 153, anthropic: 25, google: 215, openrouter: 271, deepseek: 225, mistral: 34, groq: 15 }

function ModelRow({ model, current, choose, disabled, selectionLabel }) {
  const auto = model.id === autoModelId
  const native = model.id === '__default__' || model.id === '@native/default'
  const name = model.provider || 'Model'
  const hue = providerHue[model.providerId ?? model.providerID] ?? [...name].reduce((num, char) => num + char.charCodeAt(0), 0) % 360
  return <button type="button" className="model-row" data-model-result aria-pressed={current}
    disabled={disabled} onClick={() => choose(model.id)}>
    <span className="catalog-mark" style={{ '--mark-hue': hue }}>{auto ? <Route size={18} aria-hidden="true" />
      : <span aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>}</span>
    <span className="model-row-copy">
      <strong>{model.name}</strong>
      <small>{auto ? 'Choose using your routing rules' : native && !model.provider ? 'Use the harness setting' :
        [model.provider, model.modelId && model.modelId !== model.name ? model.modelId : null].filter(Boolean).join(' · ')}</small>
      {(model.contextWindow > 0 || model.images || model.reasoning) && <span className="model-capabilities">
        {model.contextWindow > 0 && <span>{tokenLabel(model.contextWindow)} context</span>}
        {model.images && <span><Image size={12} aria-hidden="true" />Images</span>}
        {model.reasoning && <span><Brain size={12} aria-hidden="true" />Reasoning</span>}
      </span>}
    </span>
    <span className="model-row-aside">
      {model.pricing && <span className="model-pricing">
        <span>{dollarLabel(model.pricing.input)} in</span><span>{dollarLabel(model.pricing.output)} out</span><small>per 1M tokens</small>
      </span>}
      {current ? <span className="model-selected"><Check size={15} aria-hidden="true" />{selectionLabel}</span> : null}
    </span>
  </button>
}

function Filter({ label, value, update, options }) {
  return <Select value={value} onValueChange={update}>
    <SelectTrigger aria-label={label} className="catalog-filter"><SelectValue /></SelectTrigger>
    <SelectContent position="popper" className="catalog-filter-menu">
      {options.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
    </SelectContent>
  </Select>
}

export function ModelCatalog({ models, value, onValueChange, disabled, loading, selectionLabel, compact }) {
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState('all')
  const [capability, setCapability] = useState('all')
  const [sort, setSort] = useState('catalog')
  const [limit, setLimit] = useState(pageSize)
  const deferredQuery = useDeferredValue(query)
  const providers = useMemo(() => [...new Set(models.map(({ provider }) => provider).filter(Boolean))].sort(), [models])
  const selectedProvider = providers.some((name) => 'provider:' + name === provider) ? provider : 'all'
  const options = [['all', 'All capabilities'], ...(models.some((row) => row.images) ? [['images', 'Images']] : []),
    ...(models.some((row) => row.reasoning) ? [['reasoning', 'Reasoning']] : [])]
  const matches = useMemo(() => filterModels(models, { query: deferredQuery,
    provider: selectedProvider === 'all' ? '' : selectedProvider.slice(9), capability: capability === 'all' ? '' : capability, sort
  }), [models, deferredQuery, selectedProvider, capability, sort])
  const change = (set) => (value) => { set(value); setLimit(pageSize) }
  const filters = selectedProvider !== 'all' || capability !== 'all' || sort !== 'catalog' || query
  return <div className={'model-catalog' + (compact ? ' model-catalog-dialog' : '')}>
    <div className="model-catalog-tools">
      <div className="work-search catalog-search">
        <Search size={16} aria-hidden="true" />
        <Input data-catalog-autofocus type="search" aria-label="Search models" placeholder="Search models" value={query} onChange={(event) => change(setQuery)(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              event.currentTarget.closest('.model-catalog').querySelector('[data-model-result]:not(:disabled)')?.focus()
            }
            if (event.key === 'Enter' && deferredQuery === query && matches.length === 1 && !disabled) {
              event.preventDefault()
              onValueChange(matches[0].id)
            }
          }} />
      </div>
      {(providers.length > 1 || options.length > 1 || !compact) && <div className="catalog-filters">
        {providers.length > 1 && <Filter label="Filter models by provider" value={selectedProvider} update={change(setProvider)}
          options={[[ 'all', 'All providers' ], ...providers.map((name) => ['provider:' + name, name])]} />}
        {options.length > 1 && <Filter label="Filter models by capability" value={capability} update={change(setCapability)} options={options} />}
        {!compact && <Filter label="Sort models" value={sort} update={change(setSort)} options={[
          ['catalog', 'Catalog order'], ['name', 'Name'], ...(models.some((row) => row.contextWindow > 0) ? [['context', 'Largest context']] : []),
          ...(models.some((row) => row.pricing) ? [['price', 'Lowest input price']] : []),
        ]} />}
      </div>}
    </div>
    <div className="model-catalog-caption">
      <p role="status">{loading ? 'Loading models…' : matches.length + (matches.length === 1 ? ' model' : ' models')}</p>
      {filters && <Button type="button" variant="ghost" size="xs" onClick={() => {
        setQuery(''); setProvider('all'); setCapability('all'); setSort('catalog'); setLimit(pageSize)
      }}>Clear filters</Button>}
    </div>
    <div className="model-results" aria-label="Models" onKeyDown={(event) => {
      if (!event.target.matches('[data-model-result]') || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
      event.preventDefault()
      const other = event.key === 'ArrowUp' ? event.target.previousElementSibling : event.target.nextElementSibling
      if (other?.matches('[data-model-result]')) other.focus()
      else if (event.key === 'ArrowUp') event.currentTarget.parentElement.querySelector('input')?.focus()
    }}>
      {matches.slice(0, limit).map((model) => <ModelRow key={model.id} model={model} current={value === model.id} choose={onValueChange}
        disabled={disabled} selectionLabel={selectionLabel} />)}
      {!matches.length && !loading && <p className="model-empty">{models.length ? 'No models match these filters.' : 'No models available for this harness.'}</p>}
      {matches.length > limit && <Button type="button" variant="ghost" size="sm" className="model-show-more" onClick={() => setLimit((value) => value + pageSize)}>Show more models</Button>}
    </div>
  </div>
}

export function ModelPicker({ models, value, onValueChange, onOpenChange, defaultLabel, className, label, loading, disabled, id, harnessName }) {
  const choices = useMemo(() => defaultLabel ? [{ id: '__default__', name: defaultLabel }, ...models] : models, [models, defaultLabel])
  const name = choices.find((item) => item.id === value)?.name ?? (loading ? 'Loading models…' : choices.length ? 'Choose model' : 'No models available')
  return <CatalogDialog title="Choose a model" description={harnessName ? 'Browse models available through ' + harnessName + '.' : 'Browse the models available for this chat.'}
    label={label} id={id} name={name} icon={Cpu} className={className} disabled={disabled || (!choices.length && !loading)} onOpenChange={onOpenChange}>
    {(close) => <ModelCatalog compact models={choices} value={value} loading={loading} onValueChange={(id) => {
      onValueChange(id)
      close()
    }} />}
  </CatalogDialog>
}
