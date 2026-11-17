const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { createStore } = require('../src/main/store.js');
const { createRunJournal } = require('../src/main/run-journal.js');
const { createTurnQueue } = require('../src/main/turn-queue.js');
const { createAutomation } = require('../src/main/automation.js');

function work(t) {
  const cleanup = [];
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-runs-'));
  t.after(() => {
    try { cleanup.forEach((callback) => callback()); }
    finally { fs.rmSync(folder, { recursive: true, force: true }); }
  });
  return { folder, cleanup };
}

async function crashAtAction(t, folder, mode) {
  const child = fork(path.join(__dirname, '../fixtures/interrupted-run.cjs'), [folder, mode], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  const messages = {};
  const exit = once(child, 'exit');
  child.on('message', (row) => {
    messages[row.type] = row;
    if (row.type === 'acted') child.kill('SIGKILL');
  });
  const [, signal] = await exit;
  assert.equal(signal, 'SIGKILL');
  assert.ok(messages.acted, 'Expected the fixture to acknowledge an effect before killing the process');
  return messages;
}

function actions(folder) {
  return fs.readFileSync(path.join(folder, 'external-actions.jsonl'), 'utf8').trim().split('\n').map((value) => JSON.parse(value));
}

function open(folder, config = {}) {
  const store = createStore(folder, () => {});
  const runs = createRunJournal({ store, now: config.now });
  const completed = [];
  const agent = {
    transcript: (id) => ({ entries: store.transcript(id), busy: false, approvals: [] }),
    stop() {},
    async run(id, prompt, options) {
      const entries = store.transcript(id);
      const sentence = { id: 'new-' + options.runId, type: 'assistant', text: 'Result: ' + prompt };
      store.saveTranscript(id, [...entries, sentence]);
      fs.appendFileSync(path.join(folder, 'external-actions.jsonl'), JSON.stringify({ runId: options.runId, prompt }) + '\n');
      return { usage: { total: 42 } };
    },
  };
  const turns = createTurnQueue({ store, runs, agentFor: () => agent, send: () => {},
    onFinish(run) { completed.push(run.id); config.onFinish?.(run); },
  });
  return { store, runs, turns, completed };
}

async function until(ready) {
  for (let i = 0; i < 75; i++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  assert.fail('Run did not settle');
}

test('actual process crash retains queued work and never replays an in-flight action', { timeout: 15000 }, async (t) => {
  const { folder, cleanup } = work(t);
  const { acted, queued } = await crashAtAction(t, folder, 'queue');
  const { runs, turns, completed, store } = open(folder);
  cleanup.push(() => { turns.close(); store.flush(); });
  assert.equal(runs.read(queued.first).status, 'interrupted');
  assert.equal(runs.read(queued.first).actualModel, 'fixture-small');
  assert.equal(runs.read(queued.first).lastStep.label, 'Fixture received the action');
  assert.equal(runs.read(queued.second).status, 'queued');
  assert.equal(turns.snapshot(acted.id).paused, true);
  assert.deepEqual(turns.snapshot(acted.id).queue.map(({ id }) => id), [queued.second]);
  assert.deepEqual(actions(folder).map(({ prompt }) => prompt), ['First action']);
  turns.resume(acted.id);
  await until(() => completed.includes(queued.second));
  assert.equal(runs.read(queued.second).output.excerpt, 'Result: Second action');
  assert.equal(runs.read(queued.second).usage.total, 42);
  assert.deepEqual(actions(folder).map(({ prompt }) => prompt), ['First action', 'Second action']);
  assert.ok(!('payload' in runs.read(queued.first)), 'Run details should not expose retry payloads');
});

test('scheduled occurrence is claimed once across a crash even with a stale next-run pointer', { timeout: 15000 }, async (t) => {
  const { folder, cleanup } = work(t);
  const { acted, scheduled } = await crashAtAction(t, folder, 'scheduled');
  let automations;
  const now = () => scheduled.at + 5000;
  const { store, runs, turns } = open(folder, { now, onFinish: (run) => automations.finish(run) });
  automations = createAutomation(store, turns, { runs, now, interval: 0 });
  cleanup.push(() => { automations.dispose(); turns.close(); store.flush(); });
  const task = store.data.automations.find((item) => item.id === scheduled.id);
  assert.equal(runs.read(acted.runId).status, 'interrupted');
  assert.equal(runs.read(acted.runId).scheduledAt, scheduled.at);
  assert.ok(task.nextRunAt > now());
  task.nextRunAt = scheduled.at;
  store.update();
  automations.tick();
  assert.ok(task.nextRunAt > now());
  assert.equal(runs.list().length, 1);
  assert.deepEqual(actions(folder), [{ runId: acted.runId, prompt: 'Scheduled action' }]);
  assert.throws(() => turns.retry(acted.runId), /manual run/);
  const followUp = automations.run(task.id);
  await until(() => runs.list().find((item) => item.sessionId === followUp.id)?.status === 'done');
  assert.deepEqual(actions(folder).map(({ prompt }) => prompt), ['Scheduled action', 'Scheduled action']);
  assert.notEqual(task.lastRunId, acted.runId);
});
