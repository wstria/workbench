import { useEffect, useState } from 'react'
import {
  Activity, CalendarClock, ChevronLeft, ChevronRight, Code2, Database, File, FileText, Folder, HardDrive,
  KeyRound, LayoutGrid, List, Mail, Palette, Pause, Play, Plug, Plus, Sheet, Timer, Trash2,
} from 'lucide-react'
import { runActivity, runStatuses } from '@/lib/run-activity'
import { harnessNames } from '@/lib/harnesses'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Empty, ErrorNotice, formatDate, Page, SearchField, Segments } from '@/components/workbench-ui'

const api = window.workbench
const artifactTypes = [
  { id: 'doc', label: 'Docs', icon: FileText, color: 'blue', extensions: ['.md', '.txt', '.docx'] },
  { id: 'sheet', label: 'Sheets', icon: Sheet, color: 'green', extensions: ['.xlsx', '.xls'] },
  { id: 'code', label: 'Code', icon: Code2, color: 'violet', extensions: ['.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.json', '.sql', '.sh', '.css'] },
  { id: 'design', label: 'Design', icon: Palette, color: 'pink', extensions: ['.html', '.svg', '.png', '.jpg', '.webp'] },
  { id: 'data', label: 'Data', icon: Database, color: 'amber', extensions: ['.csv', '.tsv'] },
  { id: 'pdf', label: 'PDFs', icon: File, color: 'red', extensions: ['.pdf'] },
]
const otherType = { label: 'File', icon: File, color: 'neutral' }

export function ArtifactsPage({ items, openFile, chooseFiles }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [list, setList] = useState(false)
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(null)
  const visible = items.filter((item) => (filter === 'all' || item.created === (filter === 'created'))
    && item.name.toLowerCase().includes(query.toLowerCase()))

  async function create(kind) {
    setError(null)
    setCreating(kind)
    try { openFile(await api.createArtifact(kind)) } catch (err) { setError(err) } finally { setCreating(null) }
  }

  return (
    <Page title="Artifacts" actions={<Button variant="outline" size="sm" onClick={chooseFiles}><Plus /> Import files</Button>}>
      <div className="work-filterbar">
        <Segments label="Artifact source" value={filter} onChange={setFilter} options={[[ 'all', 'All' ], [ 'created', 'Created here' ], [ 'imported', 'Opened files' ]]} />
        <div className="work-actions">
          <SearchField label="Search artifacts" value={query} onChange={setQuery} />
          <Button variant="ghost" size="icon-sm" aria-label={list ? 'Grid view' : 'List view'} onClick={() => setList(!list)}>{list ? <LayoutGrid /> : <List />}</Button>
        </div>
      </div>
      <div className="work-section-label">Make something new</div>
      <div className="artifact-types">
        {artifactTypes.map(({ id, label, icon: Icon, color }) => (
          <button key={id} type="button" className="artifact-type" disabled={Boolean(creating)} onClick={() => create(id)}>
            <span className="artifact-color" data-color={color}><Icon aria-hidden="true" /></span>
            <span>{label}</span>
          </button>
        ))}
      </div>
      <ErrorNotice error={error} />
      {visible.length ? (
        <div className={list ? 'artifact-list' : 'artifact-grid'}>
          {visible.map((item) => {
            const { icon: Icon, color } = artifactTypes.find((type) => type.extensions.includes(item.extension)) ?? otherType
            return (
              <button key={item.path} type="button" className="artifact-card" onClick={() => openFile(item)} title={item.path}>
                <span className="artifact-color artifact-preview" data-color={color}><Icon aria-hidden="true" /></span>
                <span className="artifact-caption"><strong>{item.name}</strong><small>{formatDate(item.at)}</small></span>
                {list && <ChevronRight size={16} />}
              </button>
            )
          })}
        </div>
      ) : <Empty icon={FileText} title={query ? 'No matching artifacts' : 'No artifacts yet'} text={query ? null : 'Create or open a file to add it here.'} />}
    </Page>
  )
}

const activityIcons = { automation: Timer, session: Activity, file: FileText, workspace: HardDrive, review: Code2, computer: HardDrive, inbox: Mail }

function dayStart(date) {
  const copy = new Date(date)
  copy.setHours(0, 0, 0, 0)
  return +copy
}

function scheduledOn(task, day) {
  if (task.paused) return null
  const date = new Date(day)
  const [hours, minutes] = task.time.split(':').map(Number)
  date.setHours(hours, minutes, 0, 0)
  if (+date < task.nextRunAt || (task.frequency === 'weekly' && date.getDay() !== task.weekday) ||
    (task.frequency === 'weekdays' && [0, 6].includes(date.getDay()))) return null
  return { id: task.id + ':' + +date, title: task.name, at: +date, kind: 'automation', workspace: task.cwd, harness: 'pi', upcoming: true, target: { type: 'automation', id: task.id } }
}

export function ActivityPage({ items, tasks, runs = [], attention = [], view, onViewChange, openTarget }) {
  const [workspace, setWorkspace] = useState('')
  const [harness, setHarness] = useState('')
  const [status, setStatus] = useState('')
  const recent = [...runs.map((run) => runActivity(run)), ...items].sort((a, b) => b.at - a.at)
  const workspaces = [...new Set([...recent, ...attention, ...tasks].map((item) => item.workspace ?? item.cwd).filter(Boolean))]
  const harnesses = [...new Set([...recent, ...attention, ...tasks.map(() => ({ harness: 'pi' }))].map((item) => item.harness).filter(Boolean))]
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [month, setMonth] = useState(() => new Date())
  const [selectedDay, setSelectedDay] = useState(() => dayStart(Date.now()))
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const days = Array.from({ length: 42 }, (_, index) => new Date(first.getFullYear(), first.getMonth(), index + 1 - first.getDay()))
  const upcoming = tasks.filter((task) => !task.paused).map((task) => ({
    id: task.id, title: task.name, at: task.nextRunAt, kind: 'automation', workspace: task.cwd, harness: 'pi', description: 'Scheduled',
    upcoming: true, target: { type: 'automation', id: task.id },
  }))
  function matches(item) {
    return (filter === 'all' || item.kind === filter) &&
      (!workspace || item.workspace === workspace) && (!harness || item.harness === harness) && (view === 'upcoming' || !status || item.status === status) &&
      (item.title + ' ' + (item.description ?? '')).toLowerCase().includes(query.trim().toLowerCase())
  }
  const calendar = new Map()
  if (view === 'calendar') {
    const entriesByDay = new Map()
    for (const item of recent) {
      if (!matches(item)) continue
      const day = dayStart(item.at)
      if (!entriesByDay.has(day)) entriesByDay.set(day, [])
      entriesByDay.get(day).push(item)
    }
    for (const day of days) {
      const planned = tasks.map((task) => scheduledOn(task, day)).filter((item) => item && matches(item))
      calendar.set(+day, [...(entriesByDay.get(+day) ?? []), ...planned].sort((a, b) => a.at - b.at))
    }
  }
  const visible = view === 'calendar' ? calendar.get(selectedDay) ?? []
    : (view === 'upcoming' ? upcoming.sort((a, b) => a.at - b.at) : view === 'attention' ? attention : recent).filter(matches)

  function moveMonth(offset) {
    const next = new Date(month.getFullYear(), month.getMonth() + offset, 1)
    setMonth(next)
    setSelectedDay(+next)
  }

  return <Page title="Activity" description="Review decisions, track runs, and see what’s scheduled.">
    <div className="work-filterbar">
      <Segments label="Activity view" value={view} onChange={onViewChange} options={[[ 'recent', 'Recent' ], [ 'attention', 'Needs attention' ], [ 'upcoming', 'Upcoming' ], [ 'calendar', 'Calendar' ]]} />
      <SearchField label="Search activity" value={query} onChange={setQuery} />
    </div>
    <div className="work-filterbar">
      <Segments label="Activity type" value={filter} onChange={setFilter} options={[[ 'all', 'All' ], [ 'session', 'Sessions' ], [ 'automation', 'Automations' ], [ 'file', 'Files' ], [ 'review', 'Reviews' ], [ 'computer', 'Computers' ], [ 'inbox', 'Inbox' ], [ 'memory', 'Memory' ]]} />
    </div>
    <div className="activity-filters">
      <select aria-label="Filter activity by workspace" value={workspace} onChange={(event) => setWorkspace(event.target.value)}>
        <option value="">All workspaces</option>{workspaces.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
      <select aria-label="Filter activity by harness" value={harness} onChange={(event) => setHarness(event.target.value)}>
        <option value="">All harnesses</option>{harnesses.map((value) => <option key={value} value={value}>{harnessNames[value] ?? value}</option>)}
      </select>
      {view !== 'upcoming' && <select aria-label="Filter activity by status" value={status} onChange={(event) => setStatus(event.target.value)}>
        <option value="">All statuses</option>{Object.entries(runStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>}
    </div>
    {view === 'calendar' && <section className="activity-calendar" aria-label="Activity calendar">
      <header><strong>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong>
        <Button size="icon-sm" variant="ghost" aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft /></Button>
        <Button size="icon-sm" variant="ghost" aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight /></Button>
      </header>
      <div className="activity-calendar-grid">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => <small key={day}>{day}</small>)}
        {days.map((day) => <button type="button" key={+day} data-other={day.getMonth() !== month.getMonth()} aria-pressed={+day === selectedDay}
          aria-label={day.toLocaleDateString()} onClick={() => setSelectedDay(+day)}><span>{day.getDate()}</span>
          {calendar.get(+day).length > 0 && <small>{calendar.get(+day).length}</small>}</button>)}
      </div>
    </section>}
    {!visible.length && <Empty icon={Activity} title="No activity in this view" />}
    <div className="activity-group">
      {visible.map((entry) => {
        const Icon = activityIcons[entry.kind] ?? Activity
        const Element = entry.target ? 'button' : 'div'
        return <Element key={entry.id} className="activity-row" {...(entry.target ? { type: 'button', onClick: () => openTarget(entry.target) } : {})}>
          <Icon size={16} aria-hidden="true" />
          <span><strong>{entry.title}</strong>{entry.description && <small>{entry.description}</small>}</span>
          <span className="activity-meta">
            {entry.status && <small className="activity-status" data-status={entry.status}>{runStatuses[entry.status]}</small>}
            {entry.at && <time dateTime={new Date(entry.at).toISOString()}>{formatDate(entry.at)}</time>}
          </span>
        </Element>
      })}
    </div>
  </Page>
}

const frequencies = { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly' }

export function AutomationsPage({ tasks, onEdit, onRun, onLatest }) {
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(null)
  async function act(id, operation) {
    setError(null)
    setPending(id)
    try { await operation() } catch (err) { setError(err) } finally { setPending(null) }
  }

  return (
    <Page title="Automations" description="Schedule agents for a workspace and choose which tools they can use. Runs start while Workbench is open."
      actions={<Button variant="secondary" size="sm" onClick={() => onEdit()}><Plus /> New automation</Button>}>
      <ErrorNotice error={error} />
      {tasks.length ? <div className="automation-list">
        {tasks.map((task) => (
          <div className="integration-row" key={task.id}>
            <span className="integration-icon"><CalendarClock size={19} /></span>
            <button type="button" className="work-row-title" onClick={() => onEdit(task)}><strong>{task.name}</strong><small>{task.paused ? 'Paused' : 'Next · ' + formatDate(task.nextRunAt)} · {frequencies[task.frequency]}</small></button>
            <div className="work-actions">
              {task.lastRunId && <Button variant="ghost" size="sm" onClick={() => onLatest(task.lastRunId)}>Last run</Button>}
              <Button variant="ghost" size="icon-sm" aria-label={(task.paused ? 'Resume ' : 'Pause ') + task.name} onClick={() => act(task.id, () => api.pauseAutomation(task.id, !task.paused))} disabled={pending === task.id}>{task.paused ? <Play /> : <Pause />}</Button>
              <Button variant="outline" size="sm" onClick={() => act(task.id, () => onRun(task.id))} disabled={pending === task.id}>Run now</Button>
            </div>
          </div>
        ))}
      </div> : <Empty icon={CalendarClock} title="No scheduled tasks yet" text="Create a task to run Pi on a schedule." />}
    </Page>
  )
}

export function AutomationEditor({ task, cwd, openFolders = [], preset, onDone }) {
  const inboxPreset = preset === 'inbox'
  const [name, setName] = useState(task?.name ?? (inboxPreset ? 'Inbox briefing' : ''))
  const [prompt, setPrompt] = useState(task?.prompt ?? (inboxPreset
    ? 'Summarize the latest Inbox threads. List urgent items first, describe what needs a reply, cite the original Fastmail links, and flag decisions for me to review.'
    : ''))
  const [frequency, setFrequency] = useState(task?.frequency ?? 'daily')
  const [weekday, setWeekday] = useState(task?.weekday ?? new Date().getDay())
  const [time, setTime] = useState(task?.time ?? '09:00')
  const [workspace, setWorkspace] = useState(task?.cwd ?? cwd)
  const [tools, setTools] = useState(task?.tools ?? (inboxPreset ? [] : ['read', 'grep', 'find', 'ls']))
  const [includeInbox, setIncludeInbox] = useState(task?.includeInbox ?? inboxPreset)
  const [picked, setPicked] = useState(task?.integrations ?? [])
  const [integrations, setIntegrations] = useState([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(null)
  useEffect(() => {
    let mounted = true
    api.listIntegrations().then((items) => { if (mounted) setIntegrations(items.filter((item) => item.enabled && item.availableForAutomation)) })
      .catch((err) => { if (mounted) setError(err) })
    return () => { mounted = false }
  }, [])
  const select = (values, id) => values.includes(id) ? values.filter((item) => item !== id) : [...values, id]
  async function perform(action) {
    setPending(true)
    setError(null)
    try { await action(); onDone() } catch (err) { setError(err) } finally { setPending(false) }
  }
  return (
    <Page title={task ? 'Edit scheduled task' : 'New scheduled task'}>
      <form className="automation-form" onSubmit={(event) => {
        event.preventDefault()
        void perform(() => api.saveAutomation({ id: task?.id, name, prompt, frequency, weekday, time, cwd: workspace === cwd ? null : workspace, tools, integrations: picked, includeInbox }))
      }}>
        <div className="work-field"><Label htmlFor="automation-name">Name</Label><Input id="automation-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Daily briefing" required maxLength={100} /></div>
        <div className="automation-prompt">
          <textarea aria-label="Task instructions" value={prompt} onChange={(event) => setPrompt(event.target.value)} required maxLength={20000} placeholder="Give instructions for how you want this task to go" />
          <div><span><Plug size={15} /> Pi</span><span>Read-only file tools</span></div>
        </div>
        <div className="automation-trigger">
          <CalendarClock size={17} /><strong>Schedule</strong>
          <select aria-label="Frequency" value={frequency} onChange={(event) => setFrequency(event.target.value)}>{Object.entries(frequencies).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
          {frequency === 'weekly' && <select aria-label="Day of week" value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((name, index) => <option key={name} value={index}>{name}</option>)}</select>}
          <Input type="time" aria-label="Scheduled time" value={time} onChange={(event) => setTime(event.target.value)} required />
        </div>
        <div className="automation-options">
          <div className="work-field"><Label htmlFor="automation-workspace">Workspace</Label>
            <div className="work-actions">
              <select id="automation-workspace" value={workspace} onChange={(event) => setWorkspace(event.target.value)}>
                <option value={cwd}>Default workspace</option>
                {[...new Set([workspace, ...openFolders])].filter((folder) => folder && folder !== cwd)
                  .map((folder) => <option key={folder} value={folder}>{folder}</option>)}
              </select>
              <Button type="button" size="sm" variant="outline" onClick={async () => {
                try { const folder = await api.chooseFolder(); if (folder) setWorkspace(folder.path) } catch (err) { setError(err) }
              }}><Folder /> Choose folder</Button>
            </div>
          </div>
          <fieldset><legend>Tools and skills</legend>
            {[['read', 'Read files'], ['grep', 'Search contents'], ['find', 'Find paths'], ['ls', 'List folders']].map(([id, label]) =>
              <label key={id}><input type="checkbox" checked={tools.includes(id)} onChange={() => setTools(select(tools, id))} />{label}</label>)}
            {integrations.map((item) => <label key={item.id}><input type="checkbox" checked={picked.includes(item.id)}
              onChange={() => setPicked(select(picked, item.id))} />{item.name}</label>)}
            <label><input type="checkbox" checked={includeInbox} onChange={(event) => setIncludeInbox(event.target.checked)} />Include Fastmail inbox</label>
            {includeInbox && <p className="inbox-automation-note">Sends recent inbox excerpts to the selected model provider for this briefing. Reply drafts stay in Workbench.</p>}
          </fieldset>
        </div>
        <ErrorNotice error={error} />
        <div className="automation-actions">
          {task && <Button type="button" variant="ghost" disabled={pending} onClick={() => { if (confirm('Remove this automation?')) void perform(() => api.removeAutomation(task.id)) }}><Trash2 /> Remove</Button>}
          <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
          <Button type="submit" variant="secondary" disabled={pending}>{task ? 'Save changes' : 'Create'}</Button>
        </div>
      </form>
    </Page>
  )
}

export function IntegrationsPage({ data, openHarnessSettings, openProvider }) {
  const [query, setQuery] = useState('')
  const [error, setError] = useState(null)
  const rows = [
    { name: 'Pi', detail: 'Local coding harness for agent sessions', icon: Plug, status: 'Installed' },
    { name: 'OpenCode', detail: 'Local harness that uses your OpenCode providers', icon: Plug, status: 'Harness settings', action: openHarnessSettings },
    { name: 'Model providers', detail: 'Connect API keys and custom endpoints for Pi', icon: KeyRound, status: 'Provider settings', action: openProvider },
    { name: 'Default workspace', detail: data.cwd, icon: Folder, status: 'Show in Finder', action: () => api.revealData('workspace').catch(setError) },
    { name: 'Local storage', detail: data.root, icon: HardDrive, status: 'Show in Finder', action: () => api.revealData().catch(setError) },
  ].filter((row) => row.name.toLowerCase().includes(query.toLowerCase()))
  return (
    <Page title="Integrations" description="Manage the tools and folders available in this workspace.">
      <SearchField label="Search integrations" value={query} onChange={setQuery} className="integration-search" />
      <div className="work-section-label">Available integrations</div>
      <div className="integration-grid">
        {rows.map(({ name, detail, icon: Icon, action, status }) => (
          <div className="integration-row" key={name}>
            <span className="integration-icon"><Icon size={21} /></span>
            <span className="work-row-title"><strong>{name}</strong><small title={detail}>{detail}</small></span>
            {action ? <Button onClick={action} variant="outline" size="sm">{status}</Button> : <small>{status}</small>}
          </div>
        ))}
      </div>
      {!rows.length && <Empty icon={Plug} title="No matching integrations" />}
      <ErrorNotice error={error} />
    </Page>
  )
}
