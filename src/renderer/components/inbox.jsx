import { useCallback, useEffect, useState } from 'react'
import { CalendarClock, Copy, ExternalLink, Inbox, Mail, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Empty, ErrorNotice, Page, Segments, formatDate } from '@/components/workbench-ui'
import './inbox.css'

const api = window.workbench
const views = [['all', 'All threads'], ['urgent', 'Likely urgent'], ['unread', 'Unread'], ['drafts', 'Drafts']]
const statuses = { connected: 'Connected', disconnected: 'Disconnected', reauthenticate: 'Reconnect required', unavailable: 'Fastmail unavailable' }

export function InboxPage({ active, openWeb, schedule }) {
  const [mailbox, setMailbox] = useState(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState('')
  const [view, setView] = useState('all')
  const [editing, setEditing] = useState(null)

  const load = useCallback(() => api.inboxList().then(setMailbox), [])
  useEffect(() => {
    if (active) void load().catch(setError)
  }, [active, load])

  async function perform(operation, action) {
    setError(null)
    setNotice('')
    setBusy(operation)
    try {
      const result = await action()
      setMailbox(result)
      if (operation === 'connect') {
        setToken('')
        setNotice('Mailbox connected.')
      }
      if (operation === 'triage') {
        setNotice(result.counts.urgent + ' likely urgent · ' + result.counts.unread + ' other unread')
      }
      if (operation === 'save') {
        setEditing(null)
        setNotice('Draft saved in Workbench.')
      }
    } catch (err) {
      setError(err)
      void load().catch(() => {})
    } finally {
      setBusy(null)
    }
  }

  const connected = mailbox?.status === 'connected'
  const threads = mailbox?.threads ?? []
  const drafts = mailbox?.drafts ?? []
  const rows = view === 'drafts' ? [...drafts].sort((a, b) => b.updatedAt - a.updatedAt).map((item) =>
    threads.find((thread) => thread.id === item.threadId) ?? { id: item.threadId, subject: item.subject, url: item.url })
    : threads.filter((item) => view === 'all' || view === 'urgent' && item.priority === 'urgent' || view === 'unread' && item.unread)

  return <Page title="Inbox" description="Review your Fastmail inbox and prepare replies in Workbench."
    actions={connected && <>
      <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void perform('refresh', api.inboxRefresh)}>
        <RefreshCw className={busy === 'refresh' ? 'work-spin' : undefined} /> Refresh
      </Button>
      <Button variant="outline" size="sm" onClick={schedule}><CalendarClock /> Schedule a briefing</Button>
      <Button size="sm" disabled={Boolean(busy)} onClick={() => void perform('triage', api.inboxTriage)}>
        {busy === 'triage' ? 'Running triage…' : 'Run triage'}
      </Button>
    </>}>
    <section className="inbox-connection" aria-label="Fastmail connection">
      <div className="inbox-connection-title">
        <Mail size={20} aria-hidden="true" />
        <div><strong>Fastmail</strong><small>{mailbox?.account || 'One mailbox · read-only access'}</small></div>
        {mailbox && <span className="inbox-status" data-connected={connected}>{statuses[mailbox.status]}</span>}
      </div>
      {mailbox?.account && <div className="inbox-connection-actions">
        {mailbox.refreshedAt && <small>Updated {formatDate(mailbox.refreshedAt)}</small>}
        <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => {
          if (!confirm('Disconnect Fastmail and remove your cached threads and local drafts?')) return
          setEditing(null)
          void perform('disconnect', api.inboxDisconnect)
        }}>Disconnect</Button>
      </div>}
      {!connected && mailbox && <form className="inbox-connect-form" onSubmit={(event) => {
        event.preventDefault()
        void perform('connect', () => api.inboxConnect(token))
      }}>
        {mailbox.detail && <p>{mailbox.detail}</p>}
        <div className="work-field">
          <Label htmlFor="fastmail-token">Read-only JMAP API token</Label>
          <div className="inbox-token">
            <Input id="fastmail-token" type="password" value={token} onChange={(event) => setToken(event.target.value)}
              autoComplete="off" maxLength={4096} placeholder="Paste your API token" disabled={!mailbox.canConnect || Boolean(busy)} required />
            <Button size="sm" type="submit" disabled={!token.trim() || !mailbox.canConnect || Boolean(busy)}>{busy === 'connect' ? 'Connecting…' : 'Connect'}</Button>
          </div>
          <small>{mailbox.canConnect ? 'In Fastmail, create a JMAP token with Read-only access and Email selected.' : 'Unlock your system credential store to save a token.'}</small>
        </div>
        <div className="work-actions">
          <Button variant="ghost" size="sm" type="button" onClick={() => openWeb('https://app.fastmail.com/settings/security/tokens')}>
            <ExternalLink /> Manage API tokens
          </Button>
          {mailbox.account && <Button variant="outline" size="sm" type="button" disabled={Boolean(busy)}
            onClick={() => void perform('refresh', api.inboxRefresh)}>Retry connection</Button>}
        </div>
      </form>}
    </section>

    <ErrorNotice error={error} />
    {notice && <p className="inbox-notice" role="status">{notice}</p>}
    {(connected || threads.length > 0 || drafts.length > 0) && <section aria-label="Inbox threads">
      <div className="inbox-list-heading">
        <Segments label="Filter inbox" value={view} onChange={setView} options={views} />
        <small>{rows.length} {rows.length === 1 ? 'thread' : 'threads'}</small>
      </div>
      {!rows.length && <Empty icon={Inbox} title={view === 'drafts' ? 'No drafts yet' : 'No matching threads'}
        text={view === 'drafts' ? 'Run triage or open a thread to prepare a reply.' : undefined} />}
      {rows.map((thread) => {
        const draft = drafts.find((item) => item.threadId === thread.id)
        return <article className="inbox-thread" key={thread.id}>
          <div className="inbox-thread-header">
            <div><h2>{thread.subject}</h2><small>{[thread.sender, thread.receivedAt ? formatDate(thread.receivedAt) : ''].filter(Boolean).join(' · ')}</small></div>
            {thread.priority === 'urgent' && <span className="inbox-status">Likely urgent</span>}
          </div>
          {thread.preview && <p>{thread.preview}</p>}
          <div className="work-actions">
            <Button variant="ghost" size="sm" onClick={() => openWeb(thread.url || 'https://app.fastmail.com/mail/Inbox')}>
              <ExternalLink /> {thread.url ? 'Open original' : 'Open Fastmail'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing({ id: thread.id, text: draft?.text ?? '' })}>
              {draft ? 'Review draft' : 'Write draft'}
            </Button>
          </div>
          {editing?.id === thread.id && <form className="inbox-draft" onSubmit={(event) => {
            event.preventDefault()
            void perform('save', () => api.inboxSaveDraft(thread.id, editing.text))
          }}>
            <Label htmlFor="inbox-draft">Reply draft</Label>
            <textarea id="inbox-draft" value={editing.text} onChange={(event) => setEditing({ id: thread.id, text: event.target.value })}
              maxLength={12000} spellCheck rows={6} placeholder="Write a reply to review" />
            <div className="work-actions">
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button type="button" size="sm" variant="outline" disabled={!editing.text.trim()}
                onClick={() => navigator.clipboard.writeText(editing.text).then(() => setNotice('Draft copied.')).catch(setError)}><Copy /> Copy</Button>
              <Button type="submit" size="sm" disabled={Boolean(busy) || !editing.text.trim()}>Save local draft</Button>
            </div>
          </form>}
        </article>
      })}
    </section>}
  </Page>
}
