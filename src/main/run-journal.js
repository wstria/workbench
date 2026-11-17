const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicWrite } = require('./store');
const { redact } = require('./agent-common');

const runFile = /^([a-f0-9-]{36})\.json$/;
const inFlight = new Set(['working', 'needs-attention']);
const titleSize = 120;
const lineSize = 400;

function clipped(value, limit = lineSize) {
  return redact(typeof value === 'string' ? value : '').trim().slice(0, limit);
}

function createRunJournal({ store, now = Date.now }) {
  const folder = path.join(store.root, 'runs');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const records = new Map();
  const occurrences = new Map();
  const retries = new Map();
  let sequence = 0;

  function commit(record, notify = true) {
    const content = JSON.stringify(record);
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('This run contains too much context to save.');
    atomicWrite(path.join(folder, record.id + '.json'), content);
    records.set(record.id, record);
    if (record.occurrence) occurrences.set(record.occurrence, record.id);
    if (record.retryOf) retries.set(record.retryOf, record.id);
    if (notify) store.scheduleUpdate();
    return record;
  }

  for (const file of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!file.isFile() || !runFile.test(file.name)) continue;
    const record = JSON.parse(fs.readFileSync(path.join(folder, file.name), 'utf8'));
    if (record.id + '.json' !== file.name) continue;
    records.set(record.id, record);
    sequence = Math.max(sequence, record.sequence ?? 0);
    if (record.occurrence) occurrences.set(record.occurrence, record.id);
    if (record.retryOf) retries.set(record.retryOf, record.id);
    if (record.status === 'queued') commit({ ...record, recovered: true }, false);
    if (inFlight.has(record.status)) commit({ ...record, status: 'interrupted', approvals: [], finishedAt: now(),
      error: 'Workbench closed before this run finished. Open the chat and check whether its last action completed.' }, false);
  }

  function get(id) { return records.get(id); }
  function create(chat, message, meta = {}) {
    if (meta.occurrence && occurrences.has(meta.occurrence)) throw new Error('This scheduled occurrence already has a run.');
    if (meta.retryOf && retries.has(meta.retryOf)) throw new Error('A retry for this run already exists.');
    const title = meta.title || (chat.title === 'New session' ? message.text.split('\n')[0] : chat.title) || 'Agent turn';
    return commit({
      id: message.id, sessionId: chat.id, workspace: chat.cwd, title: clipped(title, titleSize),
      trigger: meta.trigger ?? (chat.parentId ? 'delegated' : 'chat'),
      automationId: meta.automationId, occurrence: meta.occurrence, scheduledAt: meta.scheduledAt, retryOf: meta.retryOf,
      computerId: chat.computerId, status: 'queued', createdAt: now(), requestedHarness: chat.harness ?? 'pi',
      sequence: ++sequence, requestedModel: message.options.model, payload: { text: message.text, options: message.options },
    });
  }

  function annotate(id, data) {
    const previous = get(id);
    if (!previous || Object.entries(data).every(([key, value]) => JSON.stringify(previous[key]) === JSON.stringify(value))) return previous;
    return commit({ ...previous, ...data });
  }

  function start(id, entryCount, extra = {}) {
    return annotate(id, { status: 'working', startedAt: now(), entryCount, error: undefined, ...extra });
  }

  function observe(id, event, initialCount) {
    const run = get(id);
    if (!run || !inFlight.has(run.status)) return;
    const approvals = (event.approvals ?? []).map(({ id, tool, target }) => ({ id, tool: clipped(tool, 80), target: clipped(target) }));
    const entries = event.entries?.slice(initialCount) ?? [];
    let entry;
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i];
      if ((candidate.type === 'tool' && candidate.status === 'done') ||
          (candidate.type === 'assistant' && (!event.busy || i < entries.length - 1))) {
        entry = candidate;
        break;
      }
    }
    const lastStep = entry ? {
      id: entry.id, type: entry.type, label: clipped(entry.type === 'tool' ? entry.title || entry.tool : entry.text),
      path: typeof entry.path === 'string' ? entry.path : undefined,
    } : run.lastStep;
    return annotate(id, { approvals, lastStep, status: approvals.length ? 'needs-attention' : 'working' });
  }

  function finish(id, status, { error, result, event, entryCount = 0, ...extra } = {}) {
    const run = get(id);
    if (!run || !inFlight.has(run.status) && run.status !== 'queued') return run;
    if (event) observe(id, event, entryCount);
    const entries = event?.entries?.slice(entryCount) ?? [];
    const lastReply = entries.findLast((entry) => entry.type === 'assistant' && entry.text);
    const files = [...new Set(entries.filter((entry) => typeof entry.path === 'string' && ['edit', 'write'].includes(entry.tool))
      .map(({ path }) => path))].slice(0, 50);
    const spent = Object.fromEntries(['input', 'output', 'total', 'costUsd'].filter((key) =>
      typeof result?.usage?.[key] === 'number' && Number.isFinite(result.usage[key])).map((key) => [key, result.usage[key]]));
    return annotate(id, {
      status, finishedAt: now(), error: error ? clipped(error, 700) : undefined, approvals: [],
      output: lastReply ? { id: lastReply.id, excerpt: clipped(lastReply.text, 700) } : undefined,
      files: files.length ? files : undefined, usage: Object.keys(spent).length ? spent : undefined,
      ...(status !== 'failed' && status !== 'interrupted' && { payload: undefined }), ...extra,
    });
  }

  function publicRecord({ payload, entryCount, sequence, excerpts, ...run }) {
    return { ...run, retriedAs: retries.get(run.id) ?? run.retriedAs };
  }
  function list() {
    return [...records.values()].sort((a, b) => (b.finishedAt ?? b.startedAt ?? b.createdAt) - (a.finishedAt ?? a.startedAt ?? a.createdAt))
      .slice(0, 500).map(publicRecord);
  }

  return {
    get, create, start, annotate, observe, finish, list,
    read(id) {
      const record = get(id);
      if (!record) throw new Error('Run not found.');
      return { ...publicRecord(record), excerpts: record.excerpts };
    },
    queued: () => [...records.values()].filter((item) => item.status === 'queued' && item.payload),
    activeAutomation: (id) => [...records.values()].some((record) => record.automationId === id && (record.status === 'queued' || inFlight.has(record.status))),
    findOccurrence: (key) => occurrences.get(key),
  };
}

module.exports = { createRunJournal };
