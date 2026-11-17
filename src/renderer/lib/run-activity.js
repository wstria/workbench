export const runStatuses = {
  queued: 'Queued', working: 'Working', 'needs-attention': 'Needs attention',
  done: 'Done', failed: 'Failed', interrupted: 'Interrupted', canceled: 'Canceled',
}

export function runActivity(run, direct = false) {
  const approvals = run.status === 'needs-attention' ? run.approvals?.length : 0
  const description = approvals ? (approvals === 1 ? 'One approval to review' : approvals + ' approvals to review')
    : run.status === 'queued' && run.recovered ? 'Ready to resume'
      : run.checkOutcome === 'failed' ? 'Project checks failed'
        : run.error || run.output?.excerpt || run.lastStep?.label || ''
  return {
    id: run.id, title: run.title, description, status: run.status,
    kind: run.automationId ? 'automation' : 'session', workspace: run.workspace,
    harness: run.actualHarness ?? run.requestedHarness, at: run.finishedAt ?? run.startedAt ?? run.createdAt,
    target: direct && approvals ? { type: 'session', id: run.sessionId } : { type: 'run', id: run.id },
  }
}

export function attentionActivity(data, live) {
  const runs = data.runs ?? []
  const reviewQueue = (data.reviews ?? []).filter((review) => ['pending', 'interrupted'].includes(review.status))
  const reviewIds = new Set(reviewQueue.map((review) => review.id))
  const latestAutomations = new Map(data.automations.map((task) => [task.id, task.lastRunId]))
  const needsRun = runs.filter((run) => {
    const activeFailure = ['failed', 'interrupted'].includes(run.status) && !run.retriedAs &&
      (!run.automationId || latestAutomations.get(run.automationId) === run.id)
    return run.status === 'needs-attention' || activeFailure || run.status === 'queued' && run.recovered ||
      run.checkOutcome === 'failed' && !reviewIds.has(run.reviewId)
  }).map((run) =>
    run.checkOutcome === 'failed' && run.reviewId
      ? { ...runActivity(run), status: 'needs-attention', target: { type: 'review', id: run.reviewId } }
      : runActivity(run, true))
  const attentionSessions = new Set(runs.filter((run) => run.status === 'needs-attention').map((run) => run.sessionId))
  const legacySessions = data.sessions.filter((item) => live[item.id] && !attentionSessions.has(item.id)).map((item) => ({
    id: item.id, title: item.title, description: 'Approval to review', at: item.createdAt, kind: 'session', workspace: item.cwd,
    status: 'needs-attention', harness: item.harness, target: { type: 'session', id: item.id },
  }))
  const reviews = reviewQueue.map((item) => ({
    id: 'review:' + item.id, title: item.title || 'Review changes',
    description: item.status === 'interrupted' ? 'Apply or undo was interrupted. Inspect the checkout.' : item.summary,
    at: item.updatedAt ?? item.createdAt ?? item.at, kind: 'review', status: 'needs-attention', workspace: item.workspace ?? item.cwd,
    harness: item.harness,
    target: { type: 'review', id: item.id, sessionId: item.sessionId },
  }))
  const handoffs = (data.computers ?? []).filter((item) => item.handoff).map((item) => ({
    id: 'computer:' + item.id, title: item.name, description: item.handoff.reason,
    at: item.handoff.at, kind: 'computer', status: 'needs-attention', target: { type: 'computer', id: item.id },
  }))
  const legacyAutomations = data.automations.filter((item) => item.lastFailure && !item.lastRunId).map((item) => ({
    id: 'automation:' + item.id, title: item.name, description: item.lastFailure, at: item.lastRunAt,
    kind: 'automation', status: 'failed', workspace: item.cwd, target: { type: 'automation', id: item.id },
  }))
  const memory = (data.memoryProposals ?? []).map((item) => ({
    id: item.id, title: 'Review memory: ' + item.title, at: item.createdAt ?? item.at, kind: 'memory',
    status: 'needs-attention', target: { type: 'memory' },
  }))
  return [...needsRun, ...reviews, ...handoffs, ...legacySessions, ...legacyAutomations, ...memory]
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
}
