const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createTwoFilesPatch } = require('diff');
const { isInside } = require('./files');
const { redact, readSmallText, savedEntries, noAttachments } = require('./agent-common');
const { AUTO_MODEL, mergeUsage } = require('./usage');

const nativeToolNames = { shell: 'bash', patch: 'edit', apply_patch: 'edit', glob: 'find' };
const mutatingActions = new Set(['shell', 'edit']);

function permissions(mode) {
  const always = [{ action: 'question', resource: '*', effect: 'deny' }];
  if (mode === 'auto') return always;
  return [...always, ...['shell', 'edit', 'external_directory', 'subagent'].map((action) => ({ action, resource: '*', effect: 'ask' }))];
}

function workspacePath(cwd, input) {
  if (typeof input !== 'string' || !input) return null;
  const resolved = path.resolve(cwd, input);
  try {
    const canonical = fs.realpathSync(resolved);
    if (isInside(cwd, canonical) && fs.statSync(canonical).isFile()) return canonical;
  } catch (error) {
    if (error.code === 'ENOENT' && isInside(cwd, resolved)) return resolved;
  }
  return null;
}

function promptPayload(text, attachment) {
  return {
    text: [text || 'Review the attached context.', ...attachment.text.map(redact)].join('\n\n'),
    files: attachment.images.map(({ label, mimeType, data }) => ({ name: label, uri: `data:${mimeType};base64,${data}` })),
  };
}

function createOpenCodeAgent({ store, files, prepareAttachments, send, client, integrations, usage, memory, team }) {
  const running = new Map();
  const approvals = (run) => Array.from(run?.approvals.values() ?? []);
  const canSteer = (run) => Boolean(run?.ready && !run.ended && !run.cancelled);

  function transcript(id) {
    store.session(id);
    const run = running.get(id);
    return { entries: run?.entries ?? savedEntries(store, id), busy: Boolean(run), approvals: approvals(run), canSteer: canSteer(run) };
  }

  function update(run, persist = false) {
    if (persist) store.saveTranscript(run.id, run.entries);
    send({ id: run.id, entries: run.entries, busy: running.has(run.id), approvals: approvals(run), canSteer: canSteer(run) });
  }

  function append(run, entry) {
    const added = { id: randomUUID(), at: Date.now(), ...entry };
    run.entries.push(added);
    return added;
  }

  function reply(run, request, allowed) {
    return run.api.request(run.route + '/permission/' + encodeURIComponent(request) + '/reply', {
      method: 'POST', body: { decision: allowed ? 'once' : 'reject' },
    });
  }

  async function interrupt(run) {
    if (!run.submission) return;
    await run.submission.catch(() => {});
    await run.api.request(run.route + '/interrupt?resume=false', { method: 'POST', signal: AbortSignal.timeout(4000) });
  }

  function rememberFile(cwd, entry, input) {
    const file = workspacePath(cwd, input);
    if (!file || !fs.existsSync(file)) return;
    entry.path = file;
    if (entry.tool === 'edit' || entry.tool === 'write') files.register(file, true, false);
  }

  async function handleEvent(run, event) {
    const { type, data } = event;
    const clean = run.cleanIntegrationOutput ?? redact;
    if ((data?.sessionID ?? data?.form?.sessionID) !== run.nativeId) return;
    switch (type) {
      case 'session.execution.started':
        run.ready = true;
        update(run);
        break;
      case 'session.inbox.delivered': {
        const pending = run.pendingSteer;
        if (!pending || data.inboxID !== pending.id) break;
        run.pendingSteer = null;
        append(run, pending.entry);
        update(run, true);
        pending.resolve(true);
        break;
      }
      case 'session.text.delta':
      case 'session.text.ended': {
        const key = `${data.assistantMessageID}:${data.ordinal}`;
        let text = run.messages.get(key);
        if (!text) {
          text = { raw: '', entry: append(run, { type: 'assistant', text: '' }) };
          run.messages.set(key, text);
        }
        text.raw = type === 'session.text.ended' ? data.text : text.raw + data.delta;
        text.entry.text = clean(text.raw);
        if (type === 'session.text.ended') update(run, true);
        else if (!run.publishTimer) run.publishTimer = setTimeout(() => {
          run.publishTimer = null;
          update(run);
        }, 50);
        break;
      }
      case 'session.tool.input.started':
        run.toolNames.set(data.id, data.name);
        break;
      case 'session.tool.called': {
        const name = run.toolNames.get(data.id) ?? 'tool';
        const tool = nativeToolNames[name] ?? name;
        const input = data.input ?? {};
        const target = input.path ?? input.filePath;
        const file = workspacePath(run.cwd, target);
        const entry = append(run, { type: 'tool', tool, title: clean(input.command ?? target ?? input.pattern ?? input.query).slice(0, 12000), status: 'running' });
        const before = file && (tool === 'edit' || tool === 'write') ? readSmallText(file) : undefined;
        run.tools.set(data.id, { entry, file, before });
        update(run, true);
        break;
      }
      case 'session.tool.success':
      case 'session.tool.failed': {
        const tool = run.tools.get(data.id);
        if (!tool) break;
        const { entry, file, before, patches } = tool;
        entry.status = type === 'session.tool.success' ? 'done' : 'failed';
        const output = data.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        entry.text = clean(data.error?.message ?? output).slice(0, 24000);
        if (entry.status === 'done') {
          if (patches?.length) {
            entry.diff = clean(patches.map((patch) => patch.patch).join('\n')).slice(0, 28000);
            for (const patch of patches) rememberFile(run.cwd, entry, patch.file);
          } else if (before !== undefined && file) {
            const currentFile = workspacePath(run.cwd, file);
            const after = currentFile === file ? readSmallText(file) : undefined;
            if (after !== undefined && before !== after) {
              const name = path.relative(run.cwd, file);
              entry.diff = clean(createTwoFilesPatch(name, name, before, after, '', '', { context: 3 })).slice(0, 28000);
            }
          }
          if (file) rememberFile(run.cwd, entry, file);
        }
        update(run, true);
        break;
      }
      case 'permission.asked': {
        if (run.cancelled) break;
        const tool = run.tools.get(data.source?.id);
        if (tool && Array.isArray(data.metadata?.files)) {
          tool.patches = data.metadata.files.filter((item) => typeof item.patch === 'string' && typeof item.file === 'string');
        }
        if (run.mode === 'auto' && mutatingActions.has(data.action)) {
          await reply(run, data.id, true);
          break;
        }
        run.approvals.set(data.id, { id: data.id, tool: nativeToolNames[data.action] ?? data.action,
          target: clean(data.resources?.join('\n') || data.message).slice(0, 12000) });
        update(run);
        break;
      }
      case 'permission.replied':
        if (run.approvals.delete(data.requestID)) update(run);
        break;
      case 'form.created': {
        const message = 'OpenCode requested a form. Ask in chat to continue.';
        await run.api.request(run.route + '/form/' + encodeURIComponent(data.form.id) + '?' + new URLSearchParams({ message }), { method: 'DELETE' });
        append(run, { type: 'status', text: message });
        update(run, true);
        break;
      }
      case 'session.usage.recorded': {
        const measured = data.tokens;
        const input = measured ? measured.input + (measured.cache?.read || 0) + (measured.cache?.write || 0) : null;
        mergeUsage(run.usage, input, measured?.output, data.cost);
        break;
      }
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted':
        run.ended = true;
        if (type === 'session.execution.failed') throw new Error(data.error?.message || 'OpenCode could not complete the turn.');
        if (type === 'session.execution.interrupted') run.cancelled = true;
        break;
    }
  }

  async function run(id, input, options = {}) {
    const chat = store.session(id);
    if (chat.readOnly) throw new Error('Read-only automations use Pi.');
    if (running.has(id)) throw new Error('This session is already running.');
    const prompt = redact(input).trim();
    if (prompt.length > 50000 || (!prompt && !options.attachments?.length && !options.context?.length)) throw new Error('Enter a message or select an attachment.');
    const mode = options.permission ?? chat.permission ?? 'ask';
    if (mode !== 'ask' && mode !== 'auto') throw new Error('Choose Auto or Ask.');
    const attachment = (options.attachments?.length || options.context?.length) ? await prepareAttachments(options.attachments, options.context) : noAttachments;
    const cwd = fs.realpathSync(chat.cwd);
    usage?.check();
    const catalog = await client.catalog(cwd);
    const requested = options.model || chat.model || store.data.harnessDefaults?.opencode?.model || catalog.defaultModel;
    const route = requested === AUTO_MODEL && usage ? usage.choose({ harness: 'opencode', catalog, prompt,
      images: attachment.images.length, context: attachment.text.reduce((sum, text) => sum + text.length, 0) }) : null;
    const modelId = route?.model ?? requested;
    const selected = catalog.models.find((model) => model.id === modelId);
    if (!selected) throw new Error('Choose an available OpenCode model. Configure a provider with opencode auth login if needed.');
    if (attachment.images.length && !selected.images) throw new Error('This model does not accept images.');
    if (options.signal?.aborted) return { skipped: true };
    if (running.has(id)) throw new Error('This session is already running.');

    options.reportRun?.({ actualHarness: 'opencode', actualModel: modelId, provider: selected.provider, routing: route?.rule,
      excerpts: attachment.text.map((text, index) => ({ source: attachment.sources[index], text: redact(text) })) });
    const state = { id, cwd, mode, acceptsImages: selected.images, entries: savedEntries(store, id), approvals: new Map(), deciding: new Set(),
      messages: new Map(), tools: new Map(), toolNames: new Map(), usage: {}, stream: new AbortController() };
    running.set(id, state);
    let failure;
    let events;
    let bindings;
    try {
      if (!state.entries.length && chat.title === 'New session') chat.title = (prompt || attachment.names[0]).split('\n')[0].slice(0, 70);
      Object.assign(chat, { model: requested, permission: mode });
      store.update();
      append(state, { type: 'user', text: prompt, attachments: attachment.names, sources: attachment.sources, model: modelId });
      if (route) append(state, { type: 'status', text: 'Routed to ' + selected.name });
      update(state, true);
      state.api = await client.connect();
      const model = { providerID: selected.providerID, id: selected.modelID };
      bindings = await integrations?.openCodeBindings({
        api: state.api, cwd, selection: options.integrations, mode, readOnly: chat.readOnly,
      });
      state.cleanIntegrationOutput = bindings?.clean;
      const rules = [...permissions(mode), ...(bindings?.rules ?? [])];
      if (chat.openCodeId) {
        state.nativeId = chat.openCodeId;
        state.route = '/api/session/' + encodeURIComponent(state.nativeId);
        const { data: native } = await state.api.request(state.route);
        if (native.location?.directory !== cwd) throw new Error('The OpenCode session belongs to a different workspace.');
        await state.api.request(state.route, { method: 'PATCH', body: { permissions: rules } });
        await state.api.request(state.route + '/model', { method: 'POST', body: { model } });
      } else {
        const { data: native } = await state.api.request('/api/session', {
          method: 'POST', body: { title: chat.title, location: { directory: cwd }, model, permissions: rules },
        });
        if (native.location?.directory !== cwd) throw new Error('OpenCode selected a different workspace.');
        state.nativeId = chat.openCodeId = native.id;
        state.route = '/api/session/' + encodeURIComponent(state.nativeId);
        store.update();
      }
      if (!state.cancelled) {
        const connectTimeout = setTimeout(() => state.stream.abort(new Error('OpenCode event stream did not connect.')), 15000);
        try {
          events = await state.api.events(state.stream.signal);
          const first = await events.next();
          if (first.value?.type !== 'server.connected') throw new Error('OpenCode event stream did not connect.');
        } finally { clearTimeout(connectTimeout); }
      }
      if (!state.cancelled) {
        const skillContext = bindings?.prompt;
        const memoryContext = memory?.promptContext();
        const payload = promptPayload(prompt, attachment);
        if (memoryContext) payload.text += '\n\n' + redact(memoryContext);
        const linkedContext = team?.context(id);
        if (linkedContext) payload.text += '\n\n' + redact(linkedContext);
        if (skillContext) payload.text += '\n\nWorkbench skills enabled for this turn. Apply them when relevant.\n\n' + skillContext;
        const body = { ...payload, resume: true };
        state.submission = state.api.request(state.route + '/prompt', { method: 'POST', body });
        await state.submission;
        for await (const event of events) {
          if (state.cancelled) break;
          await handleEvent(state, event);
          if (state.ended) break;
        }
        if (!state.ended && !state.cancelled) throw new Error('OpenCode disconnected before the turn finished.');
      }
    } catch (error) {
      if (!state.cancelled) {
        failure = (state.cleanIntegrationOutput ?? redact)(error.message);
        append(state, { type: 'error', text: failure });
      }
    } finally {
      if (state.stopping) await state.stopping;
      else if (!state.ended && state.submission) await interrupt(state).catch(() => {});
      state.ready = false;
      state.stream.abort();
      await events?.return().catch(() => {});
      await bindings?.close();
      const pending = state.pendingSteer;
      if (pending) {
        await pending.submission.catch(() => {});
        try {
          await state.api.request(state.route + '/inbox/' + encodeURIComponent(pending.id), { method: 'DELETE', signal: AbortSignal.timeout(4000) });
          pending.resolve(false);
        } catch (error) {
          pending.reject(new Error('Could not confirm whether OpenCode received the steering message.'));
        }
      }
      clearTimeout(state.publishTimer);
      state.approvals.clear();
      running.delete(id);
      for (const { entry } of state.tools.values()) if (entry.status === 'running') entry.status = 'stopped';
      if (state.cancelled) append(state, { type: 'status', text: 'Stopped' });
      usage?.record({ harness: 'opencode', model: modelId, provider: selected.provider, usage: state.usage });
      update(state, true);
      if (!options.runId) store.activity('session', chat.title, state.cancelled ? 'Stopped' : failure?.slice(0, 350) || 'Turn complete', { type: 'session', id });
    }
    return { failure, cancelled: Boolean(state.cancelled), usage: state.usage };
  }

  async function decide(id, requestId, allowed) {
    const state = running.get(id);
    if (!state?.approvals.has(requestId) || state.deciding.has(requestId) || typeof allowed !== 'boolean') return;
    state.deciding.add(requestId);
    try {
      await reply(state, requestId, allowed);
      state.approvals.delete(requestId);
      update(state);
    } finally { state.deciding.delete(requestId); }
  }

  return { transcript, run, decide, busy: () => running.size > 0,
    async steer(id, text, options) {
      const state = running.get(id);
      if (!canSteer(state) || state.pendingSteer) return false;
      const attachment = (options.attachments?.length || options.context?.length) ? await prepareAttachments(options.attachments, options.context) : noAttachments;
      if (running.get(id) !== state || !canSteer(state) || state.pendingSteer) return false;
      if (attachment.images.length && !state.acceptsImages) throw new Error('The active model does not accept images.');
      const messageId = 'msg_' + randomUUID().replaceAll('-', '');
      const { promise, resolve, reject } = Promise.withResolvers();
      const body = { id: messageId, ...promptPayload(text, attachment), delivery: 'steer', resume: false };
      const submission = state.api.request(state.route + '/prompt', { method: 'POST', body });
      const entry = { type: 'user', text, attachments: attachment.names, sources: attachment.sources, steered: true };
      const pending = { id: messageId, entry, submission, resolve, reject };
      state.pendingSteer = pending;
      void submission.catch((error) => {
        // A lost response can still be followed by a delivery event.
        if (state.pendingSteer === pending && error.status >= 400 && error.status < 500) {
          state.pendingSteer = null;
          reject(error);
        }
      });
      return promise;
    },
    async stop(id) {
      const state = running.get(id);
      if (!state) return;
      state.cancelled = true;
      state.stopping ??= interrupt(state).catch(() => {}).finally(() => state.stream.abort());
      await state.stopping;
    },
    stopAll() { for (const id of running.keys()) void this.stop(id); },
  };
}

module.exports = { createOpenCodeAgent };
