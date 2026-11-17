const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('../src/main/store.js');
const { createRunJournal } = require('../src/main/run-journal.js');
const { createTurnQueue } = require('../src/main/turn-queue.js');
const { createAutomation } = require('../src/main/automation.js');

const [folder, mode] = process.argv.slice(2);
let time = new Date(2026, 10, 17, 8, 59).getTime();
const store = createStore(folder, () => {});
const runs = createRunJournal({ store, now: () => time });
const agent = {
  transcript: (id) => ({ entries: store.transcript(id), busy: false, approvals: [] }),
  stop: () => {},
  async run(id, prompt, options) {
    options.reportRun({ actualHarness: 'pi', actualModel: 'fixture-small', provider: 'Fixture', routing: 'fallback' });
    fs.appendFileSync(path.join(folder, 'external-actions.jsonl'), JSON.stringify({ runId: options.runId, prompt }) + '\n');
    const entries = [{ id: 'file-received', type: 'tool', tool: 'fixture', title: 'Fixture received the action', status: 'done' }];
    store.saveTranscript(id, entries);
    turns.publish(id, { entries, busy: true, approvals: [] });
    process.send({ type: 'acted', id, runId: options.runId, prompt });
    await new Promise(() => {});
  },
};
const turns = createTurnQueue({ store, runs, agentFor: () => agent, send: () => {} });
const automations = createAutomation(store, turns, { runs, now: () => time, interval: 0 });
if (mode === 'scheduled') {
  const task = automations.save({ name: 'Fixture briefing', prompt: 'Scheduled action', frequency: 'daily', time: '09:00', weekday: 2 });
  process.send({ type: 'scheduled', id: task.id, at: task.nextRunAt });
  time = task.nextRunAt + 1;
  automations.tick();
} else {
  const chat = store.addSession(store.data.cwd, 'Crash fixture');
  const first = turns.submit(chat.id, 'First action');
  const second = turns.submit(chat.id, 'Second action');
  process.send({ type: 'queued', first: first.id, second: second.id });
}
