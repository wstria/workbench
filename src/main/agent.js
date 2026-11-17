const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createTwoFilesPatch } = require('diff');
const { isInside } = require('./files');

const { redact, readSmallText, savedEntries, noAttachments } = require('./agent-common');
const { AUTO_MODEL, mergeUsage } = require('./usage');
const { teamPathAllowed } = require('./team-sessions');
const { fingerprintFile } = require('./reviews');

function textBlocks(blocks) {
  return Array.isArray(blocks) ? blocks.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : '';
}

const changeTools = new Set(['edit', 'write', 'bash', 'powershell']);
const inspectionTools = ['read', 'grep', 'find', 'ls'];

function preparePrompt(text, attachment) {
  const parts = [text || 'Review the attached context.', ...attachment.text.map(redact)];
  if (attachment.images.length) parts.push('Images in order: ' + attachment.images.map(({ label }) => label).join(', '));
  const images = attachment.images.map(({ type, data, mimeType }) => ({ type, data, mimeType }));
  return { text: parts.join('\n\n'), images };
}

function createAgent({ store, files, providers, send, prepareAttachments, integrations, usage, memory, computers, team }) {
  const running = new Map();

  function transcript(id) {
    store.session(id);
    const run = running.get(id);
    return { entries: run?.entries ?? savedEntries(store, id), busy: Boolean(run), approvals: requests(run), canSteer: canSteer(run) };
  }

  function canSteer(run) {
    return Boolean(run?.ready && !run.cancelled && run.session?.isStreaming);
  }

  function requests(run) {
    return Array.from(run?.approvals.values() ?? [], ({ request }) => request);
  }

  async function run(id, input, options = {}) {
    const chat = store.session(id);
    if (running.has(id)) throw new Error('This session is already running.');
    const inputText = redact(input).trim();
    if (inputText.length > 50000 || (!inputText && !options.attachments?.length && !options.context?.length)) throw new Error('Enter a message or select an attachment.');
    const computerName = chat.computerId ? computers?.name(chat.computerId) : null;
    if (chat.computerId && !computerName) throw new Error('The selected agent computer is no longer available.');
    const requested = chat.readOnly ? store.data.model : options.model ?? chat.model ?? store.data.model;
    const permission = chat.readOnly ? 'auto' : options.permission ?? chat.permission ?? 'auto';
    if (permission !== 'ask' && permission !== 'auto') throw new Error('Choose Auto or Ask.');
    usage?.check();
    const attachment = (options.attachments?.length || options.context?.length) ? await prepareAttachments(options.attachments, options.context) : noAttachments;
    const route = requested === AUTO_MODEL && usage ? usage.choose({ harness: 'pi', catalog: await providers.catalog(),
      prompt: inputText, images: attachment.images.length, context: attachment.text.reduce((sum, text) => sum + text.length, 0) }) : null;
    const modelId = route?.model ?? requested;
    const { models: modelRuntime, model, sanitize } = await providers.modelFor(modelId);
    const clean = (value) => redact(sanitize(value));
    const prompt = clean(inputText);
    if (options.signal?.aborted) return { skipped: true };
    if (running.has(id)) throw new Error('This session is already running.');

    options.reportRun?.({ actualHarness: 'pi', actualModel: modelId, provider: model.provider, routing: route?.rule,
      excerpts: attachment.text.map((text, index) => ({ source: attachment.sources[index], text: clean(text) })) });
    const entries = savedEntries(store, id);
    const first = entries.length === 0;
    const state = { entries, session: null, cancelled: false, approvals: new Map() };
    running.set(id, state);
    const publish = (persist = false) => {
      if (persist) store.saveTranscript(id, entries);
      send({ id, entries, busy: running.has(id), approvals: requests(state), canSteer: canSteer(state) });
    };
    const append = (entry) => {
      const added = { id: randomUUID(), at: Date.now(), ...entry };
      entries.push(added);
      return added;
    };
    state.acceptSteer = (entry) => { append(entry); publish(true); };

    if (first && chat.title === 'New session') chat.title = (prompt || attachment.names[0]).split('\n')[0].slice(0, 70);
    Object.assign(chat, { model: requested, permission });
    store.update();
    append({ type: 'user', text: prompt, attachments: attachment.names, sources: attachment.sources, model: modelId });
    if (route) append({ type: 'status', text: 'Routed to ' + model.name });
    publish(true);
    const measuredUsage = {};
    let assistant;
    let bindings;
    let releaseComputer;
    let failure;
    let publishTimer;
    const tools = new Map();
    const publishStream = () => {
      if (publishTimer) return;
      publishTimer = setTimeout(() => {
        publishTimer = null;
        publish();
      }, 50);
    };
    try {
      if (chat.computerId) releaseComputer = computers.lease(chat.computerId, id);
      const sdk = await import('@earendil-works/pi-coding-agent');
      if (attachment.images.length && !model.input.includes('image')) throw new Error('This model does not accept images.');

      const authorizeTools = (pi) => {
        pi.on('tool_call', async (event) => {
          const integrationCall = event.toolName === 'workbench_mcp' && event.input.operation === 'call';
          const guestAction = ['computer_shell', 'computer_input', 'computer_export'].includes(event.toolName);
          const teamSpawn = event.toolName === 'workbench_team' && event.input.action === 'spawn';
          if (chat.isolation && ['read', 'grep', 'find', 'ls', 'edit', 'write'].includes(event.toolName)) {
            const pattern = event.toolName === 'find' ? event.input.pattern : undefined;
            if (!(await teamPathAllowed(chat.cwd, event.input.path, event.toolName === 'read')) ||
              (typeof pattern === 'string' && (path.isAbsolute(pattern) || pattern.replaceAll('\\', '/').split('/').includes('..')))) {
              return { block: true, reason: 'Parallel agents can only access files in their own working folder.' };
            }
          }
          if (!integrationCall && !changeTools.has(event.toolName) && !guestAction && !teamSpawn) return;
          if (state.cancelled) return { block: true, reason: 'Session stopped.', terminate: true };
          if (permission === 'ask') {
            const target = integrationCall ? event.input.server + ' / ' + event.input.tool
              : teamSpawn ? [event.input.title, event.input.task].filter(Boolean).join(' · ')
              : event.input.command ?? event.input.path ?? (guestAction ? 'Interact with ' + computerName : '');
            const request = {
              id: event.toolCallId,
              tool: event.toolName,
              target: clean(target).slice(0, 12000),
            };
            const allowed = await new Promise((resolve) => {
              state.approvals.set(request.id, { request, resolve });
              publish();
            });
            if (state.cancelled) return { block: true, reason: 'Session stopped.', terminate: true };
            append({ type: 'status', approval: allowed ? 'allowed' : 'denied',
              text: (allowed ? 'Allowed ' : 'Denied ') + request.tool + ' · ' + request.target });
            publish(true);
            if (!allowed) return { block: true, reason: 'The user denied this action.', terminate: true };
          }
          if (files.checkpoint && ['edit', 'write'].includes(event.toolName) && typeof event.input.path === 'string') {
            try {
              const target = fs.realpathSync(path.resolve(chat.cwd, event.input.path));
              if (isInside(chat.cwd, target) && fs.statSync(target).isFile()) {
                await files.checkpoint(target, { label: 'Before agent ' + event.toolName });
              }
            } catch (error) {
              if (error.code !== 'ENOENT') return { block: true, reason: 'Could not checkpoint this file before editing.' };
            }
          }
        });
      };
      const memoryTool = !computerName && !chat.readOnly && memory && {
        name: 'workbench_memory',
        label: 'Propose user memory',
        description: 'Propose a durable user preference or correction for the user to review in Workbench Settings. Use only for facts and preferences the user has asked you to remember. Never include credentials or secrets.',
        parameters: {
          type: 'object',
          properties: { title: { type: 'string' }, content: { type: 'string' }, id: { type: 'string', description: 'Optional ID of an existing memory to update.' } },
          required: ['title', 'content'],
          additionalProperties: false,
        },
        async execute(_, input) {
          await memory.propose({ ...input, sessionId: id });
          return { content: [{ type: 'text', text: 'The memory proposal is awaiting review in Settings → Memory.' }], details: {} };
        },
      };
      bindings = !computerName && !chat.isolation ? integrations?.piBindings({ cwd: chat.cwd, selection: options.integrations, readOnly: chat.readOnly, signal: options.signal }) : undefined;
      const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false } });
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd: chat.cwd, agentDir: store.folders.pi, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: Boolean(computerName || chat.isolation),
        disabledBuiltinExtensions: computerName || chat.isolation ? ['mcp'] : undefined,
        systemPromptOverride: computerName ? () =>
          'You work only in the dedicated virtual computer ' + computerName + '. Use the computer tools to observe and operate the guest. Run commands only in the guest. Use computer_handoff for credentials, payment or user approval. The tool waits for the user to release the desktop.' : undefined,
        additionalSkillPaths: bindings?.additionalSkillPaths,
        additionalExtensionPaths: bindings?.additionalExtensionPaths,
        extensionFactories: [{ name: 'workbench-permissions', factory: authorizeTools }],
        appendSystemPrompt: computerName ? [] : [
          chat.reviewWorkspace?.explicit && 'Work in the separate Git checkout. Keep commands and edits in that folder, run appropriate checks there, and report the test results.',
          'When making changes, state the next user-visible action in one short sentence where helpful. Work in the selected workspace. Do not send local files to other services.',
          memory?.promptContext(),
          team?.context(id),
        ].filter(Boolean),
      });
      await resourceLoader.reload();
      const sessionManager = chat.piPath
        ? sdk.SessionManager.open(chat.piPath, store.folders.sessions, chat.cwd)
        : sdk.SessionManager.create(chat.cwd, store.folders.sessions);
      if (!chat.piPath) {
        chat.piPath = sessionManager.getSessionFile();
        store.update();
      }
      const customTools = computerName
        ? computers.tools(chat.computerId).filter((tool) => tool.name !== 'computer_screen' || model.input.includes('image'))
        : [...(bindings?.customTools ?? []), ...(memoryTool ? [memoryTool] : []), ...(team?.tools(id, { model: requested, permission }) ?? [])];
      const baseTools = chat.readOnly ? (options.tools ?? inspectionTools).filter((tool) => inspectionTools.includes(tool))
        : [...inspectionTools, 'edit', 'write', ...(!chat.isolation || chat.reviewWorkspace?.explicit ? ['bash'] : [])];
      const toolNames = customTools.map((tool) => tool.name);
      const { session, extensionsResult } = await sdk.createAgentSession({
        cwd: chat.cwd, agentDir: store.folders.pi, sessionManager, settingsManager, resourceLoader, modelRuntime, model,
        customTools,
        tools: computerName ? toolNames : !chat.readOnly && bindings?.additionalExtensionPaths?.length
          ? ['+grep', '+find', '+ls', ...toolNames.map((name) => '+' + name)]
          : [...baseTools, ...toolNames],
      });
      state.session = session;
      state.acceptsImages = model.input.includes('image');
      if (permission === 'ask' && extensionsResult.errors.some(({ path }) => path === '<inline:workbench-permissions>')) {
        throw new Error('Could not start the approval handler.');
      }
      session.subscribe((event) => {
        if (event.type === 'message_start' && event.message.role === 'user') {
          if (state.pendingSteer && state.ready) {
            const pending = state.pendingSteer;
            state.pendingSteer = null;
            state.acceptSteer(pending.entry);
            pending.resolve(true);
          }
          state.ready = !chat.readOnly;
          publish();
        }
        if (event.type === 'agent_end') {
          state.ready = false;
          publish();
        }
        if (event.type === 'message_start' && event.message.role === 'assistant') assistant = null;
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          if (!assistant) assistant = append({ type: 'assistant', text: '' });
          assistant.text = clean(textBlocks(event.message.content));
          publishStream();
        }
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          const billed = event.message.usage;
          if (billed && (billed.totalTokens || event.message.stopReason !== 'error')) {
            const input = billed.input + (billed.cacheRead || 0) + (billed.cacheWrite || 0);
            const cost = billed.cost?.total > 0 ? billed.cost.total : null;
            mergeUsage(measuredUsage, input, billed.output, cost, billed.totalTokens);
          }
          const finalText = clean(textBlocks(event.message.content));
          if (finalText) {
            if (!assistant) assistant = append({ type: 'assistant', text: '' });
            assistant.text = finalText;
          }
          if (event.message.stopReason === 'error') failure = clean(event.message.errorMessage || 'The model request failed.');
          publish(true);
        }
        if (event.type === 'tool_execution_start') {
          const inputPath = event.args?.path;
          const resolved = typeof inputPath === 'string' ? path.resolve(chat.cwd, inputPath) : null;
          const title = event.toolName === 'bash' ? event.args?.command : event.toolName === 'workbench_team' ? event.args?.title ?? event.args?.action
            : inputPath ?? event.args?.pattern;
          const entry = append({ type: 'tool', tool: event.toolName, title: clean(title), status: 'running' });
          if (event.toolName === 'workbench_team') entry.action = event.args?.action;
          const before = event.toolName === 'write' && resolved && isInside(chat.cwd, resolved) ? readSmallText(resolved) : undefined;
          if (resolved && ['edit', 'write'].includes(event.toolName) && isInside(chat.cwd, resolved)) {
            entry.beforeRevision = fingerprintFile(chat.cwd, resolved);
          }
          tools.set(event.toolCallId, { entry, resolved, before });
          publish(true);
        }
        if (event.type === 'tool_execution_end') {
          const tool = tools.get(event.toolCallId);
          if (!tool) return;
          const { entry, resolved, before } = tool;
          entry.status = event.isError ? 'failed' : 'done';
          entry.text = clean(textBlocks(event.result?.content)).slice(0, 24000);
          const link = event.result?.details?.sessionLink;
          if (!event.isError && entry.tool === 'workbench_team' && link) {
            entry.sessionLink = { id: link.id, title: clean(link.title) };
          }
          if (!event.isError && resolved) {
            try {
              const real = fs.realpathSync(resolved);
              if (isInside(chat.cwd, real) && fs.statSync(real).isFile()) {
                entry.path = real;
                if (['edit', 'write'].includes(entry.tool)) {
                  const after = before === undefined ? undefined : readSmallText(real);
                  const diff = event.result?.details?.diff ?? (after === undefined ? '' : createTwoFilesPatch(path.basename(real), path.basename(real), before, after, '', '', { context: 3 }));
                  entry.diff = clean(diff).slice(0, 28000);
                  if (entry.beforeRevision !== undefined) entry.afterRevision = fingerprintFile(chat.cwd, real);
                  files.register(real, true, false);
                }
              }
            } catch {
              // The command may remove its target or return a directory.
            }
          }
          publish(true);
        }
      });
      const prepared = preparePrompt(prompt, attachment);
      if (!state.cancelled) await session.prompt(prepared.text, { images: prepared.images, expandPromptTemplates: false });
      if (failure) throw new Error(failure);
    } catch (error) {
      failure = clean(error.message);
      if (!state.cancelled) append({ type: 'error', text: failure });
    } finally {
      releaseComputer?.();
      clearTimeout(publishTimer);
      state.pendingSteer?.resolve(false);
      state.ready = false;
      state.session?.dispose();
      await bindings?.close();
      state.approvals.clear();
      running.delete(id);
      for (const { entry } of tools.values()) {
        if (entry.status === 'running') entry.status = 'stopped';
      }
      if (state.cancelled) append({ type: 'status', text: 'Stopped' });
      if (!chat.computerId || releaseComputer) usage?.record({ harness: 'pi', model: modelId, provider: model.provider, usage: measuredUsage });
      publish(true);
      const description = state.cancelled ? 'Stopped' : failure ? failure.slice(0, 350) : 'Turn complete';
      if (!options.runId) store.activity(chat.readOnly ? 'automation' : 'session', chat.title, description, { type: 'session', id });
    }
    return { failure, cancelled: Boolean(state.cancelled), usage: measuredUsage };
  }

  return {
    transcript, run,
    async steer(id, text, options) {
      const state = running.get(id);
      if (!canSteer(state) || state.pendingSteer) return false;
      const attachment = (options.attachments?.length || options.context?.length) ? await prepareAttachments(options.attachments, options.context) : noAttachments;
      if (running.get(id) !== state || !canSteer(state) || state.pendingSteer) return false;
      if (attachment.images.length && !state.acceptsImages) throw new Error('The active model does not accept images.');
      const prepared = preparePrompt(text, attachment);
      const { promise, resolve } = Promise.withResolvers();
      const pending = { resolve, entry: { type: 'user', text, attachments: attachment.names, sources: attachment.sources, steered: true } };
      state.pendingSteer = pending;
      try {
        if (await state.session.steer(prepared.text, prepared.images) === 'queued') return await promise;
        return false;
      } finally {
        if (state.pendingSteer === pending) state.pendingSteer = null;
      }
    },
    decide(id, requestId, allowed) {
      const state = running.get(id);
      const pending = state?.approvals.get(requestId);
      if (!pending || typeof allowed !== 'boolean') return;
      state.approvals.delete(requestId);
      pending.resolve(allowed);
    },
    async stop(id) {
      const state = running.get(id);
      if (!state) return;
      state.cancelled = true;
      for (const { resolve } of state.approvals.values()) resolve(false);
      state.approvals.clear();
      await state.session?.abort();
    },
    stopAll() {
      for (const id of running.keys()) void this.stop(id);
    },
  };
}

module.exports = { createAgent };
