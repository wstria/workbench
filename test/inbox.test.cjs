const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createStore } = require('../src/main/store');
const { createInbox } = require('../src/main/inbox');
const { createAutomation } = require('../src/main/automation');
const { createRunJournal } = require('../src/main/run-journal');
const { createTurnQueue } = require('../src/main/turn-queue');

const { fixture, safeStorage, token, renewed } = require('./fixtures/inbox.cjs');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-inbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return createStore(root, () => {});
}

test('read-only mailbox triage links originals, deduplicates threads, and keeps review drafts local', async (t) => {
  const store = workspace(t);
  const server = fixture();
  const options = { store, safeStorage, request: server.request };
  const inbox = createInbox(options);
  const connected = await inbox.connect(token);
  assert.equal(connected.status, 'connected');
  assert.equal(connected.account, 'me@example.test');
  assert.equal(connected.credential, undefined);
  assert.equal(connected.threads.length, 3);
  assert.equal(connected.threads[0].id, 'T2');
  assert.match(connected.threads[1].url, /search:msgid:board%2Bpacket%40example.test$/);
  const result = await inbox.triage();
  assert.deepEqual(result.counts, { urgent: 1, unread: 1, routine: 1 });
  assert.equal(result.drafts.length, 2);
  assert.match(result.drafts.find((item) => item.threadId === 'T2').text, /follow up by/);
  const callCount = server.calls.length;
  inbox.saveDraft('T2', 'The figures are attached to my original note.');
  assert.equal(server.calls.length, callCount);
  const file = path.join(store.root, 'inbox.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(token));
  const reopened = createInbox(options);
  assert.equal((await reopened.triage()).drafts.find((item) => item.threadId === 'T2').text, 'The figures are attached to my original note.');
  assert.ok(server.calls.flatMap((call) => call.methods ?? []).every((method) =>
    ['Mailbox/get', 'Email/query', 'Email/get'].includes(method)));
  assert.ok(store.data.activity.some((item) => item.target?.type === 'inbox'));
});

test('revocation, unavailable provider and unsafe API addresses fail without losing local drafts', async (t) => {
  const store = workspace(t);
  const server = fixture();
  const inbox = createInbox({ store, safeStorage, request: server.request });
  await inbox.connect(token);
  await inbox.triage();
  server.revoke();
  await assert.rejects(inbox.refresh(), /expired or was revoked/);
  assert.equal(inbox.list().status, 'reauthenticate');
  assert.equal(inbox.list().drafts.length, 2);
  await inbox.connect(renewed);
  assert.equal(inbox.list().status, 'connected');
  server.setOffline(true);
  await assert.rejects(inbox.refresh(), /Could not reach Fastmail/);
  assert.equal(inbox.list().status, 'unavailable');
  server.setOffline(false);
  server.setAddress('https://api.fastmail.com.attacker.invalid/jmap/api/');
  const callCount = server.calls.length;
  await assert.rejects(inbox.refresh(), /unexpected API address/);
  assert.equal(server.calls.length, callCount + 1);
  assert.equal(inbox.disconnect().status, 'disconnected');
  assert.deepEqual(inbox.list().drafts, []);
  assert.ok(!fs.existsSync(path.join(store.root, 'inbox.json')));
});

test('scheduled Inbox briefing carries scoped evidence and fails before the agent when access expires', async (t) => {
  const store = workspace(t);
  const fixtureMailbox = fixture();
  const inbox = createInbox({ store, safeStorage, request: fixtureMailbox.request });
  await inbox.connect(token);
  const runs = createRunJournal({ store });
  let automations;
  const recorded = [];
  const completed = [];
  const agent = {
    transcript: () => ({ entries: [], approvals: [] }),
    async run(id, text, options) { recorded.push({ id, text, options }); },
  };
  let now = Date.now();
  const turns = createTurnQueue({ store, runs, agentFor: () => agent, send() {},
    beforeRun: (...args) => automations.prepare(...args),
    onFinish(run) { automations.finish(run); completed.push(run); },
  });
  automations = createAutomation(store, turns, { runs, inbox, now: () => now, interval: 0 });
  t.after(() => { turns.close(); automations.dispose(); });
  const input = { name: 'Fixture Inbox briefing', prompt: 'Prepare a briefing', frequency: 'daily', time: '09:00', weekday: 1, tools: ['read'] };
  const task = automations.save({ ...input, includeInbox: true });
  now = task.nextRunAt;
  automations.tick();
  await until(() => completed.length === 1);
  assert.equal(completed[0].status, 'done');
  assert.equal(completed[0].trigger, 'scheduled');
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].options.tools, ['read']);
  assert.match(recorded[0].options.context[0].text, /untrusted source data/);
  assert.match(recorded[0].options.context[0].text, /urgent%40example.test/);
  assert.equal(inbox.list().drafts.length, 2);
  fixtureMailbox.revoke();
  now = task.nextRunAt;
  automations.tick();
  await until(() => completed.length === 2);
  assert.equal(recorded.length, 1);
  assert.equal(completed[1].status, 'failed');
  assert.deepEqual(completed[1].attentionTarget, { type: 'inbox' });
  assert.match(task.lastFailure, /expired or was revoked/);
  const ordinary = automations.save({ ...input, name: 'Without mailbox access' });
  const callCount = fixtureMailbox.calls.length;
  automations.run(ordinary.id);
  await until(() => completed.length === 3);
  assert.equal(fixtureMailbox.calls.length, callCount);
  assert.deepEqual(recorded[1].options.context, []);
});

async function until(condition) {
  for (let attempt = 0; attempt < 70; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  assert.fail('Scheduled briefing did not settle.');
}
