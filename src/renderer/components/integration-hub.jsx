import { useCallback, useEffect, useState } from 'react'
import { BookOpen, Braces, Check, ChevronDown, CircleOff, FilePlus2, Globe, LoaderCircle, Mail, Plug, Plus, Puzzle, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Empty, ErrorNotice, Page, SearchField } from '@/components/workbench-ui'
import './integration-hub.css'

const api = window.workbench
const filters = { all: null, skills: 'skill', skill: 'skill', mcp: 'mcp', extensions: 'extension', extension: 'extension', plugins: 'extension' }

function IconFor({ row }) {
  const Icon = row.kind === 'skill' ? BookOpen : row.kind === 'extension' ? Puzzle : row.transport === 'stdio' ? Terminal : row.transport === 'http' ? Globe : Braces
  return <span className="integration-icon"><Icon size={18} aria-hidden="true" /></span>
}

function startEntry(kind, row) {
  if (kind === 'skill') return { name: '', description: '', body: '', enabled: true, ...row, kind }
  return { name: '', description: '', transport: 'http', url: '', command: '', args: [], enabled: true, ...row, kind, token: '', secretText: '', clearSecrets: false }
}

function parsePairs(value) {
  const pairs = value.split('\n').filter((line) => line.trim()).map((line) => {
    const equals = line.indexOf('=')
    if (equals < 1) throw new Error('Use NAME=value for each entry.')
    return [line.slice(0, equals).trim(), line.slice(equals + 1)]
  })
  return Object.fromEntries(pairs)
}

function IntegrationEditor({ initial, busy, onCancel, onSave }) {
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState(null)
  const change = (key, value) => setDraft((old) => ({ ...old, [key]: value }))
  const isSkill = draft.kind === 'skill'
  const isRemote = draft.transport === 'http'
  const hasPreset = draft.builtin && draft.kind === 'mcp'
  const title = draft.id ? 'Edit ' + draft.name : isSkill ? 'Create a skill' : 'Add MCP server'

  async function submit(event) {
    event.preventDefault()
    setError(null)
    try {
      const { secretText, ...row } = draft
      await onSave(isSkill ? row : { ...row, args: row.args.filter((item) => item.trim()), secrets: parsePairs(secretText) })
    } catch (saveError) {
      setError(saveError)
    }
  }

  return <form className="integration-editor" aria-label={title} onSubmit={submit}>
    <header className="integration-editor-header">
      <h2>{title}</h2>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
    </header>
    <div className="integration-editor-fields">
      {(!hasPreset || isSkill) && <>
        <label>
          {isSkill ? 'Skill name' : 'Name'}
          <Input value={draft.name} placeholder={isSkill ? 'meeting-notes' : 'Project search'} maxLength={isSkill ? 64 : 80}
            required onChange={(event) => change('name', event.target.value)} />
        </label>
        <label>
          {isSkill ? 'When to use this skill' : 'Description'}
          <Input value={draft.description} maxLength={isSkill ? 1024 : 400} required={isSkill}
            placeholder={isSkill ? 'Use when summarizing a meeting transcript' : 'What does this connection do?'}
            onChange={(event) => change('description', event.target.value)} />
        </label>
      </>}
      {isSkill ? <>
        <label>
          Instructions
          <textarea className="integration-textarea" rows={9} value={draft.body} maxLength={48000} required
            placeholder="Tell the agent what to do, what sources to use, and how to present the result."
            onChange={(event) => change('body', event.target.value)} />
        </label>
        {draft.importedPath && <p className="integration-form-detail">Saves an editable copy in Workbench. The imported file stays in its original folder.</p>}
      </> : <>
        {!hasPreset && <label>
          Transport
          <select className="integration-select" value={draft.transport} onChange={(event) => change('transport', event.target.value)}>
            <option value="http">Streamable HTTP</option>
            <option value="stdio">Local command (stdio)</option>
          </select>
        </label>}
        {isRemote ? <>
          <label>
            Server URL
            <Input type="url" value={draft.url} placeholder="https://mcp.example.com/mcp" readOnly={hasPreset}
              required onChange={(event) => change('url', event.target.value)} />
          </label>
          <label>
            {draft.credentialHint || 'Bearer token (optional)'}
            <Input type="password" value={draft.token} autoComplete="off"
              placeholder={draft.hasSecrets ? 'Stored in system credential storage' : ''}
              onChange={(event) => change('token', event.target.value)} />
          </label>
          {draft.setupHint && <p className="integration-form-detail">{draft.setupHint}</p>}
        </> : <>
          <label>
            Executable
            <Input value={draft.command} placeholder="npx or /path/to/server" required
              onChange={(event) => change('command', event.target.value)} />
          </label>
          <label>
            Arguments, one per line
            <textarea className="integration-textarea" rows={3} value={draft.args.join('\n')} placeholder={'-y\nexample-mcp-server'}
              onChange={(event) => change('args', event.target.value.split('\n'))} />
          </label>
          <p className="integration-form-detail">Local commands run with your account’s access. Add a command you trust.</p>
        </>}
        {!hasPreset && <details className="integration-advanced">
          <summary>Connection options <ChevronDown size={14} aria-hidden="true" /></summary>
          <label>
            {isRemote ? 'HTTP headers' : 'Environment variables'}
            <textarea className="integration-textarea" rows={3} value={draft.secretText} placeholder="NAME=value"
              onChange={(event) => change('secretText', event.target.value)} />
          </label>
          <label className="integration-toggle-row">
            <input type="checkbox" checked={Boolean(draft.allowAutomation)} onChange={(event) => change('allowAutomation', event.target.checked)} />
            <span>Offer read-only tools to automations</span>
          </label>
        </details>}
        {draft.hasSecrets && <label className="integration-toggle-row">
          <input type="checkbox" checked={draft.clearSecrets} onChange={(event) => change('clearSecrets', event.target.checked)} />
          <span>Clear saved credentials</span>
        </label>}
      </>}
      <label className="integration-toggle-row">
        <input type="checkbox" checked={draft.enabled} onChange={(event) => change('enabled', event.target.checked)} />
        <span>Enable for agents</span>
      </label>
      <ErrorNotice error={error} />
      <footer className="integration-editor-footer">
        <Button type="submit" size="sm" disabled={busy}>{busy ? 'Saving…' : draft.id ? 'Save changes' : isSkill ? 'Create skill' : 'Add server'}</Button>
      </footer>
    </div>
  </form>
}

function IntegrationRow({ row, busy, result, onToggle, onEdit, onTemplate, onRemove, onInspect, openWeb }) {
  const isMcp = row.kind === 'mcp'
  const canEdit = row.builtin ? isMcp && row.transport === 'http' : row.kind !== 'extension'
  const secondary = row.kind === 'skill' ? 'Skill' : row.kind === 'extension' ? 'Pi extension' : row.transport === 'http' ? 'Remote MCP' : row.transport === 'stdio' ? 'Local MCP' : 'Built-in MCP'
  return <article className="integration-card">
    <header className="integration-card-header">
      <IconFor row={row} />
      <div className="integration-card-name">
        <strong>{row.name}</strong>
        <small>{secondary}{row.enabled && <span> · Enabled</span>}</small>
      </div>
      <button type="button" role="switch" aria-label={'Enable ' + row.name} aria-checked={row.enabled} onClick={onToggle}
        disabled={busy === row.id} className="integration-switch"><span /></button>
    </header>
    {row.description && <p>{row.description}</p>}
    {row.extensionPath && <small className="integration-path" title={row.extensionPath}>{row.extensionPath}</small>}
    <footer className="integration-card-actions">
      {isMcp && <Button type="button" size="sm" variant="ghost" disabled={busy === row.id} onClick={onInspect}>
        {busy === row.id ? <LoaderCircle className="work-spin" aria-hidden="true" /> : <Plug aria-hidden="true" />} Test connection
      </Button>}
      {canEdit && <Button type="button" size="sm" variant="ghost" disabled={busy === row.id} onClick={onEdit}>
        {row.requiresCredential && !row.hasSecrets ? 'Add token' : 'Edit'}
      </Button>}
      {row.builtin && row.kind === 'skill' && <Button type="button" size="sm" variant="ghost" onClick={onTemplate}>Use as template</Button>}
      {!row.builtin && <Button type="button" size="sm" variant="ghost" disabled={busy === row.id} onClick={onRemove}>Remove</Button>}
      {row.reference && openWeb && <Button type="button" size="sm" variant="ghost" onClick={() => openWeb(row.reference)}>Docs</Button>}
    </footer>
    {result && <details open className="integration-test">
      <summary><Check size={14} aria-hidden="true" /> Connected · {result.tools.length} {result.tools.length === 1 ? 'tool' : 'tools'}</summary>
      <ul>{result.tools.map((tool) => <li key={tool.name}><code>{tool.name}</code>{tool.description && <small>{tool.description}</small>}</li>)}</ul>
    </details>}
  </article>
}

export function IntegrationHub({ openHarnessSettings, openProvider, openWeb, openInbox, filter = 'all' }) {
  const [rows, setRows] = useState([])
  const [status, setStatus] = useState('loading')
  const [busy, setBusy] = useState(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState(null)
  const [editor, setEditor] = useState(null)
  const [results, setResults] = useState({})
  const refresh = useCallback(async () => {
    try {
      setRows(await api.listIntegrations())
      setStatus('loaded')
    } catch (loadError) {
      setError(loadError)
      setStatus('failed')
    }
  }, [])

  useEffect(() => {
    void refresh()
    return api.onChange(refresh)
  }, [refresh])

  async function perform(id, action) {
    setBusy(id)
    setError(null)
    try {
      const result = await action()
      await refresh()
      return result
    } finally {
      setBusy(null)
    }
  }

  const run = (id, action) => perform(id, action).catch(setError)
  const criterion = filters[filter]
  const visible = rows.filter((row) => (!criterion || row.kind === criterion) && [row.name, row.description, row.id].some((value) =>
    value?.toLowerCase().includes(query.trim().toLowerCase())))

  function toggle(row) {
    if (!row.enabled && row.requiresCredential && !row.hasSecrets) {
      setEditor(startEntry('mcp', { ...row, enabled: true }))
      return
    }
    run(row.id, () => api.toggleIntegration(row.id, !row.enabled))
  }

  const heading = criterion === 'skill' ? 'Skills' : criterion === 'mcp' ? 'MCP servers' : criterion === 'extension' ? 'Extensions' : 'Integrations'
  return <Page title={heading} description="Equip your agents with skills, MCP tools, and extensions."
    actions={<>
      <Button size="sm" variant="outline" onClick={openInbox}><Mail /> Inbox triage</Button>
      <Button size="sm" variant="outline" onClick={openHarnessSettings}>Harness settings</Button>
      <Button size="sm" variant="outline" onClick={openProvider}>Model providers</Button>
    </>}>
    <div className="integration-toolbar">
      <SearchField label="Find integrations" value={query} onChange={setQuery} />
      <div className="integration-toolbar-actions">
        <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => run('import-skill', api.importSkill)}>
          <FilePlus2 aria-hidden="true" /> Import skill
        </Button>
        <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => run('import-extension', api.importExtension)}>
          <Puzzle aria-hidden="true" /> Import Pi extension
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setEditor(startEntry('skill'))}><BookOpen aria-hidden="true" /> Create skill</Button>
        <Button size="sm" onClick={() => setEditor(startEntry('mcp'))}><Plus aria-hidden="true" /> Add MCP</Button>
      </div>
    </div>
    <ErrorNotice error={error} />
    {editor && <IntegrationEditor key={editor.id ?? editor.kind} initial={editor} busy={busy === 'save'} onCancel={() => setEditor(null)}
      onSave={async (entry) => {
        await perform('save', () => api.saveIntegration(entry))
        setEditor(null)
      }} />}
    {status === 'loading' ? <p className="integration-loading" role="status">Loading integrations…</p>
      : visible.length ? <div className="integration-catalog">
        {visible.map((row) => <IntegrationRow key={row.id} row={row} busy={busy} result={results[row.id]} openWeb={openWeb}
          onToggle={() => toggle(row)} onEdit={() => setEditor(startEntry(row.kind, row))}
          onTemplate={() => setEditor(startEntry('skill', { name: row.name + '-custom', description: row.description, body: row.body }))}
          onRemove={() => run(row.id, () => api.removeIntegration(row.id))}
          onInspect={() => run(row.id, async () => {
            setResults((old) => ({ ...old, [row.id]: null }))
            const result = await api.inspectIntegration(row.id)
            setResults((old) => ({ ...old, [row.id]: result }))
          })} />)}
      </div> : status !== 'failed' && <Empty icon={CircleOff} title={query ? 'No matches' : 'Nothing in this category yet'} />}
  </Page>
}
