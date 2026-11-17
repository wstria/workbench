import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, AtSign, Globe, MessageSquare, CornerDownRight, FileDiff, FileText, Folder, FolderOpen, ListPlus, Monitor, LoaderCircle, Plus, Shield, Square, Trash2, X } from 'lucide-react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import { sourceFromLink } from '../../main/source-reference.mjs'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { ModelPicker } from '@/components/model-picker'
import { HarnessPicker } from '@/components/harness-picker'
import { SourceIcon, sourceDetail, sourceKey } from '@/components/source-library'
import { WelcomeGreeting } from '@/components/welcome-greeting'
import { ToolActivity, TurnProgress } from '@/components/transcript-activity'
import { sessionColor } from '@/components/team-sessions'
import { groupTranscript } from '@/lib/transcript-activity.mjs'
import { ErrorNotice } from '@/components/workbench-ui'
import { catalogRevision, executableSetting, harnessDisplayName } from '@/lib/harnesses'
import { useHarnessCatalog } from '@/hooks/use-harness-catalog'

const api = window.workbench
const approvalLabels = { bash: 'Run command', powershell: 'Run command', edit: 'Edit file', write: 'Write file',
  external_directory: 'Access a folder outside the workspace', workbench_team: 'Start linked session', subagent: 'Run a subagent' }
const emptyQueue = { queue: [], canSteer: false, paused: false, steering: null, queueError: null }

function contextKey(source) {
  return JSON.stringify([sourceKey(source), source.page, source.line, source.messageId, source.captureId])
}

function omitRobotIcons() {
  function visit(node) {
    if (node.type === 'text') node.value = node.value.replace(/\u{1f916}\uFE0F?/gu, '')
    node.children?.forEach(visit)
  }
  return visit
}

const AssistantReply = memo(function AssistantReply({ text, messageId, openWeb, openSource }) {
  return (<div className="session-response" data-message-id={messageId}>
    <Markdown remarkPlugins={[remarkGfm, omitRobotIcons]} urlTransform={(url) => sourceFromLink(url) ? url : defaultUrlTransform(url)} components={{
      a: ({ href, children }) => {
        const source = sourceFromLink(href)
        if (source) return <a href={href} onClick={(event) => { event.preventDefault(); openSource(source) }}>{children}</a>
        if (/^https?:\/\//i.test(href ?? '')) return <a href={href} onClick={(event) => { event.preventDefault(); openWeb(href) }}>{children}</a>
        return <span>{children}</span>
      },
      img: ({ alt }) => <span>{alt}</span>,
    }}>{text}</Markdown></div>
  )
})

export function SessionView({ tabId, active, location, session, workspace, ensureSession, openFile, draftCwd, chooseWorkspace, resetWorkspace, openIntegrations, openHarnessSettings,
  dock, teamPanel, openWeb, searchWeb, openSession, openReview, sourceOptions = [], captureSource, openSource, initialContext, initialDraft, computerName, computerId, openComputer, autoFocus }) {
  const [draft, setDraft] = useState(initialDraft ?? '')
  const [attachments, setAttachments] = useState(() => initialContext ? [initialContext] : [])
  const [mention, setMention] = useState(null)
  const [sourceMatches, setSourceMatches] = useState(null)
  const [inputMode, setInputMode] = useState('ask')
  const [searchDraft, setSearchDraft] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [capturing, setCapturing] = useState(false)
  const [chosenHarness, setChosenHarness] = useState(null)
  const [chosenModel, setChosenModel] = useState(null)
  const [chosenPermission, setChosenPermission] = useState(null)
  const [entries, setEntries] = useState([])
  const [approvals, setApprovals] = useState([])
  const [busy, setBusy] = useState(false)
  const [startedAt, setStartedAt] = useState(null)
  const [queued, setQueued] = useState(emptyQueue)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState(null)
  const [worktree, setWorktree] = useState(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [copyChoice, setCopyChoice] = useState(null)
  const end = useRef(null)
  const locatedMessage = useRef(null)
  const timeline = useRef(null)
  const nearEnd = useRef(true)
  const composer = useRef(null)
  const results = useRef(null)
  const sessionId = session?.id
  const rows = useMemo(() => groupTranscript(entries), [entries])
  const activePrompt = busy && startedAt ? entries.findLast((row) => row.type === 'user' && !row.steered && row.at >= startedAt) : undefined
  const progress = busy && <TurnProgress key={startedAt} startedAt={startedAt} waiting={approvals.length > 0} />
  const cwd = session?.cwd ?? draftCwd ?? workspace.cwd
  const worktreeInfo = worktree?.cwd === cwd ? worktree.info : null
  const separate = copyChoice === cwd ? worktreeInfo : undefined
  const lastReview = sessionId && workspace.reviews?.find((review) => review.sessionId === sessionId)
  const folderName = cwd === workspace.cwd ? 'Default workspace' : cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd
  const harness = computerId ? 'pi' : session ? session.harness ?? 'pi' : chosenHarness ?? workspace.harness
  const isPi = harness === 'pi'
  const harnessName = harnessDisplayName(workspace, harness)
  const catalog = useHarnessCatalog({ harness, cwd, executable: executableSetting(workspace, harness), enabled: active,
    providerRevision: catalogRevision(workspace, harness) })
  const defaults = workspace.harnessDefaults?.[harness]
  const preferredModel = isPi ? workspace.model : defaults?.model
  const selected = chosenModel?.harness === harness && chosenModel.cwd === cwd ? chosenModel.id : session?.model
  const compatibleDefault = catalog.models.some((item) => item.id === preferredModel)
  const model = selected || (compatibleDefault ? preferredModel : catalog.defaultModel) || ''
  const permission = chosenPermission?.harness === harness ? chosenPermission.value : session?.permission ?? defaults?.permission ?? 'ask'
  const canSend = catalog.models.some((item) => item.id === model)
  const hasDraft = Boolean(draft.trim() || attachments.length)
  const mentioned = new Set(attachments.map((item) => contextKey(item.source)))
  const query = (mention?.query ?? '').trim().toLowerCase()
  const tagSearch = query.startsWith('#')
  const search = tagSearch ? query.slice(1) : query
  const searching = Boolean(searchWeb) && inputMode === 'web'
  const matches = sourceOptions.filter((item) => {
    if (mentioned.has(contextKey(item.source))) return false
    const tags = item.source.tags ?? []
    if (tagSearch) return tags.some((tag) => tag.toLowerCase().includes(search))
    return [item.source.name, item.detail, item.group, ...tags, item.source.notes].join(' ').toLowerCase().includes(search)
  }).slice(0, 8).map((item) => ({ ...item, key: contextKey(item.source) }))
  const baseKeys = new Set(matches.map((item) => item.key))
  const indexed = sourceMatches?.query === query ? sourceMatches.items.filter((item) => !baseKeys.has(item.key) && !mentioned.has(item.key)) : []
  const choices = [...indexed, ...matches].slice(0, 10)
  choices.push({ key: 'pick-files', label: 'Choose local files…', icon: FolderOpen },
    { key: 'pick-folder', label: 'Choose a folder…', icon: Folder })
  const willQueue = !session?.readOnly && (busy || queued.paused)

  useEffect(() => {
    if (!active || !detailsOpen || !cwd || sessionId || computerId) return
    let current = true
    api.reviewWorkspace(cwd).then((info) => {
      if (current) setWorktree({ cwd, info })
    }).catch((error) => {
      if (current) setWorktree({ cwd, error })
    })
    return () => { current = false }
  }, [active, detailsOpen, cwd, sessionId, computerId])

  useEffect(() => {
    if (!active || query.length < 2) return
    let current = true
    const timer = setTimeout(() => {
      api.searchSources({ query, cwd: cwd === workspace.cwd ? undefined : cwd, includeShared: true, limit: 16 }).then(({ items }) => {
        if (current) setSourceMatches({ query, items: items.map((item) => ({ ...item, key: contextKey(item.source) })) })
      }).catch(() => { if (current) setSourceMatches(null) })
    }, 100)
    return () => { current = false; clearTimeout(timer) }
  }, [query, active, cwd, workspace.cwd])

  useEffect(() => {
    if (!sessionId || !active) return
    let current = true
    let received = false
    const update = (state) => {
      setEntries(state.entries)
      setApprovals(state.approvals ?? [])
      setBusy(state.busy)
      setStartedAt(state.startedAt)
      setQueued({ queue: state.queue ?? [], canSteer: state.canSteer, paused: state.paused, steering: state.steering, queueError: state.queueError })
    }
    const unsubscribe = api.onTranscript((state) => {
      if (state.id !== sessionId) return
      received = true
      update(state)
    })
    api.transcript(sessionId).then((state) => { if (current && !received) update(state) })
      .catch((err) => { if (current) setError(err) })
    return () => { current = false; unsubscribe() }
  }, [sessionId, active])

  useEffect(() => {
    if (active && location?.messageId && locatedMessage.current !== location.request) {
      const target = Array.from(timeline.current?.querySelectorAll('[data-message-id]') ?? [])
        .find((element) => element.dataset.messageId === location.messageId)
      if (target) {
        locatedMessage.current = location.request
        nearEnd.current = false
        target.scrollIntoView({ block: 'center' })
      }
    } else if (active && nearEnd.current) end.current?.scrollIntoView({ block: 'end' })
  }, [active, entries, busy, approvals, location])

  useEffect(() => {
    results.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [mention, highlight])

  function addAttachments(picked) {
    const added = picked.filter((item) => !mentioned.has(contextKey(item.source)))
    if (attachments.length + added.length > 6) throw new Error('Choose up to six sources per message.')
    setAttachments((current) => [...current, ...added])
  }

  async function attachFiles() {
    setError(null)
    try {
      addAttachments(await api.chooseAttachments(cwd || undefined))
    } catch (err) { setError(err) }
  }

  function checkMention(value, caret) {
    if (capturing) return
    const prefix = value.slice(0, caret).match(/(?:^|\s)@([^\n@]{0,90})$/u)
    setMention(prefix ? { start: caret - prefix[1].length - 1, end: caret, query: prefix[1] } : null)
    setHighlight(0)
  }

  async function selectContext(choice) {
    if (!choice || capturing) return
    const range = mention
    const original = draft
    setMention(null)
    setCapturing(true)
    setError(null)
    try {
      let picked
      if (choice.key === 'pick-files') picked = await api.chooseAttachments(cwd || undefined)
      else if (choice.key === 'pick-folder') {
        const folder = await api.chooseFolder()
        picked = folder ? [await captureSource({ source: { type: 'folder', ...folder } })] : []
      } else picked = [await captureSource(choice)]
      if (picked.length) {
        addAttachments(picked)
        if (range) setDraft((current) => current === original ? current.slice(0, range.start) + current.slice(range.end) : current)
        requestAnimationFrame(() => {
          composer.current?.focus()
          if (range && composer.current?.value === original.slice(0, range.start) + original.slice(range.end)) {
            composer.current.setSelectionRange(range.start, range.start)
          }
        })
      }
    } catch (err) { setError(err) }
    finally { setCapturing(false) }
  }

  function mentionKeys(event) {
    if (!mention || capturing || event.nativeEvent.isComposing) return false
    if (!['Escape', 'ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) || event.metaKey || event.ctrlKey || event.shiftKey) return false
    event.preventDefault()
    if (event.key === 'Escape') { setMention(null); composer.current?.focus() }
    if (event.key === 'ArrowDown') setHighlight((index) => (index + 1) % choices.length)
    if (event.key === 'ArrowUp') setHighlight((index) => (index + choices.length - 1) % choices.length)
    if (event.key === 'Enter') void selectContext(choices[highlight] ?? choices[0])
    return true
  }

  function changeMode(mode) {
    setInputMode(mode)
    setMention(null)
    requestAnimationFrame(() => { composer.current?.focus(); if (mode === 'web') composer.current?.select() })
  }

  useEffect(() => {
    if (!active || !searchWeb) return
    const focusSearch = (event) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        changeMode('web')
      }
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [active, searchWeb])

  async function submit(event) {
    event?.preventDefault()
    if (searching) {
      if (!searchDraft.trim()) return
      searchWeb(searchDraft, hasDraft || capturing)
      setSearchDraft('')
      changeMode('ask')
      return
    }
    const text = draft.trim()
    if (!hasDraft || starting || capturing || !canSend || (session?.readOnly && busy)) return
    const files = attachments
    setStarting(true)
    setError(null)
    try {
      if (copyChoice === cwd && !separate) throw new Error('Refresh the workspace details or clear the separate copy setting.')
      const chat = session ?? await ensureSession(harness, separate)
      setMention(null)
      nearEnd.current = true
      setDraft('')
      setAttachments([])
      await api.prompt(chat.id, text, { model, permission,
        attachments: files.filter((item) => item.path).map((item) => item.path),
        context: files.filter((item) => !item.path),
      })
    } catch (err) {
      setDraft((current) => current || text)
      setAttachments((current) => current.length ? current : files)
      setError(err)
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="session-pane">
      {teamPanel}
      <div ref={timeline} className="session-timeline" onScroll={() => {
        const el = timeline.current
        nearEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
      }}>
        {!entries.length ? (
          <div className="session-empty">
            {busy ? progress : <WelcomeGreeting tabId={tabId} visible={active} animate={!sessionId} />}
          </div>
        ) : (
          <div className="session-transcript" aria-label="Session transcript">
            {rows.map((entry) => {
              if (entry.type === 'tool-group' || entry.type === 'tool') return <ToolActivity key={entry.id} row={entry}
                openFile={openFile} openSession={openSession} color={sessionColor(session)} />
              if (entry.type === 'user') {
                return <Fragment key={entry.id}><div className="session-user" data-message-id={entry.id}>
                  {entry.steered && <small className="session-steered"><CornerDownRight size={12} /> Steered</small>}
                  {entry.attachments?.map((name, index) => {
                    const source = entry.sources?.[index]
                    return source
                      ? <button type="button" className="transcript-attachment source-chip-link" title={source.excerpt ? sourceDetail(source) + '\n' + source.excerpt.slice(0, 800) : sourceDetail(source)} key={index} onClick={() => openSource(source)}><SourceIcon source={source} size={14} /><span>{name}</span></button>
                      : <span className="transcript-attachment" key={index}><FileText size={14} aria-hidden="true" /><span>{name}</span></span>
                  })}
                  {entry.text && <p>{entry.text}</p>}
                </div>{activePrompt?.id === entry.id && progress}</Fragment>
              }
              if (entry.type === 'error') return <ErrorNotice key={entry.id} error={entry.text} />
              if (entry.type === 'status') return <p className="session-status" key={entry.id}>{entry.text}</p>
              return <AssistantReply key={entry.id} text={entry.text} messageId={entry.id} openWeb={openWeb} openSource={openSource} />
            })}
            {lastReview && <div className="session-review">
              <Button type="button" variant="ghost" size="sm" onClick={() => openReview(lastReview.id)}>
                <FileDiff /> Review changes <span>{lastReview.fileCount} {lastReview.fileCount === 1 ? 'file' : 'files'}</span>
              </Button>
            </div>}
            {!activePrompt && progress}
          </div>
        )}
        <div ref={end} />
      </div>
      {dock}
      <div className="session-compose-wrap">
        <ErrorNotice error={error} />
        <ErrorNotice error={queued.queueError} />
        {!searching && <ErrorNotice error={catalog.error || (!catalog.loading && !canSend
          ? catalog.models.length ? 'Choose an available model.' : !isPi ? 'Set up ' + harnessName + ' in Harness settings.' : null
          : null)} />}
        {approvals.length > 0 && <div className="composer-approvals" aria-label="Pending approvals">
          {approvals.map((approval) => <div key={approval.id} className="composer-approval">
            <Shield size={16} aria-hidden="true" />
            <div><strong>{approvalLabels[approval.tool] ?? approval.tool}</strong><pre>{approval.target}</pre></div>
            <div className="composer-approval-actions">
              <Button type="button" size="sm" variant="ghost" onClick={() => api.decide(sessionId, approval.id, false).catch(setError)}>Deny</Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => api.decide(sessionId, approval.id, true).catch(setError)}>Allow once</Button>
            </div>
          </div>)}
        </div>}
        {!searching && computerId && <div className="composer-workspace"><Button type="button" variant="ghost" size="sm"
          className="session-folder" onClick={() => openComputer(computerId)}><Monitor size={14} /><span>{computerName ?? 'Isolated computer'}</span></Button></div>}
        {!searching && !computerId && cwd && <div className="composer-workspace">
          {chooseWorkspace
            ? <Button type="button" size="sm" variant="ghost" className="session-folder" aria-label={draftCwd ? `Change workspace (${folderName})` : undefined}
                title={draftCwd ? cwd : 'Optional. Uses the default workspace if skipped.'} disabled={starting} onClick={chooseWorkspace}>
                <FolderOpen /><span>{draftCwd ? folderName : 'Pick workspace'}</span>
              </Button>
            : <span className="session-folder" title={cwd}><FolderOpen size={14} aria-hidden="true" /><span>{folderName}</span></span>}
          {chooseWorkspace && draftCwd && <Button type="button" size="icon-xs" variant="ghost" aria-label="Use default workspace"
            title="Use default workspace" disabled={starting} onClick={resetWorkspace}><X /></Button>}
          {session ? <Button type="button" size="sm" variant="ghost" className="composer-harness"
            aria-label={harnessName + ' · Harness settings'} onClick={openHarnessSettings}>{harnessName}</Button>
            : <HarnessPicker data={workspace} label="Chat harness" value={harness} disabled={starting}
              className="composer-harness" onValueChange={setChosenHarness} />}
        </div>}
        {!searching && !computerId && cwd && (!session || session.reviewWorkspace) && <details className="composer-details"
          onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
          <summary>Workspace details{(separate || session?.reviewWorkspace) && <span> · Separate copy</span>}</summary>
          <div className="composer-details-content">
            {session?.reviewWorkspace ? <>
              <span>Checkout <code title={cwd}>{cwd}</code></span>
              <span>Apply to <code title={session.reviewWorkspace.target}>{session.reviewWorkspace.branch || 'Detached HEAD'} · {session.reviewWorkspace.target}</code></span>
            </> : worktreeInfo ? <>
              <label><input type="checkbox" checked={Boolean(separate)} disabled={starting} onChange={(event) => setCopyChoice(event.target.checked ? cwd : null)} />
                Work on a separate copy</label>
              <span>Start from <code>{worktreeInfo.branch || 'Detached HEAD'} · {worktreeInfo.revision.slice(0, 12)}</code></span>
              <small>Existing local changes stay in your checkout. Commands use the selected tool permissions.</small>
            </> : <>
              <small>{worktree?.cwd === cwd ? worktree.error?.message ?? 'Choose a Git folder with an initial commit to work on a separate copy.' : 'Checking workspace…'}</small>
              {copyChoice === cwd && <Button type="button" size="xs" variant="ghost" onClick={() => setCopyChoice(null)}>Use current checkout</Button>}
            </>}
          </div>
        </details>}
        {queued.queue.length > 0 && <section className="composer-queue" aria-label="Queued messages">
          {queued.paused && <div className="composer-queue-paused">
            <span>Queue paused</span>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => api.resumeQueue(sessionId).catch(setError)}>Resume queue</Button>
          </div>}
          <ul>
            {queued.queue.map((message) => <li className="composer-queue-row" key={message.id}>
              <ListPlus size={14} aria-hidden="true" />
              <span className="composer-queue-message" title={[message.text, ...message.attachments].filter(Boolean).join('\n')}>
                {message.text || message.attachments.join(', ')}
                {message.text && message.attachments.length > 0 && <small> · {message.attachments.length} {message.attachments.length === 1 ? 'source' : 'sources'}</small>}
              </span>
              <Button type="button" size="sm" variant="ghost" disabled={!queued.canSteer || Boolean(queued.steering)}
                title="Send to the active turn" onClick={() => api.steer(sessionId, message.id).catch(setError)}>
                <CornerDownRight />{queued.steering === message.id ? 'Steering…' : 'Steer'}
              </Button>
              <Button type="button" size="icon-xs" variant="ghost" title="Remove from queue" aria-label="Remove queued message"
                disabled={queued.steering === message.id} onClick={() => api.removeQueued(sessionId, message.id).catch(setError)}><Trash2 /></Button>
            </li>)}
          </ul>
        </section>}
        <form className="session-compose" onSubmit={submit} onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setMention(null)
        }}>
          {mention && <div className="context-picker">
            <div className="context-picker-heading"><AtSign size={15} aria-hidden="true" /><span>Add context</span><small>↑ ↓ Enter</small></div>
            <ul className="context-options" id={'context-options-' + tabId} role="listbox" aria-label="Context sources" ref={results}>
              {choices.map((choice, index) => <li id={'context-option-' + tabId + '-' + index} key={choice.key} role="option"
                aria-selected={index === highlight} onMouseEnter={() => setHighlight(index)}>
                <button tabIndex={-1} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => selectContext(choice)}>
                  {choice.source ? <SourceIcon source={choice.source} size={16} /> : <choice.icon size={16} aria-hidden="true" />}
                  <span><strong>{choice.source?.name ?? choice.label}</strong>{choice.detail && <small title={choice.detail}>{choice.detail}</small>}{choice.excerpt && <small title={choice.excerpt}>{choice.excerpt}</small>}</span>
                  {choice.group && <small className="context-option-group">{choice.group}</small>}
                </button>
              </li>)}
            </ul>
          </div>}
          {!searching && attachments.length > 0 && <div className="composer-attachments" aria-label="Attachments">
            {attachments.map((item) => <span className="composer-attachment" key={contextKey(item.source)}>
              <SourceIcon source={item.source} size={14} />
              <button type="button" className="source-chip-link" title={sourceDetail(item.source)} onClick={() => openSource(item.source)}>
                {item.name}{item.source.type === 'file' && (item.source.page ? ` · Page ${item.source.page}` : item.source.line ? ` · Line ${item.source.line}` : '')}
              </button>
              <Button type="button" size="icon-xs" variant="ghost" aria-label={'Remove ' + item.name} onClick={() => setAttachments((current) => current.filter((file) => file !== item))}><X /></Button>
            </span>)}
          </div>}
          <textarea ref={composer} autoFocus={autoFocus} className={searching ? 'composer-web-input' : undefined}
            aria-label={searching ? 'Search or enter a URL' : 'Message ' + harnessName}
            placeholder={searching ? 'Search or enter a URL' : 'Message ' + harnessName} value={searching ? searchDraft : draft}
            aria-controls={mention ? 'context-options-' + tabId : undefined}
            aria-activedescendant={mention ? 'context-option-' + tabId + '-' + highlight : undefined}
            onChange={(event) => {
              if (searching) setSearchDraft(event.target.value)
              else { setDraft(event.target.value); checkMention(event.target.value, event.target.selectionStart) }
            }}
            onClick={(event) => { if (!searching) checkMention(event.currentTarget.value, event.currentTarget.selectionStart) }}
            onKeyDown={(event) => {
              if (!searching && mentionKeys(event)) return
              if (searching && event.key === 'Escape') { event.preventDefault(); changeMode('ask') }
              if (event.key === 'Enter' && !event.nativeEvent.isComposing &&
                (searching || !event.shiftKey || event.metaKey || event.ctrlKey)) void submit(event)
            }} rows={searching ? 1 : 2} />
          <div className="composer-actions">
            {searchWeb && <Button type="button" variant="ghost" size="sm" title={searching ? 'Switch to Ask' : 'Switch to Web search'}
              aria-label={searching ? 'Switch to Ask' : 'Switch to Web search'} className="composer-mode"
              onClick={() => changeMode(searching ? 'ask' : 'web')}>
              {searching ? <Globe /> : <MessageSquare />}{searching ? 'Web' : 'Ask'}
            </Button>}
            {searching ? <><span className="composer-spacer" /><Button className="composer-send" size="icon-sm" variant="secondary"
              type="submit" aria-label="Search the web" disabled={!searchDraft.trim()}><ArrowUp /></Button></> : <>
            <Button type="button" variant="ghost" size="icon-sm" className="composer-attach" aria-label="Attach files" title="Attach files" disabled={starting || capturing || (session?.readOnly && busy)} onClick={attachFiles}><Plus /></Button>
            {isPi && workspace.root && !catalog.loading && !catalog.error && !catalog.models.length
              ? <Button type="button" size="sm" variant="ghost" className="composer-model" onClick={openIntegrations}>Connect a model</Button>
              : <ModelPicker models={catalog.models} value={canSend ? model : ''} label="Model" className="composer-model" harnessName={harnessName}
                onValueChange={(id) => setChosenModel({ id, harness, cwd })}
                loading={catalog.loading} disabled={starting || busy || session?.readOnly} />}
            <span className="composer-spacer" />
            {session?.readOnly ? <small>Read-only</small> : (
              <div className="composer-permissions" role="group" aria-label="Tool permissions">
                <Shield size={14} aria-hidden="true" />
                <Button type="button" size="sm" variant="ghost" disabled={starting || busy} aria-pressed={permission === 'auto'}
                  title="Run commands and edits automatically" onClick={() => setChosenPermission({ harness, value: 'auto' })}>Auto</Button>
                <Button type="button" size="sm" variant="ghost" disabled={starting || busy} aria-pressed={permission === 'ask'}
                  title="Ask before running commands or editing files" onClick={() => setChosenPermission({ harness, value: 'ask' })}>Ask</Button>
              </div>
            )}
            {willQueue && hasDraft && <Button size="sm" variant="ghost" type="submit" aria-label="Queue message"
              disabled={starting || capturing || !canSend}><ListPlus /> Queue</Button>}
            {busy && <Button className="composer-send" size="icon-sm" variant="secondary" type="button" aria-label="Stop agent" onClick={() => api.stop(sessionId).catch(setError)}><Square /></Button>}
            {!busy && !willQueue && <Button className="composer-send" size="icon-sm" variant="secondary" type="submit"
              aria-label="Send message" disabled={!hasDraft || starting || capturing || !canSend}><ArrowUp /></Button>}
            </>}
          </div>
        </form>
      </div>
    </div>
  )
}
