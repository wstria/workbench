import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Bookmark, ChevronDown, ChevronUp, Clock3, Download, ExternalLink, Globe, House, ListFilter, Minus, Plus, RotateCw, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorNotice, Page, SearchField, Segments } from '@/components/workbench-ui'

const api = window.workbench
const startSections = [['history', 'History'], ['downloads', 'Downloads']]

export function ChromeButton({ label, icon: Icon, ...props }) {
  return <Button type="button" size="icon-sm" variant="ghost" aria-label={label} title={label} {...props}><Icon /></Button>
}

export function AddressBar({ input, value = '', onNavigate, children }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    if (document.activeElement !== input.current) setDraft(value)
  }, [value, input])
  return <form className="browser-address" onSubmit={(event) => {
    event.preventDefault()
    if (!draft.trim()) return
    input.current.blur()
    void onNavigate(draft)
  }}>
    <Search size={15} aria-hidden="true" />
    <input ref={input} type="text" aria-label="Search or enter a URL" placeholder="Search or enter a URL" value={draft}
      autoComplete="off" spellCheck={false} onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.target.select()} onBlur={() => setDraft(value)}
      onKeyDown={(event) => { if (event.key === 'Escape') { setDraft(value); event.currentTarget.blur() } }} />
    {children}
  </form>
}

function BrowserStart({ history, downloads, onNavigate, onOpenFile, initialSection }) {
  const [section, setSection] = useState(initialSection ?? 'history')
  const [query, setQuery] = useState('')
  const items = (section === 'history' ? history : downloads)
    .filter((item) => [item.title, item.url, item.name].join(' ').toLowerCase().includes(query.toLowerCase().trim()))
  const Icon = section === 'history' ? Globe : Download
  return <Page title="Browse the web">
    <div className="browser-start-controls">
      <Segments label="Browser library" value={section} onChange={setSection} options={startSections} />
      <SearchField label={'Filter ' + section} value={query} onChange={setQuery} />
    </div>
    {items.length === 0 && <p>{query ? 'No matches.' : section === 'history' ? 'Pages you visit will appear here.' : 'Completed downloads will appear here.'}</p>}
    <ul className="source-list">
      {items.map((item) => <li key={item.url ?? item.path}>
        <button type="button" className="source-row" onClick={() => item.url ? onNavigate(item.url) : onOpenFile(item.path)}>
          <Icon size={17} aria-hidden="true" />
          <span><strong>{item.title || item.name || item.url}</strong><small>{item.url ?? item.path}</small></span>
          <time dateTime={new Date(item.at).toISOString()}>{new Date(item.at).toLocaleDateString()}</time>
        </button>
      </li>)}
    </ul>
  </Page>
}

export function BrowserView({ tab, active, history, downloads, saved, toggleFavorite, openFile, openLibrary, openFavorites, openBrowserSettings, preferences, favorites }) {
  const [browser, setBrowser] = useState({ id: tab.id, url: tab.url ?? '', title: '', error: '', loading: Boolean(tab.url), zoom: 1 })
  const [error, setError] = useState(null)
  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState('')
  const input = useRef(null)
  const findInput = useRef(null)
  const surface = useRef(null)
  const initialTab = useRef(tab)
  const focusPage = useRef(false)
  const tabId = tab.id

  async function navigate(value, focus = true) {
    focusPage.current = focus
    setError(null)
    try { await api.browserNavigate(tabId, value) }
    catch (err) { setError(err) }
  }

  function action(name) {
    setError(null)
    void api.browserAction(tabId, name).catch(setError)
  }

  function find(text, direction) {
    void api.browserFind(tabId, text, direction).catch(setError)
  }

  function handleShortcut(key) {
    if (key === 'l') input.current?.focus()
    if (key === 'f' && browser.url) { setFinding(true); requestAnimationFrame(() => findInput.current?.select()) }
    if (key === 'd' && browser.url && (!browser.loading || saved)) toggleFavorite()
    if (key === 'r') action('reload')
    if (key === 'back' || key === 'forward') action(key)
    if (key === '0') action('zoom-reset')
    if (key === '=' || key === '+') action('zoom-in')
    if (key === '-') action('zoom-out')
  }

  useEffect(() => {
    const unsubscribe = api.onBrowser((state) => { if (state.id === tabId) setBrowser(state) })
    const initial = initialTab.current
    if (initial.url) void api.browserRestore(tabId, initial.url, initial.navigation).catch(setError)
    else if (initial.requestedAddress) void navigate(initial.requestedAddress, active)
    return () => { unsubscribe(); void api.browserClose(tabId).catch(() => {}) }
  }, [tabId])

  useEffect(() => {
    if (active && !initialTab.current.url && !initialTab.current.requestedAddress && !browser.url && !tab.browserSection) input.current?.focus()
  }, [active])

  useEffect(() => {
    if (!active) return
    const unsubscribe = api.onBrowserShortcut(({ id, key }) => { if (id === tabId) handleShortcut(key) })
    const onKeyDown = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (!['l', 'f', 'd', 'r', '0', '=', '+', '-', '[', ']'].includes(key)) return
      event.preventDefault()
      if (!event.repeat) handleShortcut(key === '[' ? 'back' : key === ']' ? 'forward' : key)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { unsubscribe(); window.removeEventListener('keydown', onKeyDown) }
  }, [active, browser.url, browser.loading, saved, toggleFavorite])

  useEffect(() => {
    if (finding && query && !browser.loading && !browser.error) find(query)
  }, [browser.loading, browser.url])

  const showPage = active && Boolean(browser.url) && !browser.error
  useLayoutEffect(() => {
    if (!showPage) return
    const element = surface.current
    let frame
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const { left, top, width, height } = element.getBoundingClientRect()
        void api.browserBounds(tabId, { x: left, y: top, width, height }).catch(setError)
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)
    measure()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', measure)
      void api.browserBounds(tabId, null).catch(() => {})
    }
  }, [tabId, showPage])

  useEffect(() => {
    if (!focusPage.current || !active || !browser.url || browser.loading) return
    focusPage.current = false
    if (!browser.error && document.activeElement === document.body) action('focus')
  }, [active, browser.url, browser.loading, browser.error])

  return <div className="browser-pane">
    <header className="browser-toolbar" aria-label="Browser navigation">
      <div className="browser-buttons">
        <ChromeButton label="Go back" icon={ArrowLeft} disabled={!browser.back} onClick={() => action('back')} />
        <ChromeButton label="Go forward" icon={ArrowRight} disabled={!browser.forward} onClick={() => action('forward')} />
        <ChromeButton label={browser.loading ? 'Stop loading' : 'Reload page'} icon={browser.loading ? X : RotateCw}
          disabled={!browser.url} onClick={() => action(browser.loading ? 'stop' : 'reload')} />
        {preferences?.homePage && <ChromeButton label="Home page" icon={House} onClick={() => navigate(preferences.homePage)} />}
      </div>
      <AddressBar input={input} value={browser.url} onNavigate={(value) => navigate(value)}>
        <ChromeButton label={saved ? 'Remove from Favorites' : 'Bookmark this page'} icon={Bookmark}
          className="bookmark-toggle" aria-pressed={saved} disabled={!browser.url || (browser.loading && !saved)} onClick={toggleFavorite} />
      </AddressBar>
      <div className="browser-buttons browser-library-buttons">
        <ChromeButton label="Find on page" icon={Search} disabled={!browser.url || Boolean(browser.error)} onClick={() => handleShortcut('f')} />
        <ChromeButton label="Browsing history" icon={Clock3} onClick={() => openLibrary('history')} />
        <ChromeButton label="Downloads" icon={Download} onClick={() => openLibrary('downloads')} />
        <ChromeButton label="Browser data" icon={ListFilter} onClick={openBrowserSettings} />
        <ChromeButton label="Open in default browser" icon={ExternalLink} disabled={!browser.url} onClick={() => action('external')} />
      </div>
    </header>
    {preferences?.showBookmarksBar && <nav className="browser-bookmarks-bar" aria-label="Bookmarks bar">
      <ChromeButton label="Open Favorites" icon={Bookmark} onClick={openFavorites} />
      <div>
        {favorites.map((item) => <Button type="button" key={item.key} variant="ghost" size="sm" title={item.name}
          onClick={() => navigate(item.url)}><span>{item.name}</span></Button>)}
      </div>
    </nav>}
    {finding && <div className="browser-find">
      <input ref={findInput} autoFocus type="search" value={query} placeholder="Find on page" aria-label="Find text"
        onChange={(event) => { setQuery(event.target.value); find(event.target.value) }} onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); find(query, event.shiftKey ? 'previous' : 'next') }
          if (event.key === 'Escape') { setFinding(false); setQuery(''); find(''); action('focus') }
        }} />
      <span aria-live="polite">{query && browser.find ? browser.find.active + ' / ' + browser.find.total : ''}</span>
      <ChromeButton label="Previous match" icon={ChevronUp} disabled={!query} onClick={() => find(query, 'previous')} />
      <ChromeButton label="Next match" icon={ChevronDown} disabled={!query} onClick={() => find(query, 'next')} />
      <ChromeButton label="Close Find" icon={X} onClick={() => { setFinding(false); setQuery(''); find(''); action('focus') }} />
    </div>}
    {browser.zoom !== 1 && <div className="browser-zoom">
      <ChromeButton label="Zoom out" icon={Minus} onClick={() => action('zoom-out')} />
      <Button variant="ghost" size="sm" onClick={() => action('zoom-reset')}>{Math.round(browser.zoom * 100)}%</Button>
      <ChromeButton label="Zoom in" icon={Plus} onClick={() => action('zoom-in')} />
    </div>}
    <ErrorNotice error={error} />
    {!browser.url ? <BrowserStart history={history} downloads={downloads} onNavigate={(value) => navigate(value)} onOpenFile={openFile}
      initialSection={tab.browserSection} />
      : <div ref={surface} className="browser-surface" aria-label="Web page">
        {browser.error ? <div className="browser-message">
          <Globe size={24} aria-hidden="true" />
          <p>{browser.error}</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => action('reload')}>Retry</Button>
        </div> : browser.loading && <div className="browser-loading" role="status" aria-label="Loading page" />}
      </div>}
  </div>
}
