import { memo, useEffect, useId, useState } from 'react'
import { BookOpen, ChevronDown, FilePenLine, Globe, LoaderCircle, Network, Search, Shield, SquareTerminal, Wrench } from 'lucide-react'
import { diffLines, fileDisplayName, toolActivity } from '@/lib/transcript-activity.mjs'

const icons = { read: BookOpen, search: Search, terminal: SquareTerminal, edit: FilePenLine, web: Globe, team: Network, tool: Wrench }

const InlineDiff = memo(function InlineDiff({ value, path, title, openFile }) {
  const rows = diffLines(value)
  const added = rows.filter(({ change }) => change === 'add').length
  const removed = rows.filter(({ change }) => change === 'remove').length
  const label = fileDisplayName(path ?? title) || 'Changes'
  return <div className="inline-diff">
    <div className="diff-heading">
      <FilePenLine size={14} aria-hidden="true" />
      {path ? <button type="button" className="transcript-file-link" title={path} onClick={() => openFile(path)}>{label}</button> : <span>{label}</span>}
      <span className="diff-add" aria-label={added + ' additions'}>+{added}</span>
      <span className="diff-remove" aria-label={removed + ' deletions'}>−{removed}</span>
    </div>
    <pre aria-label={'Changes in ' + label}>{rows.map(({ text, change, number }, index) =>
      <span className="diff-line" key={index} data-change={change}><span className="diff-number" aria-hidden="true">{number}</span>
        <span className="diff-sign">{change === 'add' ? '+' : change === 'remove' ? '−' : ' '}</span><span>{text || ' '}</span>
      </span>)}</pre>
  </div>
})

function ToolEvent({ entry, openFile, openSession, color }) {
  const [expanded, setExpanded] = useState(false)
  const outputId = useId()
  if (entry.sessionLink) {
    return <div className="tool-event transcript-session-link" style={{ '--team-color': color }}>
      <span className="team-marker" aria-hidden="true" />
      <span>Started</span>
      <button type="button" className="transcript-file-link" onClick={() => openSession(entry.sessionLink)}>{entry.sessionLink.title}</button>
    </div>
  }
  if (entry.diff) return <InlineDiff value={entry.diff} path={entry.path} title={entry.title} openFile={openFile} />
  const activity = toolActivity(entry)
  const running = entry.status === 'running'
  const Icon = running ? LoaderCircle : icons[activity.kind]
  if (activity.file && entry.path) {
    const name = fileDisplayName(entry.path)
    return <div className="tool-event">
      <div className="tool-row">
        <Icon size={15} aria-hidden="true" /><span>{activity.label}</span>
        <button type="button" className="transcript-file-link" title={entry.path} onClick={() => openFile(entry.path)}>{name}</button>
        {entry.text && <button type="button" className="tool-output-toggle" aria-expanded={expanded} aria-controls={outputId}
          aria-label={(expanded ? 'Hide' : 'Show') + ' tool output for ' + name} onClick={() => setExpanded((value) => !value)}>
          <ChevronDown className="disclosure-chevron" size={13} aria-hidden="true" />
        </button>}
      </div>
      {entry.text && <div id={outputId} hidden={!expanded} className="tool-body">{expanded && <pre className="tool-output">{entry.text}</pre>}</div>}
    </div>
  }
  const target = typeof activity.target === 'string' ? activity.target.replace(/\s+/g, ' ').trim() : ''
  const row = <>
    <Icon size={15} className={running ? 'work-spin' : undefined} aria-hidden="true" />
    <span className="tool-label" title={entry.title}>{activity.label}{target && ' ' + target}</span>
    {entry.status === 'failed' && <span className="tool-failed">Failed</span>}
    {entry.status === 'stopped' && <span className="tool-status">Stopped</span>}
  </>
  if (!entry.text && !entry.path) return <div className="tool-event tool-row">{row}</div>
  return <details className="tool-event" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary className="tool-row">{row}<ChevronDown className="disclosure-chevron" size={13} aria-hidden="true" /></summary>
    {expanded && <div className="tool-body">
      {entry.path && <button type="button" className="transcript-file-link" title={entry.path} onClick={() => openFile(entry.path)}>
        Open {fileDisplayName(entry.path)}
      </button>}
      {entry.text && <pre className="tool-output">{entry.text}</pre>}
    </div>}
  </details>
}

export function ToolActivity({ row, ...actions }) {
  const [expanded, setExpanded] = useState(false)
  if (row.type !== 'tool-group') return <ToolEvent entry={row} {...actions} />
  if (row.tools.length === 1) return <ToolEvent entry={row.tools[0]} {...actions} />
  const first = toolActivity(row.tools[0])
  const Icon = icons[first.kind]
  const labels = [...new Set(row.tools.map((entry) => toolActivity(entry).summary))]
  const label = labels.map((part, index) => index ? part.toLowerCase() : part).join(', ')
  return <details className="tool-activity" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary className="tool-row"><Icon size={15} aria-hidden="true" /><span className="tool-label">{label}</span>
      <ChevronDown className="disclosure-chevron" size={13} aria-hidden="true" />
    </summary>
    {expanded && <div className="tool-activity-rows">{row.tools.map((entry) => <ToolEvent key={entry.id} entry={entry} {...actions} />)}</div>}
  </details>
}

export function TurnProgress({ startedAt, waiting }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!startedAt || waiting) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt, waiting])
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const elapsed = (seconds >= 60 ? Math.floor(seconds / 60) + 'm ' : '') + (seconds % 60) + 's'
  const Icon = waiting ? Shield : LoaderCircle
  return <div className="session-status turn-progress" role="status">
    <Icon size={14} className={!waiting ? 'work-spin' : undefined} aria-hidden="true" />
    {waiting ? 'Waiting for your approval' : <span>Working{startedAt && <span aria-hidden="true"> for {elapsed}</span>}</span>}
  </div>
}
