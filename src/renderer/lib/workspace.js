import { readStorage } from '@/lib/storage'

export const WORKSPACE_KEY = 'black-workbench-shell'

const PAGE_TITLES = { settings: 'Settings', automations: 'Automations', activity: 'Activity', integrations: 'Integrations', artifacts: 'Artifacts', favorites: 'Favorites',
  files: 'Files', changes: 'Changes', computers: 'Computers', inbox: 'Inbox' }

function newTab(id, mode) {
  return mode === 'chat' ? { id, type: 'chat', name: 'New chat' } : { id, name: 'New tab' }
}

export function loadWorkspace() {
  const saved = readStorage(WORKSPACE_KEY)
  const savedTabs = Array.isArray(saved.tabs)
    ? saved.tabs.filter((tab) => Number.isSafeInteger(tab?.id) && typeof tab.name === 'string')
      .map(({ sideSessionId, ...tab }) => tab)
    : []
  const settingsTab = savedTabs.find(({ type }) => type === 'settings') ?? savedTabs.find(({ type }) => type === 'provider')
  const migrated = savedTabs.flatMap((tab) => tab.type !== 'provider' ? [tab]
    : tab === settingsTab ? [{ ...tab, type: 'settings', key: 'settings', name: 'Settings' }] : [])
  const tabs = migrated.length ? migrated : [newTab(1)]
  const active = savedTabs.find(({ id }) => id === saved.active)?.type === 'provider' ? settingsTab?.id : saved.active

  return {
    tabs,
    active: tabs.some((tab) => tab.id === active) ? active : tabs[0].id,
    sidebarClosed: Boolean(saved.sidebarClosed),
    browserSidebarClosed: saved.browserSidebarClosed !== false,
    fileRoot: typeof saved.fileRoot === 'string' ? saved.fileRoot : undefined,
    closedTabs: Array.isArray(saved.closedTabs) ? saved.closedTabs.slice(0, 12) : [],
    nextId: Math.max(...tabs.map((tab) => tab.id)) + 1,
  }
}

export function updateWorkspace(state, action) {
  switch (action.type) {
    case 'sidebar':
      return { ...state, [action.browser ? 'browserSidebarClosed' : 'sidebarClosed']: !action.open }
    case 'activate':
      return { ...state, active: action.id }
    case 'settings':
    case 'open': {
      const target = action.tab ?? { type: 'settings' }
      const key = target.key ?? target.type
      const sidebarClosed = target.type === 'settings' ? false : state.sidebarClosed
      const existing = state.tabs.find((tab) => (tab.key ?? tab.type) === key)
      if (existing) return { ...state, active: existing.id, sidebarClosed,
        ...(target.location && { tabs: state.tabs.map((item) => item === existing ? { ...item, location: target.location } : item) }) }

      const tab = { name: PAGE_TITLES[target.type], ...target, key, id: state.nextId }
      return { ...state, tabs: [...state.tabs, tab], active: tab.id, nextId: tab.id + 1, sidebarClosed }
    }
    case 'browser': {
      const browser = { type: 'browser', name: action.name ?? 'New web tab', url: action.url, requestedAddress: action.address, browserSection: action.section }
      if (action.replace) return { ...state, tabs: state.tabs.map((tab) => tab.id === action.replace ? { id: tab.id, ...browser } : tab) }
      return { ...state, tabs: [...state.tabs, { id: state.nextId, ...browser }],
        active: action.background ? state.active : state.nextId, nextId: state.nextId + 1 }
    }
    case 'browser-history': {
      const tab = state.tabs.find((item) => item.id === action.id && item.type === 'browser')
      if (!tab) return state
      return { ...state, tabs: state.tabs.map((item) => item === tab ? { ...tab, navigation: action.navigation } : item) }
    }
    case 'browser-state': {
      const tab = state.tabs.find((item) => item.id === action.id && item.type === 'browser')
      if (!tab || (tab.url === action.url && tab.name === action.name)) return state
      return { ...state, tabs: state.tabs.map((item) => item === tab ? { ...tab, url: action.url, name: action.name } : item) }
    }
    case 'reopen': {
      const [tab, ...closedTabs] = state.closedTabs
      if (!tab) return state
      const existing = tab.key && state.tabs.find((item) => item.key === tab.key)
      if (existing) return { ...state, active: existing.id, closedTabs }
      const reopened = { ...tab, id: state.nextId }
      return { ...state, tabs: [...state.tabs, reopened], active: reopened.id, closedTabs, nextId: reopened.id + 1 }
    }
    case 'files-root':
      return { ...state, fileRoot: action.path }
    case 'terminal':
    case 'computer-chat': {
      const id = state.nextId
      const tab = action.type === 'terminal' ? { id, type: 'terminal', name: 'Terminal', draftCwd: action.cwd }
        : { id, type: 'chat', name: action.name, computerName: action.name, computerId: action.computerId }
      return { ...state, tabs: [...state.tabs, tab], active: id, nextId: id + 1 }
    }
    case 'workspace':
      return { ...state, tabs: state.tabs.map((tab) => tab.id === action.tabId && !tab.sessionId ? {
        ...tab, draftCwd: action.cwd,
      } : tab) }
    case 'session':
      return { ...state, tabs: state.tabs.map((tab) => tab.id === action.tabId ? {
        ...tab, type: 'session', key: 'session:' + action.session.id, sessionId: action.session.id,
      } : tab) }
    case 'new': {
      const tab = { ...newTab(state.nextId, action.mode), initialContext: action.initialContext,
        initialDraft: action.initialDraft, draftCwd: action.cwd }
      return { ...state, tabs: [...state.tabs, tab], active: tab.id, nextId: tab.id + 1 }
    }
    case 'close': {
      const id = action.id ?? state.active
      const index = state.tabs.findIndex((tab) => tab.id === id)
      if (index === -1) return state

      const closing = state.tabs[index]
      const restorable = closing.type && closing.type !== 'chat' && closing.type !== 'terminal' && (closing.type !== 'browser' || closing.url)
      const closedTabs = restorable ? [closing, ...state.closedTabs].slice(0, 12) : state.closedTabs
      const tabs = state.tabs.filter((tab) => tab.id !== id)
      if (!tabs.length) {
        const tab = newTab(state.nextId)
        return { ...state, tabs: [tab], active: tab.id, nextId: tab.id + 1, closedTabs }
      }

      const active = state.active === id ? tabs[Math.min(index, tabs.length - 1)].id : state.active
      return { ...state, tabs, active, closedTabs }
    }
    default:
      return state
  }
}
