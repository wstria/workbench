import { useEffect, useState } from 'react'
import { KeyRound, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ModelPicker } from '@/components/model-picker'
import { ErrorNotice, SearchField, Segments } from '@/components/workbench-ui'

const api = window.workbench
const providerFilters = [['all', 'All providers'], ['connected', 'Connected']]
const customDefaults = { name: '', api: 'openai-completions', baseUrl: '', models: '', key: '', noAuth: false,
  images: false, reasoning: false, contextWindow: 128000, maxTokens: 8192 }

function ProviderForm({ profile, formats, onClose }) {
  const [draft, setDraft] = useState({ ...customDefaults, ...profile, models: profile.models?.join('\n') ?? '', key: '' })
  const [work, setWork] = useState('')
  const [error, setError] = useState(null)
  const [suggestions, setSuggestions] = useState([])
  const [discovered, setDiscovered] = useState(false)
  const [selectedModel, setSelectedModel] = useState('')
  const set = (field, value) => setDraft((current) => ({ ...current, [field]: value }))
  const modelIds = draft.models.split('\n').map((line) => line.trim()).filter(Boolean)
  const format = formats.find(({ id }) => id === draft.api)
  const trimmedUrl = draft.baseUrl.trim().replace(/\/+$/, '')
  const normalizedUrl = draft.api === 'anthropic-messages' ? trimmedUrl.replace(/\/v1$/, '') : trimmedUrl
  const canReuseKey = profile.credential === 'keychain' && (!profile.custom ||
    (profile.api === draft.api && profile.baseUrl === normalizedUrl))

  async function perform(operation, action) {
    setError(null)
    setWork(operation)
    try { await action() } catch (err) { setError(err) } finally { setWork('') }
  }

  function save(event) {
    event.preventDefault()
    void perform('save', async () => {
      await api.saveProvider({ ...draft, models: modelIds, contextWindow: Number(draft.contextWindow), maxTokens: Number(draft.maxTokens) })
      onClose()
    })
  }

  return <form className="provider-form" onSubmit={save} aria-label={profile.custom ? 'Custom provider settings' : profile.name + ' connection'}>
    <div className="provider-form-heading"><KeyRound size={16} aria-hidden="true" /><h2>{profile.name || 'New custom provider'}</h2></div>
    {profile.custom && <>
      <div className="provider-field-grid">
        <div className="work-field"><Label htmlFor="connection-name">Name</Label><Input id="connection-name" value={draft.name} onChange={(event) => set('name', event.target.value)} required /></div>
        <div className="work-field"><Label htmlFor="connection-format">API format</Label>
          <Select value={draft.api} onValueChange={(value) => {
            set('api', value)
            if (value === 'google-generative-ai') set('noAuth', false)
            setSuggestions([])
            setDiscovered(false)
          }}>
            <SelectTrigger id="connection-format" className="provider-select"><SelectValue /></SelectTrigger>
            <SelectContent position="popper">{formats.map(({ id, name }) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>
      <div className="work-field"><Label htmlFor="connection-url">Base URL</Label>
        <Input id="connection-url" type="url" spellCheck={false} value={draft.baseUrl} placeholder={format?.example}
          onChange={(event) => { set('baseUrl', event.target.value); setSuggestions([]); setDiscovered(false) }} required />
      </div>
      {draft.api !== 'google-generative-ai' && <label className="setting-check"><input type="checkbox" checked={draft.noAuth} onChange={(event) => set('noAuth', event.target.checked)} /> No API key</label>}
    </>}
    {!draft.noAuth && <div className="work-field"><Label htmlFor="connection-key">API key</Label>
      <Input id="connection-key" type="password" value={draft.key} onChange={(event) => set('key', event.target.value)}
        autoComplete="new-password" spellCheck={false} placeholder={canReuseKey ? 'Saved in system credential storage' : 'Enter API key'}
        required={!profile.custom || !canReuseKey} />
    </div>}
    {profile.custom && <>
      <div className="work-field">
        <div className="provider-label-row"><Label htmlFor="connection-models">Model IDs</Label>
          <Button type="button" variant="outline" size="sm" disabled={!draft.baseUrl || Boolean(work)} onClick={() => perform('discover', async () => {
            const found = await api.discoverModels(draft)
            setSuggestions(found)
            setDiscovered(true)
            setSelectedModel('')
          })}>{work === 'discover' ? 'Finding models…' : 'Find models'}</Button>
        </div>
        <textarea id="connection-models" className="provider-model-input" rows={4} value={draft.models}
          placeholder="One model ID per line" spellCheck={false} onChange={(event) => set('models', event.target.value)} required />
        {discovered && !suggestions.length && <p className="settings-help">No models were listed. Enter the model IDs above.</p>}
        {suggestions.length > 0 && <div className="provider-suggestions">
          <ModelPicker label="Discovered models" value={selectedModel} className="provider-select"
            models={suggestions.filter((id) => !modelIds.includes(id)).map((id) => ({ id, name: id, provider: draft.name }))}
            onValueChange={setSelectedModel} />
          <Button type="button" size="sm" variant="outline" disabled={!selectedModel || modelIds.includes(selectedModel)} onClick={() => {
            set('models', [...modelIds, selectedModel].join('\n'))
            setSelectedModel('')
          }}>Add model</Button>
        </div>}
      </div>
      <details className="provider-advanced">
        <summary>Model capabilities and limits</summary>
        <div className="provider-field-grid">
          <div className="work-field"><Label htmlFor="connection-context">Context window</Label><Input id="connection-context" type="number" min={1} max={10000000} value={draft.contextWindow} onChange={(event) => set('contextWindow', event.target.value)} /></div>
          <div className="work-field"><Label htmlFor="connection-output">Max output tokens</Label><Input id="connection-output" type="number" min={1} value={draft.maxTokens} onChange={(event) => set('maxTokens', event.target.value)} /></div>
        </div>
        <div className="provider-flags">
          <label className="setting-check"><input type="checkbox" checked={draft.images} onChange={(event) => set('images', event.target.checked)} /> Supports images</label>
          <label className="setting-check"><input type="checkbox" checked={draft.reasoning} onChange={(event) => set('reasoning', event.target.checked)} /> Supports reasoning</label>
        </div>
      </details>
    </>}
    <ErrorNotice error={error} />
    <div className="provider-form-actions">
      {profile.id && (profile.custom || profile.credential === 'keychain') && <Button type="button" variant="ghost" disabled={Boolean(work)} onClick={() => {
        if (!confirm(profile.custom ? 'Remove this custom provider and its saved key?' : 'Disconnect this provider and remove its saved key?')) return
        void perform('remove', async () => { await api.removeProvider(profile.id); onClose() })
      }}>{profile.custom ? 'Remove provider' : 'Disconnect'}</Button>}
      <Button type="button" variant="ghost" onClick={onClose} disabled={Boolean(work)}>Cancel</Button>
      <Button type="submit" variant="secondary" disabled={Boolean(work)}>{work === 'save' ? 'Saving…' : 'Save provider'}</Button>
    </div>
  </form>
}

export function ProviderSettings({ data, active, openHarness }) {
  const [list, setList] = useState(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState(null)
  const revision = data.providerRevision
  useEffect(() => {
    if (!active) return
    let current = true
    api.listProviders().then((next) => { if (current) { setList(next); setError(null) } })
      .catch((err) => { if (current) setError(err) })
    return () => { current = false }
  }, [active, revision])

  const matches = (list?.providers ?? [])
    .filter((item) => (filter === 'all' || item.connected) && (item.name + ' ' + (item.baseUrl ?? '')).toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name))

  return <div className="provider-settings">
    <div className="provider-harness-note"><p>These connections supply models for Pi. OpenCode uses the providers connected in OpenCode.</p>
      <Button type="button" variant="ghost" size="sm" onClick={openHarness}>OpenCode setup</Button></div>
    <ErrorNotice error={error} />
    {selected && list ? <ProviderForm key={selected.id ?? 'new'} profile={selected} formats={list.formats} onClose={() => setSelected(null)} /> : <>
      <div className="settings-controls">
        <SearchField label="Search providers" value={query} onChange={setQuery} />
        <Button variant="outline" size="sm" disabled={!list} onClick={() => setSelected({ custom: true })}><Plus /> Add custom provider</Button>
      </div>
      <Segments label="Filter providers" value={filter} onChange={setFilter} options={providerFilters} />
      <div className="settings-list" aria-label="Providers">
        {matches.map((item) => <div key={item.id} className="settings-list-row">
          <span className="provider-mark" aria-hidden="true">{item.name.slice(0, 1)}</span>
          <div className="settings-list-label"><strong>{item.name}</strong><small>{item.custom && item.baseUrl + ' · '}{item.count} {item.count === 1 ? 'model' : 'models'}</small></div>
          {item.connected && <small className="provider-connected">{item.credential === 'environment' ? 'Environment key' : item.noAuth ? 'No key required' : 'Key saved'}</small>}
          <Button type="button" variant="outline" size="sm" aria-label={(item.connected ? 'Manage ' : 'Connect ') + item.name} onClick={() => setSelected(item)}>{item.connected ? 'Manage' : 'Connect'}</Button>
        </div>)}
        {list && !matches.length && <p className="settings-help">{query ? 'No providers match your search.' : 'No connected providers.'}</p>}
        {!list && !error && <p className="settings-help" role="status">Loading providers…</p>}
      </div>
    </>}
  </div>
}
