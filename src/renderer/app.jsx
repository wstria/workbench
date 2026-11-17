import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Activity, Bookmark, CalendarClock, FileText, Folder, FolderGit2, Globe, Layers3, Mail, MessageSquare, Monitor, Plug, Plus, List, Settings2, Terminal, X } from 'lucide-react'
import { sessionColor, TeamSessions } from '@/components/team-sessions'
import { FilesPage } from '@/components/file-tree'
import { WorkspaceRail, WorkspaceSidebar } from '@/components/workspace-sidebar'
import { BrowserView, ChromeButton } from '@/components/browser-view'
import { SourceSearch } from '@/components/source-search'
import { FavoritesPage, FolderPage, sourceDetail, sourceKey } from '@/components/source-library'
import { ErrorNotice } from '@/components/workbench-ui'
import { Button } from '@/components/ui/button'
import { SidebarProvider } from '@/components/ui/sidebar'
import { Tabs, TabsContent, TabsTrigger } from '@/components/ui/tabs'
import { TabStrip } from '@/components/tab-strip'
import { resolvePalette } from '@/lib/palettes.mjs'
import { applyTheme, loadTheme, THEME_KEY } from '@/lib/theme'
import { loadWorkspace, updateWorkspace, WORKSPACE_KEY } from '@/lib/workspace'
import '@fontsource-variable/geist'
import '@fontsource-variable/inter'
import { attentionActivity } from '@/lib/run-activity'
import './styles.css'
import './workbench.css'
import './tab-workspace.css'
import './platform.css'

const Settings = lazy(() => import('@/components/settings').then(({ Settings }) => ({ default: Settings })))
const FileView = lazy(() => import('@/components/file-view').then(({ FileView }) => ({ default: FileView })))
const TabWorkspace = lazy(() => import('@/components/tab-workspace').then(({ TabWorkspace }) => ({ default: TabWorkspace })))
const loadPages = () => import('@/components/workbench-pages')
const RunDetail = lazy(() => import('@/components/run-detail').then(({ RunDetail }) => ({ default: RunDetail })))
const ActivityPage = lazy(() => loadPages().then(({ ActivityPage }) => ({ default: ActivityPage })))
const KnowledgeLibrary = lazy(() => import('@/components/knowledge').then(({ KnowledgeLibrary }) => ({ default: KnowledgeLibrary })))
const AutomationEditor = lazy(() => loadPages().then(({ AutomationEditor }) => ({ default: AutomationEditor })))
const AutomationsPage = lazy(() => loadPages().then(({ AutomationsPage }) => ({ default: AutomationsPage })))
const IntegrationHub = lazy(() => import('@/components/integration-hub').then(({ IntegrationHub }) => ({ default: IntegrationHub })))
const InboxPage = lazy(() => import('@/components/inbox').then(({ InboxPage }) => ({ default: InboxPage })))
const ChangesPage = lazy(() => import('@/components/file-versions').then(({ ChangesPage }) => ({ default: ChangesPage })))
const ReviewPage = lazy(() => import('@/components/review-page').then(({ ReviewPage }) => ({ default: ReviewPage })))
const Computers = lazy(() => import('@/components/computers').then(({ Computers }) => ({ default: Computers })))
const TerminalPanel = lazy(() => import('@/components/tab-terminal'))
const emptySources = []

const tabIcons = {
  browser: Globe, chat: MessageSquare, session: MessageSquare, file: FileText, folder: Folder,
  computers: Monitor, files: Folder, changes: FolderGit2, terminal: Terminal, favorites: Bookmark, settings: Settings2, automations: CalendarClock, 'automation-edit': CalendarClock,
  activity: Activity, run: Activity, review: FolderGit2, integrations: Plug, inbox: Mail, artifacts: Layers3,
}
const KEY_ACTIONS = { w: 'close', ',': 'settings' }
const api = window.workbench
const emptyData = { cwd: '', root: '', model: '', harness: 'pi', harnessDefaults: {}, sessions: [], artifacts: [], activity: [], automations: [], favorites: [], runs: [], browserHistory: [], browserDownloads: [], openFolders: [] }

function App() {
  const [workspace, dispatch] = useReducer(updateWorkspace, undefined, loadWorkspace)
  const { tabs, active, sidebarClosed, browserSidebarClosed, closedTabs, fileRoot } = workspace
  const [theme, setTheme] = useState(loadTheme)
  const [appearanceLoaded, setAppearanceLoaded] = useState(false)
  const [section, setSection] = useState('harness')
  const [data, setData] = useState(emptyData)
  const [error, setError] = useState(null)
  const [searchScope, setSearchScope] = useState(null)
  const [activityView, setActivityView] = useState('recent')
  const [attention, setAttention] = useState({})
  const needsAttention = attentionActivity(data, attention)
  const [selectedComputer, setSelectedComputer] = useState(null)
  const [integrationFilter, setIntegrationFilter] = useState('all')
  const [integrationItems, setIntegrationItems] = useState([])
  const tabList = useRef(null)
  const restoreTabFocus = useRef(false)
  const dirtyTabs = useRef(new Set())
  const editorDrafts = useRef(new Map())
  const mountedTabs = useRef(new Set([active]))
  const shellState = useRef('')
  const snapshotFrame = useRef(0)
  const activeTab = tabs.find((tab) => tab.id === active)
  const activeType = activeTab?.type
  const webMode = activeType === 'browser'
  useLayoutEffect(() => {
    mountedTabs.current.add(active)
    const open = new Set(tabs.map((tab) => tab.id))
    for (const id of mountedTabs.current) if (!open.has(id)) mountedTabs.current.delete(id)
  }, [active, tabs])
  const activeCwd = sessionById(activeTab?.sessionId, activeTab?.draftCwd)?.cwd ?? activeTab?.draftCwd ?? data.cwd
  const explorerRoot = fileRoot || data.cwd
  const settingsOpen = activeType === 'settings'
  const dark = resolvePalette(theme).scheme === 'dark'
  const currentSource = tabSource(activeTab)
  const currentFavorite = currentSource && data.favorites.some((item) => item.key === sourceKey(currentSource))
  const openSources = tabs.map((tab) => ({ tabId: tab.id, source: tabSource(tab) })).filter((item) => item.source)

  useEffect(() => {
    const warn = (event) => {
      if (!dirtyTabs.current.size) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  useEffect(() => {
    let current = true
    const refresh = () => api.snapshot().then((snapshot) => { if (current) setData(snapshot) })
      .catch((err) => { if (current) setError(err) })
    const unsubscribe = api.onChange(() => {
      if (snapshotFrame.current) return
      snapshotFrame.current = requestAnimationFrame(() => {
        snapshotFrame.current = 0
        void refresh()
      })
    })
    void refresh()
    return () => { current = false; unsubscribe(); cancelAnimationFrame(snapshotFrame.current); snapshotFrame.current = 0 }
  }, [])

  useEffect(() => {
    const open = () => api.openNativeFiles().then((files) => files.forEach(showFile)).catch(setError)
    const stop = api.onNativeFiles(open)
    void open()
    return stop
  }, [])

  useEffect(() => api.onTranscript(({ id, approvals }) => {
    setAttention((current) => {
      const waiting = Boolean(approvals?.length)
      if (Boolean(current[id]) === waiting) return current
      if (waiting) return { ...current, [id]: true }
      const next = { ...current }
      delete next[id]
      return next
    })
  }), [])

  useEffect(() => api.onBrowserAsk(({ context, kind }) => {
    dispatch({ type: 'new', mode: 'chat', initialContext: context,
      initialDraft: kind === 'selection' ? 'What can you tell me about this passage?' : 'What can you tell me about this element?' })
  }), [])

  useEffect(() => api.onReviewApproval((id) => {
    api.snapshot().then(({ sessions }) => {
      const session = sessions.find((item) => item.id === id)
      if (session) showSession(session)
    }).catch(setError)
  }), [])

  useEffect(() => {
    if (activeType !== 'integrations') return
    let current = true
    const load = () => api.listIntegrations().then((items) => { if (current) setIntegrationItems(items) }).catch(setError)
    const stop = api.onChange(load)
    void load()
    return () => { current = false; stop() }
  }, [activeType])

  useEffect(() => {
    let current = true
    api.loadAppearance().then((saved) => {
      if (!current) return
      if (saved) setTheme(loadTheme(saved))
      setAppearanceLoaded(true)
    }).catch((err) => { if (current) setError(err) })
    return () => { current = false }
  }, [])

  useLayoutEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    if (!appearanceLoaded) return
    localStorage.setItem(THEME_KEY, JSON.stringify(theme))
    void api.saveAppearance(theme).catch(setError)
  }, [theme, appearanceLoaded])

  function flushWorkspace() {
    if (shellState.current) localStorage.setItem(WORKSPACE_KEY, shellState.current)
  }

  useLayoutEffect(() => {
    const saved = ({ draftCwd, requestedAddress, initialContext, initialDraft, ...tab }) => tab
    shellState.current = JSON.stringify({ tabs: tabs.map(saved), active, sidebarClosed, browserSidebarClosed, fileRoot,
      closedTabs: closedTabs.map(saved) })
  }, [tabs, active, sidebarClosed, browserSidebarClosed, closedTabs, fileRoot])

  useEffect(() => {
    const timer = setTimeout(flushWorkspace, 180)
    return () => clearTimeout(timer)
  }, [tabs, active, sidebarClosed, browserSidebarClosed, closedTabs, fileRoot])

  useEffect(() => {
    window.addEventListener('pagehide', flushWorkspace)
    return () => window.removeEventListener('pagehide', flushWorkspace)
  }, [])

  useLayoutEffect(() => {
    const strip = tabList.current
    if (!strip || strip.scrollWidth <= strip.clientWidth && !restoreTabFocus.current) return
    const trigger = strip.querySelector('[role="tab"][data-state="active"]')
    if (restoreTabFocus.current) { trigger?.focus({ preventScroll: true }); restoreTabFocus.current = false }
    const tab = trigger?.closest('.tab')
    if (!tab) return
    const left = tab.offsetLeft - 3
    const right = tab.offsetLeft + tab.offsetWidth + 3
    const current = strip.scrollLeft
    const target = left < current ? left : right > current + strip.clientWidth ? right - strip.clientWidth : current
    if (target !== current) strip.scrollTo({ left: target,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }, [active, tabs.length])

  const openWeb = useCallback(function openWeb(address, section) {
    dispatch({ type: 'browser', address, section, name: section === 'history' ? 'History' : section === 'downloads' ? 'Downloads' : undefined })
  }, [])

  useEffect(() => {
    function onShortcut(event) {
      if (event.defaultPrevented) return
      const key = event.key.toLowerCase()
      if (event.ctrlKey && !event.altKey && key === 'tab') {
        event.preventDefault()
        switchTab(event.shiftKey ? 'prev-tab' : 'next-tab')
        return
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (!event.shiftKey && /^[1-9]$/.test(key)) { event.preventDefault(); switchTab(key); return }
      if (!event.shiftKey && key === 'p') {
        event.preventDefault()
        if (!event.repeat) setSearchScope((current) => current ? null : {})
        return
      }
      const type = KEY_ACTIONS[key]
      if (event.shiftKey && !['t', 'o'].includes(key)) return
      if (!type && !['t', 'o', 'l', 'd'].includes(key)) return
      if ((key === 'd' && (activeType === 'browser' || !currentSource)) ||
        (key === 'l' && (!activeType || activeType === 'browser'))) return

      event.preventDefault()
      if (event.repeat) return
      if (key === 't') event.shiftKey ? dispatch({ type: 'reopen' }) : newTab()
      else if (key === 'o') void (event.shiftKey ? chooseFolder() : chooseFiles())
      else if (key === 'l') openWeb()
      else if (key === 'd') toggleFavorite(currentSource)
      else if (type === 'close') closeTab(active)
      else dispatch({ type })
    }

    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [active, activeType, activeCwd, currentSource, currentFavorite, tabs])

  function closeTab(id) {
    if (dirtyTabs.current.has(id) && !confirm('Close this tab and discard unsaved edits?')) return
    restoreTabFocus.current = tabList.current.contains(document.activeElement)
    if (tabs.some((tab) => tab.id === id && tab.type === 'browser')) void api.browserClose(id).catch(setError)
    dispatch({ type: 'close', id })
  }

  useEffect(() => {
    const state = api.onBrowser(({ id, url, title }) => {
      if (!url) return
      const name = title || new URL(url).hostname
      dispatch({ type: 'browser-state', id, url, name })
    })
    const history = api.onBrowserNavigation(({ id, navigation }) => dispatch({ type: 'browser-history', id, navigation }))
    const child = api.onBrowserOpen(({ url, background }) => dispatch({ type: 'browser', address: url, background }))
    return () => { state(); child(); history() }
  }, [])

  useEffect(() => api.onChooseTab((id) => dispatch({ type: 'activate', id })), [])

  useEffect(() => api.onBrowserShortcut(({ id, key }) => {
    if (id !== active) return
    if (key === 't') newTab()
    if (key === 'w') closeTab(id)
    if (key === 'p') setSearchScope({})
    if (key === 'reopen') dispatch({ type: 'reopen' })
    if (key === 'next-tab' || key === 'prev-tab' || /^[1-9]$/.test(key)) switchTab(key)
  }), [active, tabs])

  function newTab() {
    dispatch({ type: 'new' })
  }

  function switchTab(key) {
    const index = tabs.findIndex((tab) => tab.id === active)
    const next = key === 'next-tab' ? (index + 1) % tabs.length : key === 'prev-tab' ? (index + tabs.length - 1) % tabs.length
      : key === '9' ? tabs.length - 1 : Number(key) - 1
    if (tabs[next]) dispatch({ type: 'activate', id: tabs[next].id })
  }

  function openPage(type) {
    if (type === 'browser') openWeb()
    else {
      if (['files', 'activity', 'integrations'].includes(type)) dispatch({ type: 'sidebar', open: true })
      dispatch({ type: 'open', tab: { type } })
    }
  }

  function openSettings(nextSection) {
    if (nextSection) setSection(nextSection)
    dispatch({ type: 'settings' })
  }

  function showFile(file, target) {
    dispatch({ type: 'open', tab: { type: 'file', key: 'file:' + file.path, name: file.name, path: file.path,
      ...(target && { location: { line: target.line, page: target.page, request: crypto.randomUUID() } }) } })
  }

  async function chooseExplorerRoot() {
    setError(null)
    try {
      const folder = await api.chooseFolder()
      if (folder) { dispatch({ type: 'files-root', path: folder.path }); dispatch({ type: 'sidebar', open: true }) }
    } catch (err) { setError(err) }
  }

  function newTerminal() {
    dispatch({ type: 'terminal', cwd: activeType === 'file' || activeType === 'files' || activeType === 'changes' ? explorerRoot : activeCwd || undefined })
  }

  function openComputerChat(computer) {
    dispatch({ type: 'computer-chat', computerId: computer.id, name: computer.name })
  }

  function openActivityTarget(target) {
    if (target.type === 'run') {
      const overview = data.runs?.find((run) => run.id === target.id)
      dispatch({ type: 'open', tab: { type: 'run', key: 'run:' + target.id, runId: target.id, name: overview?.title ?? target.title ?? 'Run details' } })
    } else if (target.type === 'computer') {
      setSelectedComputer(target.id)
      openPage('computers')
    } else if (target.type === 'review') openReview(target.id)
    else if (target.type === 'inbox') openPage('inbox')
    else if (target.type === 'file') void openFile(target.path)
    else if (target.type === 'memory') openSettings('memory')
    else if (target.type === 'automation') {
      const task = data.automations.find((item) => item.id === target.id)
      if (task) editAutomation(task)
    } else if (target.type === 'session') {
      const session = data.sessions.find((entry) => entry.id === target.id)
      if (session) showSession(session, target.messageId)
    }
  }

  function openFolder(folder) {
    dispatch({ type: 'open', tab: { type: 'folder', key: 'folder:' + folder.path, name: folder.name,
      path: folder.path, parentFolder: folder.parentFolder } })
  }

  async function chooseFolder() {
    setError(null)
    try {
      const folder = await api.chooseFolder()
      if (folder) openFolder(folder)
    } catch (err) { setError(err) }
  }

  function tabSource(tab) {
    if (!tab?.type || tab.type === 'chat') return null
    const name = tabName(tab)
    if (tab.type === 'browser' && tab.url) return { type: 'web', name, url: tab.url }
    if (tab.type === 'file' || tab.type === 'folder') return { type: tab.type, name, path: tab.path }
    if (tab.type === 'session') return { type: 'session', name, id: tab.sessionId }
    if (tab.type === 'automation-edit') return tab.automationId ? { type: tab.type, name, id: tab.automationId } : null
    return { type: 'page', name, page: tab.type }
  }

  function openSource(source) {
    switch (source.type) {
      case 'file': return openFile(source.path, source)
      case 'folder': return openFolder(source)
      case 'web': {
        const existing = tabs.find((tab) => tab.type === 'browser' && tab.url === source.url)
        return existing ? dispatch({ type: 'activate', id: existing.id }) : openWeb(source.url)
      }
      case 'session': {
        const session = data.sessions.find(({ id }) => id === source.id)
        if (session) showSession(session, source.messageId)
        else setError('This chat is no longer available.')
        return
      }
      case 'automation-edit': {
        const task = data.automations.find(({ id }) => id === source.id)
        if (task) editAutomation(task)
        else setError('This automation is no longer available.')
        return
      }
      case 'memory': return openSettings('memory')
      case 'page': return openPage(source.page)
    }
  }

  function removeFavorite(key) { void api.removeFavorite(key).catch(setError) }

  useEffect(() => api.onBrowserSaveError(setError), [])

  function toggleFavorite(source, browserId) {
    if (!source) return
    setError(null)
    const key = sourceKey(source)
    if (data.favorites.some((item) => item.key === key)) removeFavorite(key)
    else if (source.type === 'web' && browserId) {
      const navigation = tabs.find((tab) => tab.id === browserId)?.navigation
      void api.browserCapture(browserId, source.url, navigation, true).catch(async () => {
        await api.addFavorite(source)
        setError('The bookmark was saved. Wait for readable page text and use Save passage to keep an offline excerpt.')
      }).catch(setError)
    } else void api.addFavorite(source).catch(setError)
  }

  function captureSource({ source, tabId, excerpt }) {
    if (source.type === 'web' && tabId) {
      const navigation = tabs.find((tab) => tab.id === tabId)?.navigation
      return api.browserCapture(tabId, source.url, navigation)
    }
    return api.captureSource({ ...source, excerpt }, source.type === 'file' ? editorDrafts.current.get(tabId) : undefined)
  }

  async function attachSearchResult(item) {
    dispatch({ type: 'new', mode: 'chat', initialContext: await captureSource(item) })
  }

  function workspaceContaining(file) {
    return [explorerRoot, ...data.openFolders, data.cwd, ...data.sessions.map((session) => session.cwd)]
      .filter((root) => root && (file.startsWith(root + '/') || file.startsWith(root + '\\')))
      .sort((left, right) => right.length - left.length)[0]
  }

  async function useInChat(tab, selection) {
    setError(null)
    try {
      const source = selection ? { ...tabSource(tab), line: selection.line } : tabSource(tab)
      const initialContext = await captureSource({ source, tabId: tab.id, excerpt: selection?.text })
      const cwd = selection ? workspaceContaining(tab.path) : undefined
      dispatch({ type: 'new', mode: 'chat', initialContext, cwd, initialDraft: selection ? 'Edit the attached selection to ' : undefined })
    } catch (err) { setError(err) }
  }

  function getSourceOptions(tabId) {
    const used = new Set()
    const options = []
    const add = (source, group, id) => {
      const key = sourceKey(source)
      const saved = data.favorites.find((item) => item.key === key)
      if (saved) source = { ...source, tags: saved.tags, notes: saved.notes }
      if (used.has(key)) return
      used.add(key)
      options.push({ key, tabId: id, source, group, detail: sourceDetail(source) })
    }
    for (const { tabId: id, source } of openSources) {
      if (id !== tabId) add(source, 'Open tabs', id)
      else used.add(sourceKey(source))
    }
    for (const item of data.favorites) add(item, 'Favorites')
    for (const session of data.sessions.slice(0, 120)) add({ type: 'session', id: session.id, name: session.title }, 'Chats')
    for (const file of data.artifacts) add({ type: 'file', path: file.path, name: file.name }, 'Recent files')
    return options
  }

  function createNote(cwd) {
    setError(null)
    return api.createArtifact('note', cwd === data.cwd ? undefined : cwd).then(showFile).catch(setError)
  }

  async function openFile(path, target) {
    setError(null)
    try {
      const file = await (target?.fingerprint ? api.openIndexedFile({ ...target, path }) : api.openWorkspaceFile(path))
      showFile(file, target)
    } catch (err) {
      if (!target?.fingerprint || !/ENOENT|no such file/i.test(err.message)) { setError(err); return }
      if (!confirm('This source moved. Would you like to locate the original file?')) return
      try {
        const file = await api.relinkIndexedFile({ ...target, type: 'file', path })
        if (file) showFile(file, target)
      } catch (error) { setError(error) }
    }
  }

  function chooseFiles() {
    setError(null)
    return api.chooseFiles(activeCwd || undefined).then((files) => files.forEach(showFile)).catch(setError)
  }

  async function chooseWorkspace(tab) {
    setError(null)
    try {
      const cwd = await api.chooseWorkspace(tab.draftCwd)
      if (cwd) dispatch({ type: 'workspace', tabId: tab.id, cwd: cwd === data.cwd ? undefined : cwd })
    } catch (err) {
      setError(err)
    }
  }

  function showSession(session, messageId) {
    dispatch({ type: 'open', tab: { type: 'session', key: 'session:' + session.id, name: session.title, sessionId: session.id,
      ...(typeof messageId === 'string' && { location: { messageId, request: crypto.randomUUID() } }) } })
  }

  function openReview(id) {
    dispatch({ type: 'open', tab: { type: 'review', key: 'review:' + id, name: 'Review changes', reviewId: id } })
  }

  async function ensureSession(tabId, cwd, harness, computerId, separate) {
    const session = await api.createSession(cwd || undefined, harness, computerId, separate)
    setData((current) => current.sessions.some((item) => item.id === session.id) ? current
      : { ...current, sessions: [session, ...current.sessions] })
    dispatch({ type: 'session', tabId, session })
    return session
  }

  function editAutomation(task, preset) {
    dispatch({ type: 'open', tab: {
      type: 'automation-edit', key: 'automation:' + (task?.id ?? preset ?? 'new'),
      name: task?.name ?? (preset === 'inbox' ? 'Inbox briefing' : 'New scheduled task'), automationId: task?.id, preset,
    } })
  }

  function tabName(tab) {
    return data.sessions.find((session) => session.id === tab.sessionId)?.title ?? tab.name
  }

  function sessionById(id, cwd = data.cwd) {
    if (id) return data.sessions.find((session) => session.id === id) ?? { id, cwd }
  }

  function renderTab(tab) {
    switch (tab.type) {
      case 'browser': {
        const source = tabSource(tab)
        return <BrowserView tab={tab} active={tab.id === active && !searchScope} history={data.browserHistory} downloads={data.browserDownloads}
          saved={data.favorites.some((item) => item.key === sourceKey(source))} toggleFavorite={() => tab.url && toggleFavorite(source, tab.id)}
          openFile={openFile} openLibrary={(section) => openWeb(undefined, section)} preferences={data.preferences}
          favorites={data.preferences?.showBookmarksBar ? data.favorites.filter((item) => item.type === 'web').slice(0, 12) : []}
          openFavorites={() => openPage('favorites')} openBrowserSettings={() => openSettings('browser-data')} />
      }
      case 'favorites': return <FavoritesPage items={data.favorites} openSource={openSource} remove={removeFavorite} openBrowserSettings={() => openSettings('browser-data')} />
      case 'folder': return <FolderPage tab={tab} openFile={openFile} openFolder={openFolder} useInChat={() => useInChat(tab)} />
      case 'settings': return <Settings section={section} theme={theme} data={data} openFile={openFile} openSource={openSource} active={tab.id === active} goTo={setSection} setTheme={setTheme} />
      case 'automations': return <AutomationsPage tasks={data.automations} onEdit={editAutomation} onRun={async (id) => showSession(await api.runAutomation(id))}
        onLatest={(id) => openActivityTarget({ type: 'run', id })} />
      case 'automation-edit': return data.root && <AutomationEditor preset={tab.preset} task={data.automations.find((task) => task.id === tab.automationId)} cwd={data.cwd} openFolders={data.openFolders} onDone={() => { closeTab(tab.id); openPage('automations') }} />
      case 'activity': return <ActivityPage items={data.activity} tasks={data.automations} runs={data.runs} attention={needsAttention} view={activityView}
        onViewChange={setActivityView} openTarget={openActivityTarget} />
      case 'run': return <RunDetail id={tab.runId} summary={data.runs?.find((run) => run.id === tab.runId)} active={tab.id === active}
        openTarget={openActivityTarget} openSource={openSource} />
      case 'files': return <FilesPage root={explorerRoot} recent={data.artifacts} chooseRoot={chooseExplorerRoot}
        chooseFiles={chooseFiles} openFile={openFile} openChanges={() => openPage('changes')}
        openSearch={() => setSearchScope({ cwd: explorerRoot })} />
      case 'changes': return <ChangesPage cwd={explorerRoot} chooseRoot={chooseExplorerRoot} openFile={openFile} />
      case 'review': {
        const review = data.reviews?.find((item) => item.id === tab.reviewId)
        return <ReviewPage id={tab.reviewId} session={data.sessions.find((session) => session.id === review?.sessionId)} openFile={openFile} openSession={showSession} />
      }
      case 'terminal': return <div className="terminal-tab"><TerminalPanel tabId={tab.id} active={tab.id === active}
        dark={dark} draftCwd={tab.draftCwd} onClose={() => closeTab(tab.id)} /></div>
      case 'computers': return <Computers active={tab.id === active} onChat={openComputerChat} requestedSelection={selectedComputer} />
      case 'artifacts': return <KnowledgeLibrary active={tab.id === active} openFile={openFile} openSource={openSource}
        createArtifact={(kind) => api.createArtifact(kind)} chooseFiles={chooseFiles} />
      case 'inbox': return <InboxPage active={tab.id === active} openWeb={openWeb} schedule={() => editAutomation(undefined, 'inbox')} />
      case 'integrations': return <IntegrationHub openInbox={() => openPage('inbox')} filter={integrationFilter} openWeb={openWeb} openHarnessSettings={() => openSettings('harness')} openProvider={() => openSettings('providers')} />
      case 'file': return <FileView path={tab.path} location={tab.location} openSource={openSource} openWeb={openWeb} preferences={data.preferences} root={explorerRoot}
        project={workspaceContaining(tab.path) ?? explorerRoot}
        openFile={openFile} active={tab.id === active} dark={dark}
        onDraft={(draft) => {
          if (draft === undefined) editorDrafts.current.delete(tab.id)
          else editorDrafts.current.set(tab.id, draft)
        }} useInChat={() => useInChat(tab)} editSelection={(selection) => useInChat(tab, selection)} onDirty={(dirty) => {
        if (dirty) dirtyTabs.current.add(tab.id)
        else dirtyTabs.current.delete(tab.id)
      }} />
      default: {
        const session = sessionById(tab.sessionId, tab.draftCwd)
        const cwd = session?.cwd ?? tab.draftCwd ?? data.cwd
        return <TabWorkspace
          tabId={tab.id}
          location={tab.location}
          launcher={!tab.type}
          active={tab.id === active}
          dark={dark}
          session={session}
          workspace={tab.computerId && !session ? { ...data, harness: 'pi' } : data}
          openSession={showSession}
          teamPanel={session?.familyId && <TeamSessions session={session} active={tab.id === active} openSession={showSession}
            openChanges={(member) => {
              const review = data.reviews?.find((item) => item.sessionId === member.id)
              if (review) openReview(review.id)
              else {
                dispatch({ type: 'files-root', path: member.cwd })
                openPage('changes')
              }
            }} />}
          computerName={tab.computerName ?? data.computers?.find((item) => item.id === session?.computerId)?.name}
          computerId={tab.computerId ?? session?.computerId}
          openComputer={(id) => {
            setSelectedComputer(id)
            openPage('computers')
          }}
          draftCwd={tab.draftCwd}
          ensureSession={(harness, separate) => ensureSession(tab.id, cwd, harness, tab.computerId, separate)}
          openFile={openFile}
          chooseWorkspace={!tab.computerId && !tab.sessionId && data.cwd ? () => chooseWorkspace(tab) : undefined}
          resetWorkspace={() => dispatch({ type: 'workspace', tabId: tab.id })}
          openWeb={openWeb}
          replaceWithWeb={(address) => dispatch({ type: 'browser', replace: tab.id, address })}
          initialContext={tab.initialContext}
          initialDraft={tab.initialDraft}
          openReview={openReview}
          sourceOptions={tab.id === active ? getSourceOptions(tab.id) : emptySources}
          captureSource={captureSource}
          openSource={openSource}
          openProvider={() => openSettings('providers')}
          openHarnessSettings={() => openSettings('harness')}
        />
      }
    }
  }

  return (
    <Tabs
      className="shell"
      value={String(active)}
      onValueChange={(id) => dispatch({ type: 'activate', id: Number(id) })}
    >
      <header className="topbar">
        <div className="topbar-gutter" aria-hidden="true" />
        <TabStrip listRef={tabList} order={tabs.map(({ id }) => id).join(',')} active={active}
          trailing={Boolean(currentSource && !webMode)}>
          {tabs.map((tab) => {
            const Icon = tabIcons[tab.type]
            const color = sessionColor(data.sessions.find((item) => item.id === tab.sessionId))
            return <div key={tab.id} className="tab" data-tab-id={tab.id} data-active={tab.id === active}
              style={color ? { '--session-color': color } : undefined}>
              <TabsTrigger
                value={String(tab.id)}
                title={tabName(tab)}
                className="tab-trigger"
                onKeyDown={(event) => {
                  if (event.key === 'Delete') {
                    event.preventDefault()
                    closeTab(tab.id)
                  }
                }}
              >
                {Icon && <span className="tab-symbol" data-linked={Boolean(color)}><Icon aria-hidden="true" /></span>}
                <span className="truncate">{tabName(tab)}</span>
              </TabsTrigger>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="tab-close"
                aria-label={`Close ${tabName(tab).toLowerCase()}`}
                title="Close tab"
                onClick={() => closeTab(tab.id)}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          })}
        </TabStrip>
        {tabs.length > 6 && <ChromeButton icon={List} className="chrome-button" label="All tabs"
          onClick={() => api.tabMenu(tabs.map((tab) => ({ id: tab.id, name: tabName(tab) })), active).catch(setError)} />}
        {currentSource && activeType !== 'browser' && <ChromeButton icon={Bookmark} className="chrome-button bookmark-toggle"
          label={currentFavorite ? 'Remove from Favorites' : 'Bookmark this tab'} aria-pressed={Boolean(currentFavorite)}
          onClick={() => toggleFavorite(currentSource)} />}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="chrome-button"
          aria-label="New tab"
          title="New tab"
          onClick={newTab}
        >
          <Plus aria-hidden="true" />
        </Button>
      </header>

      <SidebarProvider
        className="workspace"
        style={{ '--sidebar-width': 'var(--sidebar-w)' }}
        open={!(webMode ? browserSidebarClosed : sidebarClosed)}
        onOpenChange={(open) => dispatch({ type: 'sidebar', open, browser: webMode })}
      >
        <WorkspaceRail
          settingsOpen={settingsOpen}
          onOpenSettings={() => openSettings()}
          activeType={activeType}
          openPage={openPage}
          newChat={() => dispatch({ type: 'new', mode: 'chat' })}
          newNote={() => createNote(activeType === 'files' ? explorerRoot : activeCwd)}
          openTerminal={newTerminal}
          openUsage={() => openSettings('usage')}
          openProfile={() => openSettings('profile')}
        />
        <div className="workspace-frame">
          <WorkspaceSidebar
            settingsOpen={settingsOpen}
            browserMode={webMode}
            favorites={data.favorites}
            history={data.browserHistory}
            openSource={openSource}
            section={section}
            onSectionChange={setSection}
            type={activeType}
            sessions={data.sessions}
            openSession={showSession}
            fileTree={{ root: activeType === 'folder' ? activeTab.path : explorerRoot, selected: activeTab?.path,
              chooseRoot: chooseExplorerRoot, openFile, openChanges: () => openPage('changes') }}
            work={{ automations: data.automations, openTarget: openActivityTarget, setActivityView: (view) => { setActivityView(view); openPage('activity') },
              attention: needsAttention,
              integrations: integrationItems, integrationFilter, setIntegrationFilter, openAutomation: editAutomation, openPage,
              artifacts: data.artifacts, vaults: data.knowledgeVaults ?? [], favorites: data.favorites, openSource, openFile,
              computers: data.computers ?? [], selectComputer: setSelectedComputer, openFolder,
              onToggleIntegration: (id, enabled) => api.toggleIntegration(id, enabled).catch(setError) }}
          />
          <main className="stage" aria-label="Content">
            <ErrorNotice error={error} />
            {tabs.map((tab) => (
              <TabsContent key={tab.id} value={String(tab.id)} className="stage-panel" data-native={tab.type === 'browser' || tab.type === 'terminal'} forceMount hidden={tab.id !== active}>
                {(tab.id === active || mountedTabs.current.has(tab.id) || tab.requestedAddress) &&
                  <Suspense fallback={<div className="tab-load" role="status" aria-label="Opening tab" />}>{renderTab(tab)}</Suspense>}
              </TabsContent>
            ))}
          </main>
        </div>
      </SidebarProvider>
      <SourceSearch scope={searchScope} saved={data.savedSearches} onClose={() => setSearchScope(null)}
        openSource={openSource} attachSource={attachSearchResult} />
    </Tabs>
  )
}

createRoot(document.getElementById('root')).render(<App />)
