import { useEffect, useMemo, useState } from 'react'
import { ArrowUp, Bookmark, ExternalLink, FileText, Folder, Globe, LayoutTemplate, MessageSquare, Tag, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, ErrorNotice, Page, SearchField, Segments } from '@/components/workbench-ui'

const api = window.workbench
const kindFilters = [['all', 'All'], ['web', 'Web'], ['file', 'Files'], ['folder', 'Folders'], ['session', 'Chats'], ['other', 'Workbench']]

export function sourceKey(source) {
  return source && source.type + ':' + (source.url ?? source.path ?? source.id ?? source.page)
}

export function sourceDetail(source) {
  return source.url ?? source.path ?? (source.type === 'session' ? 'Chat' : 'Workbench')
}

export function SourceIcon({ source, ...props }) {
  const Icon = { web: Globe, file: FileText, folder: Folder, session: MessageSquare }[source.type] || LayoutTemplate
  return <Icon aria-hidden="true" {...props} />
}

export function FavoritesPage({ items, openSource, remove, openBrowserSettings }) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [tag, setTag] = useState('')
  const [folder, setFolder] = useState('')
  const [limit, setLimit] = useState(100)
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState(null)
  const tags = useMemo(() => [...new Set(items.flatMap((item) => item.tags ?? []))].sort(), [items])
  const folders = useMemo(() => {
    const names = new Map()
    for (const item of items) {
      const sections = item.bookmarkFolder ?? []
      for (let end = 1; end <= sections.length; end++) {
        const path = sections.slice(0, end)
        names.set(JSON.stringify(path), path.join(' / '))
      }
    }
    return [...names.entries()].sort(([, first], [, second]) => first.localeCompare(second))
  }, [items])
  const visible = useMemo(() => {
    const search = query.trim().toLowerCase()
    const selectedFolder = folder ? JSON.parse(folder) : []
    return items.filter((item) => {
      const type = item.type === 'page' || item.type === 'automation-edit' ? 'other' : item.type
      return (kind === 'all' || kind === type) && (!tag || item.tags?.includes(tag)) &&
        selectedFolder.every((part, index) => item.bookmarkFolder?.[index] === part) &&
        [item.name, sourceDetail(item), ...(item.tags ?? []), ...(item.bookmarkFolder ?? []), item.notes]
          .join(' ').toLowerCase().includes(search)
    })
  }, [items, kind, tag, folder, query])
  async function save(event) {
    event.preventDefault()
    setError(null)
    try {
      await api.updateFavorite(editing.key, { tags: editing.tagText.split(',').map((value) => value.trim()).filter(Boolean), notes: editing.notes })
      setEditing(null)
    } catch (err) { setError(err) }
  }
  return <Page title="Favorites" description="Saved sources and the tags that connect them.">
    <div className="work-filterbar">
      <Segments label="Favorite types" value={kind} onChange={(value) => { setKind(value); if (value !== 'web' && value !== 'all') setFolder(''); setLimit(100) }} options={kindFilters} />
      <SearchField label="Search Favorites" value={query} onChange={(value) => { setQuery(value); setLimit(100) }} />
      <Button type="button" size="sm" variant="ghost" onClick={openBrowserSettings}><Upload /> Import bookmarks</Button>
    </div>
    {folders.length > 0 && <label className="favorite-folder-filter">
      <Folder size={15} aria-hidden="true" />
      <select aria-label="Bookmark folder" value={folder} onChange={(event) => {
        setFolder(event.target.value)
        if (event.target.value) setKind('web')
        setLimit(100)
      }}>
        <option value="">All bookmark folders</option>
        {folders.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
      </select>
    </label>}
    {tags.length > 0 && <div className="tag-list" aria-label="Filter by tag">
      <button type="button" aria-pressed={!tag} onClick={() => setTag('')}>All tags</button>
      {tags.map((item) => <button key={item} type="button" aria-pressed={tag === item} onClick={() => setTag(tag === item ? '' : item)}>#{item}</button>)}
    </div>}
    {!items.length && <Empty icon={Bookmark} title="No favorites yet" text="Use the bookmark button on a tab to save it here." />}
    {items.length > 0 && !visible.length && <p className="library-empty">No matching favorites.</p>}
    <ErrorNotice error={error} />
    <ul className="source-list favorite-list">{visible.slice(0, limit).map((item) => <li key={item.key}>
      <div>
        <button className="source-row" type="button" onClick={() => openSource(item)}>
          <SourceIcon source={item} size={17} />
          <span><strong>{item.name}</strong><small>{[...(item.bookmarkFolder ?? []), sourceDetail(item)].join(' / ')}</small></span>
        </button>
        {item.notes && <p className="favorite-notes">{item.notes}</p>}
        {item.tags?.length > 0 && <div className="tag-list favorite-tags">{item.tags.map((value) =>
          <button key={value} type="button" onClick={() => setTag(value)}>#{value}</button>)}</div>}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label={'Edit tags and notes for ' + item.name} title="Edit tags and notes"
        onClick={() => { setError(null); setEditing({ key: item.key, label: item.name, tagText: (item.tags ?? []).join(', '), notes: item.notes ?? '' }) }}><Tag /></Button>
      <Button variant="ghost" size="icon-sm" aria-label={'Remove ' + item.name} title="Remove from Favorites" onClick={() => remove(item.key)}><X /></Button>
    </li>)}</ul>
    {visible.length > limit && <Button variant="ghost" size="sm" onClick={() => setLimit((count) => count + 100)}>Show more</Button>}
    {editing && <form className="personal-settings favorite-editor" onSubmit={save}>
      <h2>{editing.label}</h2>
      <label className="work-field">Tags<input type="text" value={editing.tagText} placeholder="research, project-x"
        onChange={(event) => setEditing({ ...editing, tagText: event.target.value })} /></label>
      <label className="work-field">Notes<textarea value={editing.notes} maxLength={3000} onChange={(event) => setEditing({ ...editing, notes: event.target.value })} /></label>
      <div className="work-actions"><Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
        <Button type="submit" size="sm" variant="secondary">Save metadata</Button></div>
    </form>}
  </Page>
}

export function FolderPage({ tab, openFile, openFolder, useInChat }) {
  const [items, setItems] = useState([])
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    let current = true
    const load = () => api.listFiles(tab.path).then((files) => {
      if (current) { setItems(files); setError(null) }
    }).catch((err) => { if (current) setError(err) })
    const unsubscribe = api.onChange(load)
    void load()
    return () => { current = false; unsubscribe() }
  }, [tab.path])
  const visible = items.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()))
  return <Page title={tab.name} description={<span title={tab.path}>{tab.path}</span>} actions={<>
    {tab.parentFolder && <Button variant="ghost" size="sm" onClick={() => openFolder(tab.parentFolder)}><ArrowUp /> Parent</Button>}
    <Button variant="ghost" size="sm" onClick={() => api.openExternal(tab.path).catch(setError)}><ExternalLink /> Open in Finder</Button>
    <Button variant="secondary" size="sm" onClick={useInChat}>Use in chat</Button>
  </>}>
    <div className="work-filterbar"><SearchField label="Filter folder" value={query} onChange={setQuery} /></div>
    <ErrorNotice error={error} />
    <ul className="source-list">{visible.map((item) => <li key={item.path}>
      <button className="source-row" type="button" onClick={() => item.directory ? openFolder({ ...item, parentFolder: tab }) : openFile(item.path)}>
        {item.directory ? <Folder size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
        <span><strong>{item.name}</strong></span>
      </button>
    </li>)}</ul>
    {!error && !visible.length && <p className="library-empty">{query ? 'No matching files.' : 'This folder is empty.'}</p>}
  </Page>
}
