import { useEffect, useState } from 'react'
import { Activity, Brain, Bookmark, CalendarClock, ChevronRight, Cpu, FilePlus, FileText, Folder, FolderOpen, Globe, Monitor, Terminal, UserRound, Layers3, MessageSquare, MessageSquarePlus, Palette, Pipette, Plug, Search, Settings2, Shield, Type } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { SETTINGS_SECTIONS } from '@/lib/settings-sections'
import { sessionColor } from '@/components/team-sessions'
import { FileTreeSidebar } from '@/components/file-tree'
import { UsageIndicator } from '@/components/usage-settings'
import { SourceIcon } from '@/components/source-library'
import { formatDate } from '@/components/workbench-ui'

const SECTION_ICONS = {
  general: Settings2,
  profile: UserRound, memory: Brain, routing: Cpu, usage: Activity,
  harness: Cpu,
  models: Layers3,
  permissions: Shield,
  providers: Plug,
  themes: Palette,
  colors: Pipette,
  typography: Type,
}

const paneLinks = [
  ['files', 'Files', Folder],
  ['browser', 'Web', Globe],
  ['computers', 'Computers', Monitor],
  ['favorites', 'Favorites', Bookmark],
  ['automations', 'Automations', CalendarClock],
  ['activity', 'Activity', Activity],
  ['integrations', 'Integrations', Plug],
  ['artifacts', 'Artifacts', Layers3],
]

export function WorkspaceRail({ settingsOpen, onOpenSettings, activeType, openPage, newChat, newNote, openTerminal, openUsage, openProfile }) {
  const { open, isMobile, openMobile } = useSidebar()
  const expanded = isMobile ? openMobile : open

  return (
    <div className="workspace-rail">
      <nav className="work-rail-nav" aria-label="Workbench">
        <SidebarTrigger
          className="chrome-button"
          aria-controls="workspace-sidebar"
          aria-expanded={expanded}
          title="Toggle sidebar"
        />
        <Button type="button" variant="ghost" size="icon" className="chrome-button" aria-label="New chat" title="New chat" onClick={newChat}>
          <MessageSquarePlus aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="chrome-button" aria-label="New note" title="New note" onClick={newNote}><FilePlus /></Button>
        <Button type="button" variant="ghost" size="icon" className="chrome-button" aria-label="Terminal" title="Terminal" data-active={activeType === 'terminal'} onClick={openTerminal}><Terminal /></Button>
        {paneLinks.map(([type, label, Icon]) => (
          <Button key={type} type="button" variant="ghost" size="icon" className="chrome-button"
            aria-label={label} title={label} data-active={activeType === type || (type === 'files' && ['file', 'folder', 'changes'].includes(activeType))} onClick={() => openPage(type)}>
            <Icon aria-hidden="true" />
          </Button>
        ))}
      </nav>
      <div className="rail-account">
      <UsageIndicator openUsage={openUsage} />
      <Button type="button" variant="ghost" size="icon" className="chrome-button" aria-label="Profile" title="Profile" onClick={openProfile}><UserRound /></Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="chrome-button"
        aria-label="Settings"
        data-active={settingsOpen}
        title="Settings"
        onClick={onOpenSettings}
      >
        <Settings2 aria-hidden="true" />
      </Button></div>
    </div>
  )
}

function ChatSidebar({ query, sessions, openSession }) {
  const term = query.toLowerCase().trim()
  const groups = new Map()
  for (const session of sessions) {
    const key = session.familyId ?? session.id
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(session)
  }

  const visible = []
  for (const group of groups.values()) {
    const ids = new Set(group.map((item) => item.id))
    if (!group.some((item) => item.title.toLowerCase().includes(term))) continue
    const visited = new Set()
    function visit(session, depth) {
      if (visited.has(session.id)) return
      visited.add(session.id)
      visible.push({ session, depth })
      group.filter((item) => item.parentId === session.id).toReversed().forEach((item) => visit(item, depth + 1))
    }
    for (const item of group.filter((item) => !ids.has(item.parentId))) visit(item, 0)
    for (const item of group) visit(item, 0)
  }

  return <SidebarContent className="work-sidebar-items">
    <p className="settings-nav-label">Chats</p>
    <SidebarMenu>{visible.map(({ session, depth }) => (
      <SidebarMenuItem key={session.id}><SidebarMenuButton title={session.title} className="chat-history-row"
        style={{ '--session-color': sessionColor(session), '--session-depth': Math.min(depth, 5) }} onClick={() => openSession(session)}>
        {session.familyId
          ? <span className="chat-family-dot" aria-label={depth ? 'Linked child session' : 'Linked session'} />
          : <MessageSquare aria-hidden="true" />}
        <span>{session.title}</span>
      </SidebarMenuButton></SidebarMenuItem>
    ))}</SidebarMenu>
    {!visible.length && <p className="sidebar-empty">{term ? 'No matching chats.' : 'Your chats appear here.'}</p>}
  </SidebarContent>
}

function WorkSidebar({ mode, automations, query, openTarget, setActivityView, attention, integrations, integrationFilter, setIntegrationFilter, onToggleIntegration, openAutomation, artifacts, vaults, favorites, openSource, openFile, computers, selectComputer, openFolder, openPage }) {
  const term = query.toLowerCase().trim()
  const matches = (label) => label.toLowerCase().includes(term)
  const upcoming = automations.filter((item) => !item.paused && matches(item.name)).slice().sort((a, b) => a.nextRunAt - b.nextRunAt)
  return <SidebarContent className="work-sidebar-items">
    {mode === 'activity' && <>
      <SidebarMenu>
        {[['recent', 'Recent'], ['attention', 'Needs attention'], ['calendar', 'Calendar'], ['upcoming', 'Upcoming']].map(([id, label]) => <SidebarMenuItem key={id}><SidebarMenuButton onClick={() => setActivityView(id)}>{label}</SidebarMenuButton></SidebarMenuItem>)}
      </SidebarMenu>
      <p className="settings-nav-label">Open decisions</p>
      <SidebarMenu>{attention.filter((item) => matches(item.title)).slice(0, 8)
        .map((item) => <SidebarMenuItem key={item.id}><SidebarMenuButton onClick={() => openTarget(item.target)} title={item.title}>
          <Activity size={14} /><span>{item.title}</span>
        </SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
    </>}
    {['activity', 'automations', 'automation-edit'].includes(mode) && <>
      <p className="settings-nav-label">{mode === 'activity' ? 'Upcoming' : 'Scheduled tasks'}</p>
      <SidebarMenu>{(mode === 'activity' ? upcoming : automations.filter((item) => matches(item.name))).slice(0, 12).map((task) =>
        <SidebarMenuItem key={task.id}><SidebarMenuButton title={task.paused ? 'Paused' : formatDate(task.nextRunAt)} onClick={() => openAutomation(task)}>
          <CalendarClock size={14} /><span>{task.name}</span>
        </SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
    </>}
    {mode === 'favorites' && <>
      <p className="settings-nav-label">Saved sources</p>
      <SidebarMenu>{favorites.filter((item) => matches(item.name)).slice(0, 28).map((item) =>
        <SidebarMenuItem key={item.key}><SidebarMenuButton title={item.name} onClick={() => openSource(item)}><SourceIcon source={item} /><span>{item.name}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
    </>}
    {mode === 'artifacts' && <>
      <p className="settings-nav-label">Markdown vaults</p>
      <SidebarMenu>{vaults.filter((item) => matches(item.name)).map((item) =>
        <SidebarMenuItem key={item.id}><SidebarMenuButton title={item.path} onClick={() => openFolder(item)}><Folder /><span>{item.name}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
      <p className="settings-nav-label">Recent files</p>
      <SidebarMenu>{artifacts.filter((item) => matches(item.name)).slice(0, 24).map((item) =>
        <SidebarMenuItem key={item.path}><SidebarMenuButton title={item.path} onClick={() => openFile(item.path)}><FileText /><span>{item.name}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
    </>}
    {mode === 'computers' && <>
      <p className="settings-nav-label">Local computers</p>
      <SidebarMenu>{computers.filter((item) => matches(item.name)).map((item) =>
        <SidebarMenuItem key={item.id}><SidebarMenuButton title={item.name} onClick={() => selectComputer(item.id)}><Monitor /><span>{item.name}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
    </>}
    {mode === 'inbox' && <SidebarMenu>
      <SidebarMenuItem><SidebarMenuButton onClick={() => openPage('integrations')}>Integrations</SidebarMenuButton></SidebarMenuItem>
      <SidebarMenuItem><SidebarMenuButton onClick={() => openAutomation(undefined, 'inbox')}>Schedule a briefing</SidebarMenuButton></SidebarMenuItem>
    </SidebarMenu>}
    {mode === 'integrations' && <>
      <SidebarMenu>{[['all', 'All'], ['skills', 'Skills'], ['mcp', 'MCP servers'], ['extensions', 'Extensions']].map(([key, label]) =>
        <SidebarMenuItem key={key}><SidebarMenuButton isActive={integrationFilter === key} onClick={() => setIntegrationFilter(key)}>{label}</SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
      <SidebarMenu><SidebarMenuItem><SidebarMenuButton onClick={() => openPage('inbox')}>Inbox triage</SidebarMenuButton></SidebarMenuItem></SidebarMenu>
      <p className="settings-nav-label">Tools</p>
      {integrations.filter((item) => matches(item.name)).map((item) => <label className="sidebar-integration" key={item.id}>
        <span title={item.name}>{item.name}</span>
        <input type="checkbox" aria-label={'Enable ' + item.name} checked={item.enabled} onChange={(event) => onToggleIntegration(item.id, event.target.checked)} />
      </label>)}
    </>}
  </SidebarContent>
}

function BrowserSidebar({ favorites, history, query, openSource }) {
  const term = query.trim().toLowerCase()
  const groups = [
    ['Favorites', favorites.filter((item) => item.type === 'web')],
    ['Recent pages', history.map(({ url, title }) => ({ type: 'web', url, name: title || url }))],
  ]
  return <SidebarContent className="work-sidebar-items">
    {groups.map(([label, items]) => {
      const filtered = items.filter(({ name, url }) => (name + ' ' + url).toLowerCase().includes(term)).slice(0, 12)
      return <SidebarMenu key={label}>
        <p className="settings-nav-label">{label}</p>
        {filtered.map((source) => <SidebarMenuItem key={source.url}><SidebarMenuButton onClick={() => openSource(source)} title={source.url}>
          <SourceIcon source={source} /><span>{source.name}</span>
        </SidebarMenuButton></SidebarMenuItem>)}
        {!filtered.length && <p className="sidebar-empty">{term ? 'No matches.' : 'No pages yet.'}</p>}
      </SidebarMenu>
    })}
  </SidebarContent>
}

export function WorkspaceSidebar({ settingsOpen, browserMode, type, favorites, history, openSource, section,
  onSectionChange, fileTree, work, ...workspace }) {
  const { open, isMobile, setOpenMobile } = useSidebar()
  const [queries, setQueries] = useState({})
  const [settingsQuery, setSettingsQuery] = useState('')
  const files = ['files', 'file', 'folder', 'changes'].includes(type)
  const workModes = ['activity', 'run', 'automations', 'automation-edit', 'integrations', 'favorites', 'artifacts', 'computers', 'inbox']
  const queryKey = browserMode ? 'browser' : files ? 'files' : type === 'automation-edit' ? 'automations' : type === 'run' ? 'activity'
    : workModes.includes(type) ? type : 'chat'
  const query = queries[queryKey] ?? ''
  const setQuery = (value) => setQueries((previous) => ({ ...previous, [queryKey]: value }))
  const searchLabel = settingsOpen ? 'Search settings' : browserMode ? 'Search web library' : files ? 'Filter file tree'
    : type === 'integrations' ? 'Filter tools' : workModes.includes(type) ? 'Filter shortcuts' : 'Search chats'
  const terms = settingsQuery.toLowerCase().trim().split(/\s+/)
  const sections = SETTINGS_SECTIONS.filter(({ group, label, description, keywords }) => {
    const text = [group, label, description, keywords].join(' ').toLowerCase()
    return terms.every((term) => text.includes(term))
  })

  return (
    <Sidebar
      id={isMobile ? undefined : 'workspace-sidebar'}
      role={isMobile ? undefined : 'complementary'}
      aria-label={isMobile ? undefined : 'Sidebar'}
      className="workspace-sidebar"
      inert={!isMobile && !open}
    >
      {type === 'inbox' && isMobile && <SidebarHeader id="workspace-sidebar" />}
      {type !== 'inbox' && <SidebarHeader id={isMobile ? 'workspace-sidebar' : undefined} className="p-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <SidebarInput
            className="h-8 pl-8"
            type="search"
            placeholder={searchLabel}
            aria-label={searchLabel}
            autoComplete="off"
            spellCheck={false}
            value={settingsOpen ? settingsQuery : query}
            onChange={(event) => (settingsOpen ? setSettingsQuery : setQuery)(event.target.value)}
          />
        </div>
      </SidebarHeader>}
      {settingsOpen ? (
        <SidebarContent className="px-2">
          <nav className="settings-nav" aria-label="Settings sections">
            {[...new Set(sections.map(({ group }) => group))].map((group) => <div key={group}>
              <p className="settings-nav-label">{group}</p>
              <SidebarMenu>
              {sections.filter((entry) => entry.group === group).map(({ id, label }) => {
                const Icon = SECTION_ICONS[id] ?? Settings2
                return (
                  <SidebarMenuItem key={id}>
                    <SidebarMenuButton
                      isActive={section === id}
                      aria-current={section === id ? 'true' : undefined}
                      onClick={() => {
                        onSectionChange(id)
                        if (isMobile) setOpenMobile(false)
                      }}
                    >
                      <Icon aria-hidden="true" />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
              </SidebarMenu>
            </div>)}
            {!sections.length && <p className="sidebar-empty">No settings match your search.</p>}
          </nav>
        </SidebarContent>
      ) : browserMode ? <BrowserSidebar favorites={favorites} history={history} query={query} openSource={openSource} />
        : files ? <FileTreeSidebar {...fileTree} query={query} />
          : workModes.includes(type) ? <WorkSidebar {...work} mode={type === 'run' ? 'activity' : type} query={query} />
            : !type || ['chat', 'session', 'terminal'].includes(type) ? <ChatSidebar {...workspace} query={query} />
              : <SidebarContent className="work-sidebar-items"><p className="sidebar-empty">Open a tab from the rail.</p></SidebarContent>}
    </Sidebar>
  )
}
