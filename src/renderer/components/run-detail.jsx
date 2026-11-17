import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ErrorNotice, formatDate, Page } from '@/components/workbench-ui'
import { harnessNames } from '@/lib/harnesses'
import { runStatuses } from '@/lib/run-activity'

const api = window.workbench
const triggers = { chat: 'Chat', delegated: 'Parallel session', automation: 'Manual automation', scheduled: 'Scheduled automation', retry: 'Fresh retry' }

export function RunDetail({ id, summary, active, openTarget, openSource }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (!active) return
    let current = true
    api.runRecord(id).then((value) => { if (current) setDetail(value) })
      .catch((err) => { if (current) setError(err) })
    return () => { current = false }
  }, [id, active, summary])
  const run = summary ? { ...detail, ...summary } : detail
  if (!run) return <Page title="Run"><ErrorNotice error={error} /></Page>
  const chat = { type: 'session', id: run.sessionId }
  const fields = [
    ['Status', runStatuses[run.status] ?? run.status],
    ['Trigger', triggers[run.trigger] ?? run.trigger],
    ['Workspace', run.workspace],
    ['Starting revision', run.startingRevision?.slice(0, 12)],
    ['Target branch', run.startingRevision && (run.targetBranch || 'Detached HEAD')],
    ['Project check', run.checkOutcome === 'passed' ? 'Passed' : run.checkOutcome === 'failed' ? 'Failed' : undefined],
    ['Requested harness', harnessNames[run.requestedHarness] ?? run.requestedHarness],
    ['Requested model', run.requestedModel],
    ['Actual harness', harnessNames[run.actualHarness] ?? run.actualHarness],
    ['Actual model', run.actualModel],
    ['Provider', run.provider],
    ['Routing', run.routing === 'fallback' ? 'No eligible matching rule. Used an available model.' : run.routing && 'Matched local rule · ' + run.routing],
    ['Queued', run.createdAt && formatDate(run.createdAt)],
    ['Started', run.startedAt && formatDate(run.startedAt)],
    ['Finished', run.finishedAt && formatDate(run.finishedAt)],
    ['Reported usage', run.usage?.total !== undefined ? run.usage.total.toLocaleString() + ' tokens'
      : run.usage?.input !== undefined || run.usage?.output !== undefined
        ? (run.usage.input ?? 0).toLocaleString() + ' input · ' + (run.usage.output ?? 0).toLocaleString() + ' output' : undefined],
    ['Local cost estimate', run.usage?.costUsd !== undefined && '$' + run.usage.costUsd.toFixed(4)],
  ].filter(([, value]) => value)
  async function invoke(operation) {
    setPending(true)
    setError(null)
    try { await operation() } catch (err) { setError(err) } finally { setPending(false) }
  }
  return <Page title={run.title} description="Run details" actions={<>
    {run.reviewId && <Button variant="secondary" size="sm" onClick={() => openTarget({ type: 'review', id: run.reviewId })}>Review changes</Button>}
    {run.attentionTarget?.type === 'inbox' && <Button variant="secondary" size="sm"
      onClick={() => openTarget(run.attentionTarget)}>Review mailbox connection</Button>}
    <Button variant="outline" size="sm" onClick={() => openTarget(chat)}>Open chat</Button>
  </>}>
    <div className="run-detail">
      <ErrorNotice error={error} />
      {run.error && <p className="work-error">{run.error}</p>}
      {run.reviewError && <p className="work-error">Change recording · {run.reviewError}</p>}
      <dl className="run-facts">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {run.status === 'needs-attention' && run.approvals?.length > 0 &&
        <section className="surface-panel"><h2>Approvals to review</h2>
          <ul>{run.approvals.map((item) => <li key={item.id}>{item.tool}{item.target && ' · ' + item.target}</li>)}</ul>
          <Button variant="outline" size="sm" onClick={() => openTarget(chat)}>Review in chat</Button>
        </section>}
      {run.lastStep && <section className="surface-panel"><h2>Last completed step</h2>
        <p>{run.lastStep.label}</p>
        <Button size="sm" variant="ghost" onClick={() => openTarget(run.lastStep.path ? { type: 'file', path: run.lastStep.path }
          : { ...chat, messageId: run.lastStep.id })}>Open step</Button>
      </section>}
      {run.output && <section className="surface-panel"><h2>Result</h2><p>{run.output.excerpt}</p>
        <Button size="sm" variant="ghost" onClick={() => openTarget({ ...chat, messageId: run.output.id })}>Open result in chat</Button>
      </section>}
      {run.files?.length > 0 && <section className="surface-panel"><h2>Changed files</h2>
        {run.files.map((path) => <Button key={path} size="sm" variant="ghost" onClick={() => openTarget({ type: 'file', path })}>{path}</Button>)}
      </section>}
      {detail?.excerpts?.length > 0 && <section className="surface-panel"><h2>Source excerpts supplied to this run</h2>
        {detail.excerpts.map((item, index) => <details key={index}>
          <summary>{item.source?.name ?? 'Attachment ' + (index + 1)}</summary>
          <pre>{item.text}</pre>
          {item.source && <Button size="sm" variant="ghost" onClick={() => openSource(item.source)}>Open source</Button>}
        </details>)}
      </section>}
      {run.status === 'queued' && run.recovered && <section className="surface-panel">
        <h2>Resume queued work</h2><p>This run was saved before execution began.</p>
        <Button size="sm" onClick={() => invoke(async () => { await api.resumeQueue(run.sessionId); openTarget(chat) })} disabled={pending}>Resume queue</Button>
      </section>}
      {['failed', 'interrupted'].includes(run.status) && !run.retriedAs && <section className="surface-panel">
        <h2>{run.automationId ? 'Review the automation' : 'Start a fresh retry'}</h2>
        <p>Check the previous result first. An external action may have completed before the run stopped.</p>
        <Button size="sm" variant="outline" disabled={pending} onClick={run.automationId
          ? () => openTarget({ type: 'automation', id: run.automationId })
          : () => invoke(async () => { const next = await api.retryRun(run.id); openTarget({ type: 'run', id: next.id, title: next.title }) })}>
          {run.automationId ? 'Open automation' : 'Start fresh retry'}
        </Button>
      </section>}
      {run.retriedAs && <Button variant="outline" size="sm" onClick={() => openTarget({ type: 'run', id: run.retriedAs })}>Open retry</Button>}
    </div>
  </Page>
}
