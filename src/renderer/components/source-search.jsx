import { useEffect, useRef, useState } from 'react'
import { Bookmark, CornerDownLeft, Link, MessageSquarePlus, RefreshCw, Search, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorNotice } from '@/components/workbench-ui'
import { SourceIcon } from '@/components/source-library'
import { sourceFromLink } from '../../main/source-reference.mjs'
import './source-search.css'

const api = window.workbench

function SearchBox({ scope, saved, openSource, attachSource, close }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)
  const [active, setActive] = useState(0)
  const [rebuild, setRebuild] = useState(0)
  const [working, setWorking] = useState(null)
  const [status, setStatus] = useState('')
  const buildRequested = useRef(0)
  const search = query.trim()
  const link = sourceFromLink(search)

  useEffect(() => {
    setActive(0)
    setStatus('')
    setError(null)
    setResults(null)
    if (!search || sourceFromLink(search)) return
    let current = true
    const timer = setTimeout(() => {
      const refresh = rebuild > buildRequested.current
      buildRequested.current = rebuild
      api.searchSources({ query: search, cwd: scope?.cwd, rebuild: refresh }).then((next) => {
        if (current) setResults({ ...next, query: search })
      }).catch((err) => { if (current) setError(err) })
    }, 130)
    return () => { current = false; clearTimeout(timer) }
  }, [search, scope?.cwd, rebuild])

  useEffect(() => {
    document.getElementById('source-result-' + active)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const items = results?.query === search ? results.items : []
  const selected = items[active]

  async function perform(key, action) {
    setWorking(key)
    setError(null)
    setStatus('')
    try { await action() }
    catch (err) { setError(err) }
    finally { setWorking(null) }
  }

  function choose(item) {
    close()
    openSource(item?.source ?? link)
  }

  return <>
    <div className="work-search source-search-input">
      <Search size={17} aria-hidden="true" />
      <Input type="search" role="combobox" aria-label="Search sources" aria-controls="source-results"
        aria-expanded={items.length > 0} aria-activedescendant={items[active] ? 'source-result-' + active : undefined}
        placeholder="Search files, PDFs, saved pages, and chats" autoFocus value={query} onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!items.length) return
            event.preventDefault()
            setActive((index) => Math.min(items.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1))))
          } else if (event.key === 'Enter' && (link || items[active])) {
            event.preventDefault()
            choose(items[active])
          }
        }} />
    </div>
    <ErrorNotice error={error} />
    {!search && saved.length > 0 && <div className="source-search-saved">
      {saved.map((item) => <div key={item.id}>
        <button type="button" onClick={() => setQuery(item.query)}><Bookmark size={14} aria-hidden="true" /> {item.query}</button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={'Remove saved search ' + item.query}
          disabled={Boolean(working)} onClick={() => perform('remove', () => api.removeSourceSearch(item.id))}><X /></Button>
      </div>)}
    </div>}
    {link && <Button type="button" variant="outline" onClick={() => choose()}>Open source link</Button>}
    {!link && items.length > 0 && <>
      <div role="listbox" aria-label="Search results" id="source-results" className="source-search-results">
        {items.map((item, index) => <div key={index} id={'source-result-' + index} role="option" aria-selected={index === active}
          className="source-search-result" onMouseEnter={() => setActive(index)} onClick={() => choose(item)}>
          <span className="source-result-open">
            <SourceIcon source={item.source} size={17} />
            <span>
              <strong>{item.source.name}</strong><small>{item.detail}</small>
              {item.excerpt && <span className="source-result-excerpt">{item.excerpt}</span>}
            </span>
          </span>
        </div>)}
      </div>
    </>}
    {search && !link && !error && !results && <p role="status" className="source-search-message">Searching sources…</p>}
    {search && !link && results && !items.length && <p className="source-search-message">No matching sources.</p>}
    <footer className="source-search-footer">
      <span role="status">{status || (results?.limited ? 'Showing bounded search results.' : items.length ? items.length + ' results' : '')}</span>
      <div className="work-actions">
        {selected && <>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={'Attach ' + selected.source.name + ' to chat'} title="Attach to chat"
            disabled={Boolean(working)} onClick={() => perform(selected.source.name, async () => {
              await attachSource(selected)
              close()
            })}><MessageSquarePlus /></Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={'Copy link to ' + selected.source.name} title="Copy source link"
            disabled={Boolean(working)} onClick={() => perform(selected.source.name, async () => {
              await api.copySourceLink(selected.source)
              setStatus('Source link copied')
            })}><Link /></Button>
        </>}
        {search && !link && <>
          <Button type="button" variant="ghost" size="sm" disabled={Boolean(working)}
            onClick={() => perform('save', async () => { await api.saveSourceSearch({ query: search, cwd: scope?.cwd }); setStatus('Search saved') })}><Bookmark /> Save search</Button>
          <Button type="button" variant="ghost" size="icon-sm" title="Rebuild index" aria-label="Rebuild index"
            onClick={() => setRebuild((current) => current + 1)}><RefreshCw /></Button>
        </>}
        <span className="source-enter" aria-hidden="true"><CornerDownLeft size={13} /> Open</span>
      </div>
    </footer>
  </>
}

export function SourceSearch({ scope, saved = [], onClose, openSource, attachSource }) {
  const input = useRef(null)
  return <Dialog.Root open={Boolean(scope)} onOpenChange={(open) => { if (!open) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="catalog-overlay" />
      <Dialog.Content ref={input} className="catalog-dialog source-search-dialog" onOpenAutoFocus={(event) => {
        const search = input.current?.querySelector('input')
        if (search) { event.preventDefault(); search.focus() }
      }}>
        <header className="catalog-heading">
          <div><Dialog.Title>{scope?.cwd ? 'Search this workspace' : 'Find a source'}</Dialog.Title>
            <Dialog.Description>{scope?.cwd || 'Open a source or attach an excerpt to a chat.'}</Dialog.Description></div>
          <Dialog.Close asChild><Button type="button" variant="ghost" size="icon-sm" aria-label="Close source search"><X /></Button></Dialog.Close>
        </header>
        {scope && <SearchBox scope={scope} saved={saved.filter((item) => item.cwd === scope.cwd)} close={onClose} openSource={openSource} attachSource={attachSource} />}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
