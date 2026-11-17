import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorNotice, formatDate } from '@/components/workbench-ui'

const api = window.workbench
const blank = { title: '', content: '' }

export function MemorySettings() {
  const [data, setData] = useState({ records: [], proposals: [], enabled: true })
  const [draft, setDraft] = useState(blank)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    const load = () => api.memoryList().then((value) => { if (current) setData(value) })
      .catch((err) => { if (current) setError(err) })
    const stop = api.onChange(load)
    void load()
    return () => { current = false; stop() }
  }, [])

  async function run(action) {
    setBusy(true)
    setError(null)
    try { await action() } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return <div className="personal-settings">
    <label className="settings-list-row"><span className="settings-list-label"><strong>Use memory</strong><small>Include approved memories in agent context and allow memory suggestions.</small></span>
      <input type="checkbox" checked={data.enabled} disabled={busy} onChange={(event) => run(() => api.memoryEnabled(event.target.checked))} /></label>
    {data.proposals.length > 0 && <section>
      <h2>Review suggestions</h2>
      {data.proposals.map((item) => <div className="settings-list-row" key={item.id}>
        <span className="settings-list-label"><strong>{item.title}</strong><small>{item.targetId ? 'Suggested update' : 'New memory'} · {item.content}</small></span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => api.memoryDecide(item.id, false))}>Dismiss</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => api.memoryDecide(item.id, true))}>Approve</Button>
      </div>)}
    </section>}
    <section><h2>Saved memories</h2>
      {data.records.map((item) => <div className="settings-list-row" key={item.id}>
        <span className="settings-list-label"><strong>{item.title}</strong><small>{item.content} · {formatDate(item.at)}</small></span>
        <Button size="sm" variant="ghost" onClick={() => setDraft(item)}>Edit</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => { await api.memoryRemove(item.id); if (draft.id === item.id) setDraft(blank) })}>Remove</Button>
      </div>)}
      {!data.records.length && <p>No saved memories yet.</p>}
    </section>
    <form onSubmit={(event) => { event.preventDefault(); void run(async () => { await api.memorySave(draft); setDraft(blank) }) }}>
      <h2>{draft.id ? 'Edit memory' : 'Add a memory'}</h2>
      <label className="work-field">Title<Input value={draft.title} maxLength={100} required onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
      <label className="work-field">Memory<textarea maxLength={2000} required value={draft.content}
        placeholder="Prefer concise summaries with examples."
        onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label>
      <div className="work-actions">
        {draft.id && <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(blank)}>Cancel</Button>}
        <Button size="sm" variant="secondary" disabled={busy} type="submit">Save memory</Button>
      </div>
    </form>
    <ErrorNotice error={error} />
  </div>
}

export function ProfileSettings({ profile }) {
  const [name, setName] = useState(profile?.name ?? '')
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  return <form className="personal-settings" onSubmit={async (event) => {
    event.preventDefault()
    setError(null)
    try { await api.saveProfile({ name }); setSaved(true) } catch (err) { setError(err) }
  }}>
    <label className="work-field">Display name<Input value={name} maxLength={60} onChange={(event) => { setName(event.target.value); setSaved(false) }} /></label>
    <div className="work-actions"><Button type="submit" variant="secondary" size="sm">Save profile</Button>{saved && <small role="status">Saved</small>}</div>
    <ErrorNotice error={error} />
  </form>
}

export function WorkbenchPreferences({ preferences }) {
  const [draft, setDraft] = useState({ editorWrap: false, lineNumbers: true, ...preferences })
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  const change = (name, value) => { setDraft({ ...draft, [name]: value }); setSaved(false) }
  return <form className="personal-settings" onSubmit={async (event) => {
    event.preventDefault()
    setError(null)
    try { await api.savePreferences(draft); setSaved(true) } catch (err) { setError(err) }
  }}>
    <h2>Editor</h2>
    <label className="settings-list-row"><strong>Wrap long lines</strong><input type="checkbox" checked={draft.editorWrap}
      onChange={(event) => change('editorWrap', event.target.checked)} /></label>
    <label className="settings-list-row"><strong>Line numbers</strong><input type="checkbox" checked={draft.lineNumbers}
      onChange={(event) => change('lineNumbers', event.target.checked)} /></label>
    <div className="work-actions"><Button type="submit" variant="secondary" size="sm">Save preferences</Button>{saved && <small role="status">Saved</small>}</div>
    <ErrorNotice error={error} />
  </form>
}
