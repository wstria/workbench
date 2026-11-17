import assert from 'node:assert/strict'
import test from 'node:test'
import { diffLines, groupTranscript, toolActivity } from '../src/renderer/lib/transcript-activity.mjs'

test('groups only adjacent finished tools and preserves messages, active tools, diffs and session links', () => {
  const a = { id: 'a', type: 'assistant', text: 'Reading the workspace.' }
  const b = { id: 'b', type: 'tool', tool: 'read', status: 'done' }
  const c = { id: 'c', type: 'tool', tool: 'bash', status: 'done' }
  const d = { id: 'd', type: 'tool', tool: 'edit', status: 'done', diff: '-before\n+after' }
  const e = { id: 'e', type: 'tool', tool: 'workbench_team', status: 'done', sessionLink: { id: 'worker' } }
  const f = { id: 'f', type: 'assistant', text: 'The change is in place.' }
  const g = { id: 'g', type: 'tool', tool: 'bash', status: 'running' }
  const h = { id: 'h', type: 'tool', tool: 'bash', status: 'failed' }
  const approval = { id: 'approval', type: 'status', approval: 'allowed', text: 'Allowed bash · ls' }
  const denial = { id: 'denial', type: 'status', approval: 'denied', text: 'Denied bash · ls' }
  assert.deepEqual(groupTranscript([a, b, c, approval, d, e, f, g, denial, h]), [a, { id: 'b', type: 'tool-group', tools: [b, c] }, d, e, f, g, denial, h])
  assert.equal(toolActivity(g).label, 'Running')
  assert.equal(toolActivity({ tool: 'web_search', title: 'widgets' }).label, 'Searched the web for')
})

test('reads numbering in Pi and unified diffs without treating adjacent headers as changed lines', () => {
  assert.deepEqual(diffLines('  1 unchanged\n- 2 before\n+ 2 after\n'), [
    { text: 'unchanged', number: 1, change: undefined },
    { text: 'before', number: 2, change: 'remove' },
    { text: 'after', number: 2, change: 'add' },
  ])
  const rows = diffLines('--- a/file\n+++ b/file\n@@ -7,2 +10,2 @@\n keep\n-before\n+after\n--- a/other\n+++ b/other\n@@ -0,0 +1 @@\n+new file\n')
  assert.deepEqual(rows.filter((line) => line.number), [
    { text: 'keep', number: 10 },
    { text: 'before', number: 8, change: 'remove' },
    { text: 'after', number: 11, change: 'add' },
    { text: 'new file', number: 1, change: 'add' },
  ])
})
