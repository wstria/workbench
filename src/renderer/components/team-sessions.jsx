import { useEffect, useState } from 'react'
import { ChevronDown, FolderOpen, GitBranch, Network } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorNotice, formatDate } from '@/components/workbench-ui'
import './team-sessions.css'

const api = window.workbench

export function sessionColor(session) {
  const id = session?.familyId
  if (!id) return undefined
  const hash = Array.from(id).reduce((result, letter) => Math.imul(result, 31) + letter.charCodeAt(0), 0)
  return 'hsl(' + ((hash >>> 0) % 360) + ' 70% 57%)'
}

export function TeamSessions({ session, active, openSession, openChanges }) {
  const id = session.id
  const [family, setFamily] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!active) return
    let current = true
    let scheduled
    let sequence = 0
    const load = () => {
      const version = ++sequence
      api.sessionFamily(id).then((group) => {
        if (current && version === sequence) setFamily(group)
      }).catch((err) => { if (current && version === sequence) setError(err) })
    }
    const offChanges = api.onChange(() => {
      if (scheduled) return
      scheduled = setTimeout(() => { scheduled = undefined; load() }, 100)
    })
    const offTurns = api.onTranscript(({ id: sessionId, approvals, busy, paused }) => {
      const status = approvals?.length ? 'Needs approval' : busy ? 'Running' : paused ? 'Paused' : 'Ready'
      setFamily((group) => {
        const member = group?.members.find((item) => item.id === sessionId)
        return member && member.status !== status ? { ...group, members: group.members.map((item) =>
          item === member ? { ...item, status } : item) } : group
      })
    })
    load()
    return () => { current = false; clearTimeout(scheduled); offChanges(); offTurns() }
  }, [id, active])

  if (!family || family.members.length < 2) return <ErrorNotice error={error} />
  const { members, updates } = family
  const running = members.filter((member) => member.status === 'Running').length
  const attention = members.filter((member) => member.status === 'Needs approval').length
  return <section className="team-sessions" aria-label="Linked sessions" style={{ '--team-color': sessionColor(session) }}>
    <details>
      <summary>
        <Network size={15} aria-hidden="true" />
        <span>Linked sessions</span>
        <small>{members.length}{running > 0 && ' · ' + running + ' working'}{attention > 0 && ' · ' + attention + ' need approval'}</small>
        <ChevronDown className="disclosure-chevron" size={13} aria-hidden="true" />
      </summary>
      <ul className="team-member-list">
        {members.map((member) => <li key={member.id}>
          <button type="button" className="team-member" aria-current={member.id === id ? 'true' : undefined} onClick={() => openSession(member)}>
            <span className="team-marker" aria-hidden="true" />
            <span>{member.title}</span>
            <small>{member.id === id && 'Current · '}{member.status}</small>
          </button>
          {member.isolation === 'worktree' && <Button variant="ghost" size="icon-sm"
            aria-label={'Review changes from ' + member.title} title="Review worktree changes" onClick={() => openChanges(member)}><GitBranch /></Button>}
          {member.isolation === 'copy' && <Button variant="ghost" size="icon-sm" aria-label={'Open folder for ' + member.title}
            title="Open copied workspace" onClick={() => api.openExternal(member.cwd).catch(setError)}><FolderOpen /></Button>}
        </li>)}
      </ul>
      {updates.length > 0 && <div className="team-updates">
        <h3>Updates</h3>
        <ul>{updates.slice(-6).reverse().map((update) => <li key={update.id}>
          <strong>{update.title}</strong> <time dateTime={new Date(update.at).toISOString()}>{formatDate(update.at)}</time>
          <p>{update.text}</p>
        </li>)}</ul>
      </div>}
    </details>
    <ErrorNotice error={error} />
  </section>
}
