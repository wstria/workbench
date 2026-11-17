import { useEffect, useState } from 'react'
import { Download, FolderOpen, RotateCw, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorNotice } from '@/components/workbench-ui'

const api = window.workbench
const engines = { google: 'Google', duckduckgo: 'DuckDuckGo', bing: 'Bing', brave: 'Brave Search', yahoo: 'Yahoo', ecosia: 'Ecosia', startpage: 'Startpage' }

function BrowserImport() {
  const [profiles, setProfiles] = useState(null)
  const [profile, setProfile] = useState('')
  const [mac, setMac] = useState(false)
  const [preview, setPreview] = useState(null)
  const [bookmarks, setBookmarks] = useState(false)
  const [preferences, setPreferences] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState(null)

  function updateProfiles(items) {
    setProfiles(items)
    setProfile((current) => items.some(({ id }) => id === current) ? current : items[0]?.id ?? '')
  }

  useEffect(() => {
    let active = true
    api.browserImportProfiles().then((items) => {
      if (active) updateProfiles(items)
    }).catch((err) => { if (active) { setProfiles([]); setError(err) } })
    api.platform().then((platform) => { if (active) setMac(platform === 'darwin') }).catch(() => {})
    return () => { active = false }
  }, [])

  async function run(operation) {
    setBusy(true)
    setError(null)
    setStatus('')
    try { await operation() }
    catch (err) { setError(err) }
    finally { setBusy(false) }
  }

  function load(source) {
    return run(async () => {
      const next = await source()
      if (!next) return
      setPreview(next)
      setBookmarks(next.bookmarkCount > 0)
      setPreferences(Object.keys(next.preferences).length > 0)
    })
  }

  function apply() {
    return run(async () => {
      const result = await api.browserApplyImport(preview.token, { bookmarks, preferences })
      const summary = []
      if (bookmarks) summary.push(result.added + (result.added === 1 ? ' bookmark imported' : ' bookmarks imported'))
      if (result.duplicates) summary.push(result.duplicates + ' already in Favorites')
      if (result.preferences) summary.push(result.preferences + (result.preferences === 1 ? ' preference applied' : ' preferences applied'))
      setStatus(summary.join(' · '))
      setPreview(null)
    })
  }

  const fields = preview?.preferences ?? {}
  const importedSettings = [
    fields.searchEngine && engines[fields.searchEngine],
    fields.homePage !== undefined && (fields.homePage || 'Default home page'),
    fields.showBookmarksBar !== undefined && (fields.showBookmarksBar ? 'Bookmarks bar shown' : 'Bookmarks bar hidden'),
  ].filter(Boolean)

  return <section className="personal-settings">
    <h2>Import browser data</h2>
    <div className="settings-list-row">
      <label htmlFor="browser-import-profile" className="settings-list-label">
        <strong>Browser profile</strong>
        <small>Chrome, Edge, Brave, Chromium and Vivaldi</small>
      </label>
      <div className="work-actions">
        <select id="browser-import-profile" value={profile} disabled={busy || !profiles?.length}
          onChange={(event) => { setProfile(event.target.value); setPreview(null) }}>
          {!profiles?.length && <option value="">{profiles ? 'No profiles found' : 'Looking for profiles…'}</option>}
          {profiles?.map(({ id, browser, name }) => <option key={id} value={id}>{browser} · {name}</option>)}
        </select>
        <Button type="button" variant="secondary" size="sm" disabled={busy || !profile}
          onClick={() => load(() => api.browserPreviewProfile(profile))}>Preview import</Button>
        <Button type="button" variant="ghost" size="icon-sm" disabled={busy} aria-label="Refresh browser profiles" title="Refresh browser profiles"
          onClick={() => run(async () => updateProfiles(await api.browserImportProfiles()))}><RotateCw /></Button>
      </div>
    </div>
    <div className="work-actions browser-import-actions">
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => load(() => api.browserChooseImport('bookmarks'))}>
        <Upload /> Choose bookmarks file
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => load(() => api.browserChooseImport('profile'))}>
        <FolderOpen /> Choose profile folder
      </Button>
    </div>
    <p className="settings-description">Use a bookmarks HTML file from any browser, or a Safari export ZIP.</p>
    {preview && <div className="browser-import-preview">
      <h3>{preview.name}</h3>
      {preview.bookmarkCount > 0 && <label className="settings-list-row">
        <span className="settings-list-label"><strong>Bookmarks ({preview.bookmarkCount.toLocaleString()})</strong><small>Save to Favorites with their folders.</small></span>
        <input type="checkbox" checked={bookmarks} disabled={busy} onChange={(event) => setBookmarks(event.target.checked)} />
      </label>}
      {importedSettings.length > 0 && <label className="settings-list-row">
        <span className="settings-list-label"><strong>Browser preferences</strong><small title={importedSettings.join(' · ')}>{importedSettings.join(' · ')}</small></span>
        <input type="checkbox" checked={preferences} disabled={busy} onChange={(event) => setPreferences(event.target.checked)} />
      </label>}
      {!preview.bookmarkCount && !importedSettings.length && <p>No supported bookmarks or preferences found.</p>}
      {preview.skipped > 0 && <small>{preview.skipped.toLocaleString()} unsupported or excess bookmark entries skipped.</small>}
      {preview.warnings.map((warning) => <small key={warning}>{warning}</small>)}
      <div className="work-actions">
        <Button type="button" variant="secondary" size="sm" disabled={busy || (!bookmarks && !preferences)} onClick={apply}>Import selected</Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setPreview(null)}>Cancel</Button>
      </div>
    </div>}
    <div className="browser-import-signin">
      <h3>Chrome account</h3>
      <p>Sign in to Chrome first to bring account bookmarks onto this computer. Then choose that profile above. Workbench keeps its own website sign-ins.</p>
      <div className="work-actions">
        {mac && <Button type="button" variant="outline" size="sm" onClick={() => api.browserOpenChrome().catch(setError)}>Open Chrome</Button>}
        <Button type="button" variant="link" size="sm" onClick={() => api.browserChromeHelp().catch(setError)}>Chrome sign-in help</Button>
      </div>
    </div>
    <div className="settings-list-row">
      <div className="settings-list-label"><strong>Export bookmarks</strong><small>Save web Favorites as a bookmarks HTML file.</small></div>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => run(async () => {
        if (await api.browserExportBookmarks()) setStatus('Bookmarks exported')
      })}><Download /> Export HTML</Button>
    </div>
    {status && <p role="status">{status}</p>}
    <ErrorNotice error={error} />
  </section>
}

function BrowserPreferences({ searchEngine, homePage, showBookmarksBar }) {
  const [draft, setDraft] = useState({ searchEngine, homePage, showBookmarksBar })
  const [error, setError] = useState(null)
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { setDraft({ searchEngine, homePage, showBookmarksBar }) }, [searchEngine, homePage, showBookmarksBar])
  function change(name, value) {
    setDraft((current) => ({ ...current, [name]: value }))
    setStatus('')
  }
  return <form className="personal-settings" onSubmit={async (event) => {
    event.preventDefault()
    setError(null)
    setSaving(true)
    try { await api.saveBrowserPreferences(draft); setStatus('Saved') }
    catch (err) { setError(err) }
    finally { setSaving(false) }
  }}>
    <h2>Browser preferences</h2>
    <label className="settings-list-row"><span className="settings-list-label"><strong>Search engine</strong></span>
      <select value={draft.searchEngine} onChange={(event) => change('searchEngine', event.target.value)}>
        {Object.entries(engines).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select>
    </label>
    <label className="settings-list-row"><span className="settings-list-label"><strong>Home page</strong></span>
      <Input className="browser-home-field" type="url" value={draft.homePage} placeholder="https://example.com"
        onChange={(event) => change('homePage', event.target.value)} />
    </label>
    <label className="settings-list-row"><strong>Show bookmarks bar</strong>
      <input type="checkbox" checked={draft.showBookmarksBar} onChange={(event) => change('showBookmarksBar', event.target.checked)} />
    </label>
    <div className="work-actions">
      <Button type="submit" variant="secondary" size="sm" disabled={saving}>Save preferences</Button>
      {status && <small role="status">{status}</small>}
    </div>
    <ErrorNotice error={error} />
  </form>
}

export function BrowserSettings({ preferences }) {
  return <div className="browser-settings">
    <BrowserImport />
    <BrowserPreferences searchEngine={preferences?.searchEngine ?? 'google'} homePage={preferences?.homePage ?? ''}
      showBookmarksBar={preferences?.showBookmarksBar ?? false} />
  </div>
}
