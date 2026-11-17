const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { redact } = require('./agent-common');
const { createRunJournal } = require('./run-journal');
const { validateSelection } = require('./attachments');

function createTurnQueue({ store, runs = createRunJournal({ store }), agentFor, send, restoreAttachments, assertAttachments, beforeRun, onFinish }) {
  const queues = new Map();
  let closed = false;

  for (const run of runs.queued()) {
    if (!store.data.sessions.some((item) => item.id === run.sessionId)) continue;
    const state = queues.get(run.sessionId) ?? { items: [], running: false, paused: true };
    state.items.push({ id: run.id, ...run.payload, restored: true });
    queues.set(run.sessionId, state);
  }
  for (const state of queues.values()) state.items.sort((a, b) => runs.get(a.id).createdAt - runs.get(b.id).createdAt || runs.get(a.id).sequence - runs.get(b.id).sequence);

  function snapshot(id, event = agentFor(id).transcript(id)) {
    const state = queues.get(id);
    return { ...event, id, runId: state?.current?.id, busy: Boolean(state?.running || event.busy),
      startedAt: state?.running ? state.startedAt : undefined,
      canSteer: Boolean(event.canSteer && state?.running && !state.paused),
      queue: state?.items.map(({ id, text, options }) => ({ id, text,
        attachments: [...options.attachments.map((file) => redact(path.basename(file))),
          ...options.context.map((item) => redact(item.name))] })) ?? [],
      paused: Boolean(state?.paused), steering: state?.steering?.id ?? null, queueError: state?.error ?? null };
  }

  function publish(id, event) {
    if (closed) return;
    const state = queues.get(id);
    if (event && state?.current) runs.observe(state.current.id, event, state.entryCount);
    send(snapshot(id, event));
  }

  function settle(id, status, detail) {
    const run = runs.finish(id, status, detail);
    if (run) onFinish?.(run);
  }

  async function drain(id, state) {
    if (state.running || state.paused || closed) return;
    state.running = true;
    try {
      while (state.items.length && !state.paused && !closed) {
        const message = state.items[0];
        const agent = agentFor(id);
        const controller = new AbortController();
        state.entryCount = agent.transcript(id).entries?.length ?? 0;
        runs.start(message.id, state.entryCount);
        state.items.shift();
        state.current = message;
        state.controller = controller;
        state.startedAt = Date.now();
        publish(id);
        try {
          if (message.restored) await restoreAttachments?.(message.options.attachments);
          const preparation = await beforeRun?.(runs.get(message.id), message.options, controller.signal);
          if (closed) break;
          controller.signal.throwIfAborted();
          const result = await agent.run(id, message.text, { ...message.options, ...preparation, signal: controller.signal, runId: message.id,
            reportRun: (info) => runs.annotate(message.id, info) });
          if (closed) break;
          if (result?.skipped && !controller.signal.aborted) {
            runs.annotate(message.id, { status: 'queued', startedAt: undefined });
            state.items.unshift(message);
            state.paused = true;
            break;
          }
          settle(message.id, controller.signal.aborted || result?.cancelled ? 'interrupted' : result?.failure ? 'failed' : 'done',
            { error: result?.failure, result, event: agent.transcript(id), entryCount: state.entryCount });
          if (result?.failure) state.paused = true;
        } catch (error) {
          if (!closed) settle(message.id, controller.signal.aborted ? 'interrupted' : 'failed', { error: error.message, event: agent.transcript(id), entryCount: state.entryCount });
          state.error = redact(error.message);
          state.paused = true;
        } finally {
          await state.steering?.promise.catch(() => {});
          state.current = null;
          state.controller = null;
        }
      }
    } catch (error) {
      state.paused = true;
      state.error = redact(error.message);
    } finally {
      state.running = false;
      if (!state.items.length) queues.delete(id);
      if (!closed) publish(id);
    }
  }

  function submit(id, input, options = {}, meta = {}) {
    if (closed) throw new Error('Workbench is closing.');
    const chat = store.session(id);
    const text = redact(input).trim();
    const { model, permission, attachments = [], context = [], tools, integrations, separateCopy } = options;
    validateSelection(attachments, context);
    if (!meta.retryOf) assertAttachments?.(attachments);
    if ((!text && !attachments.length && !context.length) || text.length > 50000) {
      throw new Error('Enter a message of up to 50,000 characters or select context.');
    }
    const state = queues.get(id) ?? { items: [], running: false, paused: Boolean(meta.defer) };
    if (chat.readOnly && (state.running || state.items.length)) throw new Error('This automation is already running.');
    if (state.items.length >= 20) throw new Error('Remove a message before adding more than 20 to the queue.');
    const safeContext = context.map((item) => ({ ...item, name: redact(item.name), text: redact(item.text) }));
    const message = { id: randomUUID(), text, options: {
      model: model ?? chat.model ?? (chat.harness === 'pi' ? store.data.model : store.data.harnessDefaults?.[chat.harness]?.model),
      permission, attachments, context: safeContext, tools, integrations: integrations ?? (chat.readOnly ? [] : undefined), separateCopy,
      includeInbox: Boolean(meta.automationId && options.includeInbox === true),
    }, restored: Boolean(meta.retryOf) };
    runs.create(chat, message, meta);
    state.items.push(message);
    queues.set(id, state);
    if (state.running || state.paused) publish(id);
    else void drain(id, state);
    return runs.read(message.id);
  }

  async function steer(id, messageId) {
    const state = queues.get(id);
    const message = state?.items.find((item) => item.id === messageId);
    if (!message || state.steering || !snapshot(id).canSteer) return;
    if (message.restored) await restoreAttachments?.(message.options.attachments);
    const parent = state.current?.id;
    runs.start(messageId, state.entryCount, { handledBy: parent });
    state.error = null;
    const promise = agentFor(id).steer(id, message.text, message.options).then((delivered) => {
      if (closed) return;
      if (delivered) {
        state.items = state.items.filter((item) => item !== message);
        settle(messageId, 'done');
      } else runs.annotate(messageId, { status: 'queued', startedAt: undefined, handledBy: undefined });
    }).catch((error) => {
      // A failed delivery can be ambiguous. Keep it for review and never send it automatically.
      state.items = state.items.filter((item) => item !== message);
      if (!closed) settle(messageId, 'interrupted', { error: error.message });
      state.error = redact(error.message);
      state.paused = true;
    }).finally(() => {
      state.steering = null;
      if (!closed) publish(id);
    });
    state.steering = { id: messageId, promise };
    publish(id);
    await promise;
  }

  return { snapshot, publish, submit, steer,
    remove(id, messageId) {
      const state = queues.get(id);
      if (!state || state.steering?.id === messageId || !state.items.some((item) => item.id === messageId)) return;
      settle(messageId, 'canceled');
      state.items = state.items.filter((item) => item.id !== messageId);
      state.error = null;
      if (!state.running && !state.items.length) queues.delete(id);
      publish(id);
    },
    resume(id) {
      const state = queues.get(id);
      if (!state?.paused || state.running) return;
      state.paused = false;
      state.error = null;
      void drain(id, state);
    },
    retry(runId) {
      const run = runs.get(runId);
      if (!run?.payload || !['failed', 'interrupted'].includes(run.status)) throw new Error('This run cannot be retried.');
      if (store.session(run.sessionId).readOnly) throw new Error('Start a new manual run from the automation after reviewing its last result.');
      if (run.retriedAs) throw new Error('A retry for this run already exists.');
      const retry = submit(run.sessionId, run.payload.text, run.payload.options, { retryOf: run.id, trigger: 'retry' });
      runs.annotate(run.id, { retriedAs: retry.id });
      return retry;
    },
    async stop(id) {
      const state = queues.get(id);
      if (state?.running) {
        state.paused = true;
        state.controller?.abort();
        publish(id);
      }
      await agentFor(id).stop(id);
    },
    close() {
      closed = true;
      for (const state of queues.values()) {
        if (state.current) settle(state.current.id, 'interrupted', { error: 'Workbench closed before this run finished.' });
        if (state.steering) settle(state.steering.id, 'interrupted', { error: 'Workbench closed before steering delivery could be confirmed.' });
        state.controller?.abort();
      }
    },
  };
}

module.exports = { createTurnQueue };
