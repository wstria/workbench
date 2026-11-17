const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const { redact, savedEntries, noAttachments } = require('./agent-common');
const { isInside } = require('./files');
const { openAcp, initializeAcp } = require('./acp-runtime');
const { AUTO_MODEL, mergeUsage } = require('./usage');

const identifiers = { hermes: 'Hermes', codex: 'Codex', claude: 'Claude Code', acp: 'Custom ACP' };
const nativeDefault = '@native/default';
const acpTools = { execute: 'bash', edit: 'edit', read: 'read', search: 'grep', fetch: 'web' };
const uuid = /^[\w-]{10,130}$/;

function acpSelect(session, category) {
  const options = session?.configOptions;
  return Array.isArray(options) ? options.find((option) => option?.category === category && option.type === 'select' && Array.isArray(option.options)) : undefined;
}

function selectValues(option) {
  return option.options.flatMap((row) => Array.isArray(row?.options) ? row.options : [row])
    .filter((row) => typeof row?.value === 'string' && row.value);
}

function childOptions(home, cwd) {
  const env = { ...process.env, NO_COLOR: '1', TERM: 'dumb' };
  env.PATH = [...new Set([path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', ...String(env.PATH || '').split(path.delimiter)])].join(path.delimiter);
  delete env.ELECTRON_RUN_AS_NODE;
  return { cwd, env };
}

function nativeThreads(executable, args, options, consume, input, state) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    let stderr = '';
    child.stdin.on('error', () => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-5000); });
    const cancel = () => {
      const kill = (signal) => {
        try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); }
        catch { /* Already stopped. */ }
      };
      if (child.pid) kill('SIGTERM');
      const timer = setTimeout(() => { if (child.exitCode === null) kill('SIGKILL'); }, 3500);
      timer.unref();
    };
    state.stop = cancel;
    const reader = createInterface({ input: child.stdout });
    reader.on('line', (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      consume(event);
    });
    child.once('error', (error) => reject(new Error('Could not launch the harness: ' + error.code)));
    child.once('close', (code) => {
      state.stop = undefined;
      if (state.cancelled) resolve();
      else if (state.failure || code !== 0) {
        const last = stderr.trim().split('\n').at(-1);
        reject(new Error(state.failure || (last ? redact(last).slice(0, 600) : 'The harness stopped before completing the turn.')));
      } else resolve();
    });
    child.stdin.end(input + '\n');
    if (state.cancelled) cancel();
  });
}

function createNativeHarnesses({ store, home, files, prepareAttachments, send, usage, memory, integrations, team }) {
  const active = new Map();
  const catalogs = new Map();

  function labelFor(harness) {
    return harness === 'acp' ? store.data.customAcp?.name || identifiers.acp : identifiers[harness];
  }

  function acpArguments(harness) {
    return harness === 'acp' ? store.data.customAcp?.args ?? [] : ['acp'];
  }

  function executableFor(harness) {
    if (!Object.hasOwn(identifiers, harness)) throw new Error('Choose a supported harness.');
    const name = process.platform === 'win32' ? harness + '.exe' : harness;
    const configured = store.data.harnessExecutables?.[harness];
    if (harness === 'acp' && !configured) throw new Error('Choose the ACP executable in Settings → Harnesses.');
    const candidates = configured ? [configured] : [
      ...String(process.env.PATH || '').split(path.delimiter).filter(path.isAbsolute).map((dir) => path.join(dir, name)),
      path.join(home, '.local', 'bin', name),
      path.join(home, '.bun', 'bin', name),
      '/opt/homebrew/bin/' + name,
      '/usr/local/bin/' + name,
      ...(harness === 'codex' && process.platform === 'darwin' ? [
        '/Applications/Codex.app/Contents/Resources/codex',
        '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      ] : []),
    ];
    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* Look in the next standard install location. */ }
    }
    throw new Error(labelFor(harness) + ' could not be found. Install it or choose its executable in Settings → Harnesses.');
  }

  async function usingCodexServer(executable, cwd, operation) {
    const server = openAcp(executable, ['app-server'], childOptions(home, cwd));
    try {
      await server.request('initialize', { clientInfo: { name: 'workbench', title: 'Workbench', version: '1.0.0' },
        capabilities: { experimentalApi: true } }, 8000);
      server.notify('initialized');
      return await operation(server);
    } finally { server.close(); }
  }

  function catalog(harness, cwd, refresh = false) {
    const executable = executableFor(harness);
    const configured = store.data.harnessModels?.[harness] ?? [];
    const provider = labelFor(harness);
    const local = [{ id: nativeDefault, modelId: '', name: provider + ' default', provider, images: harness === 'codex' },
      ...configured.map((model) => ({ id: model, modelId: model, name: model, provider, images: false }))];
    if (harness === 'claude') return Promise.resolve({ models: local, defaultModel: nativeDefault, executable });
    const key = [harness, executable, cwd].join('\0');
    const previous = catalogs.get(key);
    if (!refresh && previous?.expires > Date.now()) return previous.result;
    const result = (async () => {
      if (harness === 'codex') {
        try {
          const values = await usingCodexServer(executable, cwd,
            (server) => server.request('model/list', { limit: 100, includeHidden: false }, 8000));
          const discovered = (values.data ?? []).filter((row) => !row.hidden && typeof row.model === 'string').map((row) => ({
            id: row.model, modelId: row.model, name: row.displayName || row.model, provider,
            images: row.inputModalities?.includes('image') ?? false,
          }));
          const modelMap = new Map([...local, ...discovered].map((model) => [model.id, model]));
          return { models: [...modelMap.values()], defaultModel: nativeDefault, executable };
        } catch { return { models: local, defaultModel: nativeDefault, executable }; }
      }
      const client = openAcp(executable, acpArguments(harness), childOptions(home, cwd));
      try {
        const info = await initializeAcp(client);
        if (info.protocolVersion !== 1) throw new Error(provider + ' must support ACP version 1.');
        const session = await client.request('session/new', { cwd, mcpServers: [] });
        const modelOption = acpSelect(session, 'model');
        const modelState = session?.models;
        const images = info.agentCapabilities?.promptCapabilities?.image === true;
        const choices = modelOption ? selectValues(modelOption).map((row) => ({ ...row, modelId: row.value })) : modelState?.availableModels ?? [];
        const models = choices.filter((row) => typeof row?.modelId === 'string' && row.modelId).map((row) => ({
          id: row.modelId, modelId: row.modelId, name: row.name || row.modelId,
          provider: harness === 'hermes' && row.modelId.includes(':') ? row.modelId.split(':')[0] : provider, images,
        }));
        if (!models.length) models.push({ id: nativeDefault, modelId: '', name: provider + ' default', provider, images });
        const current = modelOption?.currentValue ?? modelState?.currentModelId;
        const defaultModel = models.find((row) => row.id === current)?.id ?? models[0].id;
        return { models, defaultModel, executable, version: info.agentInfo?.version };
      } finally { client.close(); }
    })();
    catalogs.set(key, { expires: Date.now() + 30000, result });
    if (catalogs.size > 24) catalogs.delete(catalogs.keys().next().value);
    result.catch(() => { if (catalogs.get(key)?.result === result) catalogs.delete(key); });
    return result;
  }

  async function codexUsage() {
    const executable = executableFor('codex');
    const status = await usingCodexServer(executable, store.data.cwd, async (server) => {
      const { account } = await server.request('account/read', { refreshToken: false }, 8000);
      if (account?.type !== 'chatgpt' && account?.type !== 'chatgptAuthTokens') return null;
      return server.request('account/rateLimits/read', null, 12000);
    });
    const buckets = status?.rateLimitsByLimitId ? Object.values(status.rateLimitsByLimitId) : status?.rateLimits ? [status.rateLimits] : [];
    const rows = buckets.flatMap((bucket) => ['primary', 'secondary'].flatMap((key) => {
      const window = bucket?.[key];
      if (!window || !Number.isFinite(window.usedPercent)) return [];
      return [{ id: (bucket.limitId || 'codex') + '-' + key, label: bucket.limitName || 'Codex', interval: window.windowDurationMins,
        percentRemaining: Math.max(0, Math.min(100, 100 - window.usedPercent)), resetsAt: window.resetsAt ? window.resetsAt * 1000 : null }];
    }));
    usage?.receiveAllowance('Codex', rows);
    return rows;
  }

  function publish(state, persist = false) {
    if (persist) store.saveTranscript(state.chat.id, state.entries);
    send({ id: state.chat.id, ...transcript(state.chat.id) });
  }

  function append(state, entry) {
    const data = { id: randomUUID(), at: Date.now(), ...entry };
    state.entries.push(data);
    return data;
  }

  function addMessage(state, text, appendDelta = false) {
    const clean = redact(text);
    if (!clean) return;
    if (!state.assistant) state.assistant = append(state, { type: 'assistant', text: '' });
    if (state.assistant.text.length > 256000) return;
    state.assistant.text = (appendDelta ? state.assistant.text + clean : clean).slice(0, 256000);
    if (!state.publishTimer) state.publishTimer = setTimeout(() => {
      state.publishTimer = undefined;
      publish(state);
    }, 45);
  }

  function rememberFile(state, entry, filename) {
    if (typeof filename !== 'string') return;
    try {
      const real = fs.realpathSync(path.resolve(state.chat.cwd, filename));
      if (!isInside(state.chat.cwd, real) || !fs.statSync(real).isFile()) return;
      entry.path = real;
      files.register(real, true, false);
    } catch { /* The tool may have removed a file or touched a directory. */ }
  }

  function tool(state, key, properties) {
    let entry = state.tools.get(key);
    if (!entry) {
      state.assistant = null;
      entry = append(state, { type: 'tool', status: 'running', ...properties });
      state.tools.set(key, entry);
    } else Object.assign(entry, properties);
    publish(state, true);
    return entry;
  }

  function transcript(id) {
    store.session(id);
    const state = active.get(id);
    return { entries: state?.entries ?? savedEntries(store, id), busy: Boolean(state), canSteer: false,
      approvals: Array.from(state?.requests.values() ?? [], ({ display }) => display) };
  }

  function stop(id) {
    const state = active.get(id);
    if (!state || state.cancelled) return;
    state.cancelled = true;
    for (const request of state.requests.values()) request.resolve(false);
    state.requests.clear();
    state.stop?.();
  }

  function acpUpdate(state, { sessionId, update } = {}) {
    if (!state.started || sessionId !== state.nativeId || !update) return;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') addMessage(state, update.content.text, true);
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const properties = {};
      if (update.kind) properties.tool = acpTools[update.kind] ?? update.kind;
      if (update.title) properties.title = redact(update.title).slice(0, 1000);
      if (update.status) properties.status = ({ completed: 'done', failed: 'failed' })[update.status] ?? 'running';
      const text = update.content?.map((row) => row.type === 'content' && row.content?.type === 'text' ? row.content.text : '').filter(Boolean).join('\n');
      if (text) properties.text = redact(text).slice(0, 24000);
      const diff = update.content?.find((row) => row.type === 'diff');
      const entry = tool(state, update.toolCallId, properties);
      if (diff?.path && properties.status === 'done') rememberFile(state, entry, diff.path);
    }
  }

  async function acpRequest(state, method, params) {
    if (method !== 'session/request_permission') return null;
    const { toolCall, options = [] } = params ?? {};
    const approve = options.find((row) => row.kind === 'allow_once');
    const reject = options.find((row) => row.kind === 'reject_once');
    const cancelled = { outcome: { outcome: 'cancelled' } };
    if (state.cancelled || !approve) return cancelled;
    const kind = toolCall?.kind;
    const allowedAutomatically = state.permission === 'auto' && ['edit', 'execute'].includes(kind);
    let allowed = allowedAutomatically;
    if (!allowedAutomatically) {
      const id = randomUUID();
      allowed = await new Promise((resolve) => {
        const display = { id, tool: acpTools[kind] ?? 'tool', target: redact(toolCall?.title || labelFor(state.chat.harness) + ' requested tool access.').slice(0, 12000) };
        state.requests.set(id, { display, resolve });
        publish(state);
      });
    }
    const decision = allowed ? approve : reject;
    return decision && !state.cancelled ? { outcome: { outcome: 'selected', optionId: decision.optionId } } : cancelled;
  }

  async function runAcp(state, harness, selected, nativeOptions, attachment, prompt, options) {
    const label = labelFor(harness);
    const client = openAcp(nativeOptions.executable, acpArguments(harness), nativeOptions,
      (update) => acpUpdate(state, update), (method, params) => acpRequest(state, method, params));
    let shutdown;
    state.stop = () => {
      if (!state.nativeId || !state.started) return client.close();
      client.notify('session/cancel', { sessionId: state.nativeId });
      shutdown = setTimeout(() => client.close(), 4000);
      shutdown.unref();
    };
    try {
      const info = await initializeAcp(client);
      if (info.protocolVersion !== 1) throw new Error(label + ' must support ACP version 1.');
      const mcpServers = await integrations?.acpServers?.(options.integrations, state.chat.cwd, state.chat.readOnly) ?? [];
      const params = { cwd: state.chat.cwd, mcpServers };
      const savedId = state.chat.nativeSessionId;
      let session;
      if (savedId) {
        if (!info.agentCapabilities?.loadSession) throw new Error(label + ' cannot resume stored chats. Open another chat to continue.');
        session = await client.request('session/load', { ...params, sessionId: savedId });
        if (!session) throw new Error('Could not resume the ' + label + ' session. Open another chat to continue.');
        state.nativeId = savedId;
      } else {
        session = await client.request('session/new', params);
        if (!session?.sessionId) throw new Error(label + ' did not create a session. Check its setup in a terminal.');
        state.nativeId = state.chat.nativeSessionId = session.sessionId;
        store.update();
      }
      const sessionId = state.nativeId;
      const modelOption = acpSelect(session, 'model');
      if (selected.id !== nativeDefault && (modelOption?.currentValue ?? session.models?.currentModelId) !== selected.id) {
        if (modelOption) await client.request('session/set_config_option', { sessionId, configId: modelOption.id, value: selected.id });
        else await client.request('session/set_model', { sessionId, modelId: selected.id });
      }
      const modeOption = acpSelect(session, 'mode');
      const modes = state.permission === 'auto' ? ['accept_edits', 'auto'] : ['ask', 'default'];
      if (modeOption) {
        const mode = selectValues(modeOption).find((row) => modes.includes(row.value));
        if (mode && modeOption.currentValue !== mode.value) await client.request('session/set_config_option', { sessionId, configId: modeOption.id, value: mode.value });
      } else {
        const mode = session.modes?.availableModes?.find((row) => modes.includes(row.id));
        if (mode && session.modes.currentModeId !== mode.id) await client.request('session/set_mode', { sessionId, modeId: mode.id });
      }
      if (state.cancelled) return;
      state.started = true;
      const result = await client.request('session/prompt', {
        sessionId, prompt: [{ type: 'text', text: prompt },
          ...attachment.images.map(({ data, mimeType }) => ({ type: 'image', data, mimeType }))],
      }, 0);
      if (result?.stopReason === 'refusal') throw new Error(label + ' declined the prompt. Check its provider and account setup.');
      if (result?.stopReason === 'cancelled') state.cancelled = true;
      const measured = result?.usage;
      if (measured) mergeUsage(state.usage, measured.inputTokens, measured.outputTokens, null, measured.totalTokens);
    } finally {
      clearTimeout(shutdown);
      client.close();
      state.stop = undefined;
    }
  }

  function codexEvent(state, event) {
    if (event.type === 'thread.started' && uuid.test(event.thread_id)) {
      state.chat.nativeSessionId = event.thread_id;
      store.update();
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      state.assistant = null;
      addMessage(state, event.item.text);
    }
    if (event.type?.startsWith('item.') && event.item?.type === 'command_execution') {
      const row = event.item;
      tool(state, row.id, { tool: 'bash', title: redact(row.command), status: event.type === 'item.completed' ? row.exit_code === 0 ? 'done' : 'failed' : 'running',
        text: redact(row.aggregated_output).slice(0, 24000) });
    }
    if (event.type === 'item.completed' && event.item?.type === 'file_change') {
      const row = event.item;
      const entry = tool(state, row.id, { tool: 'edit', title: row.changes?.map((item) => redact(item.path)).join(', '), status: row.status === 'completed' ? 'done' : 'failed' });
      if (entry.status === 'done') rememberFile(state, entry, row.changes?.[0]?.path);
    }
    if (event.type === 'turn.completed') {
      const values = event.usage;
      mergeUsage(state.usage, values?.input_tokens, values?.output_tokens, null);
    }
    if (event.type === 'turn.failed') state.failure = redact(event.error?.message || 'Codex could not complete the turn.');
  }

  function claudeEvent(state, event) {
    if (event.type === 'system' && event.subtype === 'init' && uuid.test(event.session_id)) {
      state.chat.nativeSessionId = event.session_id;
      store.update();
    }
    if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') addMessage(state, event.event.delta.text, true);
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      const text = event.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      if (text) addMessage(state, text);
      state.assistant = null;
      for (const block of event.message.content) {
        if (block.type !== 'tool_use') continue;
        tool(state, block.id, { tool: ({ Bash: 'bash', Read: 'read', Edit: 'edit', Write: 'write' })[block.name] ?? block.name,
          title: redact(block.input?.command ?? block.input?.file_path ?? block.input?.pattern), status: 'running' });
      }
    }
    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const row of event.message.content) {
        if (row.type !== 'tool_result' || !state.tools.has(row.tool_use_id)) continue;
        const text = typeof row.content === 'string' ? row.content : row.content?.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
        const entry = tool(state, row.tool_use_id, { status: row.is_error ? 'failed' : 'done', text: redact(text).slice(0, 24000) });
        if (!row.is_error && ['edit', 'write'].includes(entry.tool)) rememberFile(state, entry, entry.title);
      }
    }
    if (event.type === 'result') {
      const values = event.usage;
      const input = values ? [values.input_tokens, values.cache_creation_input_tokens, values.cache_read_input_tokens].reduce((sum, row) => sum + (row || 0), 0) : null;
      mergeUsage(state.usage, input, values?.output_tokens, event.total_cost_usd);
      if (event.is_error || event.subtype !== 'success') state.failure = redact(event.errors?.[0] || event.result || 'Claude Code could not complete the turn.');
      else if (event.result && !state.entries.some((row) => row.type === 'assistant' && row.text === event.result)) addMessage(state, event.result);
    }
  }

  async function runCli(state, harness, selected, nativeOptions, attachment, prompt) {
    const model = selected.modelId ? ['--model', selected.modelId] : [];
    const nativeId = state.chat.nativeSessionId;
    if (nativeId && !uuid.test(nativeId)) throw new Error('The stored native session ID is invalid.');
    if (harness === 'claude') {
      const permission = state.permission === 'ask' ? 'dontAsk' : 'acceptEdits';
      const tools = state.permission === 'ask' ? ['--tools', 'Read,Glob,Grep'] : [];
      const args = ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--disable-slash-commands',
        '--permission-mode', permission, ...tools, ...model, ...(nativeId ? ['--resume', nativeId] : [])];
      return nativeThreads(nativeOptions.executable, args, nativeOptions, (event) => claudeEvent(state, event), prompt, state);
    }
    let imageDir;
    try {
      const images = [];
      if (attachment.images.length) {
        imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-codex-'));
        for (const [index, item] of attachment.images.entries()) {
          const filename = path.join(imageDir, index + (item.mimeType === 'image/png' ? '.png' : '.jpg'));
          fs.writeFileSync(filename, Buffer.from(item.data, 'base64'), { mode: 0o600 });
          images.push('--image', filename);
        }
      }
      const sandbox = state.permission === 'ask' ? 'read-only' : 'workspace-write';
      const args = ['exec', ...(nativeId ? ['resume'] : []), '--json', '--skip-git-repo-check',
        '-c', 'sandbox_mode="' + sandbox + '"', '-c', 'approval_policy="never"', ...model, ...images,
        ...(nativeId ? [nativeId] : []), '-'];
      await nativeThreads(nativeOptions.executable, args, nativeOptions, (event) => codexEvent(state, event), prompt, state);
    } finally { if (imageDir) fs.rmSync(imageDir, { recursive: true, force: true }); }
  }

  async function run(harness, id, input, options = {}) {
    const chat = store.session(id);
    if (chat.readOnly) throw new Error('Read-only automations use Pi.');
    if (active.has(id)) throw new Error('This session is already running.');
    const text = redact(input).trim();
    if (!text && !options.attachments?.length && !options.context?.length) throw new Error('Enter a message or attach context.');
    const permission = options.permission ?? chat.permission ?? store.data.harnessDefaults?.[harness]?.permission ?? 'ask';
    if (!['ask', 'auto'].includes(permission)) throw new Error('Choose Auto or Ask.');
    const cwd = fs.realpathSync(chat.cwd);
    usage?.check();
    const attachment = (options.attachments?.length || options.context?.length) ? await prepareAttachments(options.attachments, options.context) : noAttachments;
    const available = await catalog(harness, cwd);
    const requested = options.model || chat.model || store.data.harnessDefaults?.[harness]?.model || available.defaultModel;
    const route = requested === AUTO_MODEL && usage ? usage.choose({ harness, catalog: available, prompt: text, images: attachment.images.length,
      context: attachment.text.reduce((total, entry) => total + entry.length, 0) }) : null;
    const selected = available.models.find((row) => row.id === (route?.model ?? requested));
    if (!selected) throw new Error('That model is not available in ' + labelFor(harness) + '.');
    if (attachment.images.length && !selected.images) throw new Error('This harness or model cannot receive these images. Try another model or remove the image.');
    if (options.signal?.aborted) return { skipped: true };
    if (active.has(id)) throw new Error('This session is already running.');
    options.reportRun?.({ actualHarness: harness, actualModel: selected.id, provider: selected.provider, routing: route?.rule,
      excerpts: attachment.text.map((text, index) => ({ source: attachment.sources[index], text: redact(text) })) });
    const entries = savedEntries(store, id);
    if (!entries.length && chat.title === 'New session') chat.title = (text || attachment.names[0] || 'New session').split('\n')[0].slice(0, 70);
    Object.assign(chat, { model: requested, permission });
    store.update();
    const state = { chat, permission, entries, requests: new Map(), tools: new Map(), usage: {} };
    active.set(id, state);
    const abort = () => stop(id);
    options.signal?.addEventListener('abort', abort, { once: true });
    append(state, { type: 'user', text, attachments: attachment.names, sources: attachment.sources, model: selected.id });
    if (route) append(state, { type: 'status', text: 'Routed to ' + selected.name });
    publish(state, true);
    let failure;
    try {
      const contexts = [memory?.promptContext?.(), team?.context(id), await integrations?.promptContext?.(options.integrations, chat.readOnly)].filter(Boolean);
      const prompt = ['User request:\n' + (text || 'Review the attached context.'), ...attachment.text.map(redact), ...contexts.map(redact)].join('\n\n');
      if (!state.cancelled) {
        const nativeOptions = { ...childOptions(home, cwd), executable: available.executable };
        if (harness === 'hermes' || harness === 'acp') await runAcp(state, harness, selected, nativeOptions, attachment, prompt, options);
        else await runCli(state, harness, selected, nativeOptions, attachment, prompt);
      }
    } catch (error) {
      if (!state.cancelled) {
        failure = redact(error.message).slice(0, 4500);
        append(state, { type: 'error', text: failure });
      }
    } finally {
      options.signal?.removeEventListener('abort', abort);
      clearTimeout(state.publishTimer);
      active.delete(id);
      for (const { resolve } of state.requests.values()) resolve(false);
      if (state.cancelled) append(state, { type: 'status', text: 'Stopped' });
      for (const entry of state.tools.values()) if (entry.status === 'running') entry.status = 'stopped';
      usage?.record({ harness, model: selected.id, provider: selected.provider, usage: state.usage });
      publish(state, true);
      if (!options.runId) store.activity('session', chat.title, state.cancelled ? 'Stopped' : failure?.slice(0, 350) || 'Turn complete', { type: 'session', id });
    }
    return { failure, cancelled: Boolean(state.cancelled), usage: state.usage };
  }

  function decide(id, requestId, allowed) {
    const state = active.get(id);
    const request = state?.requests.get(requestId);
    if (!request || typeof allowed !== 'boolean') return;
    state.requests.delete(requestId);
    request.resolve(allowed);
    publish(state);
  }

  const selected = new Set();
  const agents = new Map(Object.keys(identifiers).map((id) => [id, {
    run: (sessionId, input, options) => run(id, sessionId, input, options),
    transcript, stop, decide, steer: async () => false,
  }]));
  return {
    agents, catalog,
    close() { for (const id of active.keys()) stop(id); },
    handlers: {
      codexUsage,
      pickHarnessExecutable: async (event, harness) => {
        if (!agents.has(harness)) throw new Error('Choose a supported harness.');
        const { dialog, BrowserWindow } = require('electron');
        const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
          title: 'Choose the ' + labelFor(harness) + ' executable', properties: ['openFile'],
        });
        if (result.canceled) return null;
        const filename = fs.realpathSync(result.filePaths[0]);
        if (!fs.statSync(filename).isFile()) throw new Error('Choose an executable file.');
        fs.accessSync(filename, fs.constants.X_OK);
        selected.add(filename);
        return filename;
      },
      setHarnessExecutable: (_, harness, filename) => {
        if (!agents.has(harness) || (filename !== null && !selected.has(filename))) throw new Error('Choose the executable first.');
        if (Array.from(active.values()).some((state) => state.chat.harness === harness)) throw new Error('Stop active turns first.');
        store.data.harnessExecutables = { ...store.data.harnessExecutables, [harness]: filename };
        catalogs.clear();
        store.data.harnessCatalogRevision = (store.data.harnessCatalogRevision || 0) + 1;
        store.update();
      },
      setCustomAcp: (_, input) => {
        if ([...active.values()].some((state) => state.chat.harness === 'acp')) throw new Error('Stop active turns first.');
        const name = typeof input?.name === 'string' ? input.name.trim() : '';
        const args = input?.args;
        if (!name || name.length > 50 || /[\r\n\0]/.test(name) || !Array.isArray(args) || args.length > 24 ||
          !args.every((arg) => typeof arg === 'string' && arg.length > 0 && arg.length <= 500 && !/[\r\n\0]/.test(arg))) {
          throw new Error('Enter a harness name and up to 24 launch arguments, one per line.');
        }
        store.data.customAcp = { name, args };
        catalogs.clear();
        store.data.harnessCatalogRevision = (store.data.harnessCatalogRevision || 0) + 1;
        store.update();
      },
      setNativeModels: (_, harness, models) => {
        if (!['codex', 'claude'].includes(harness) || !Array.isArray(models) || models.length > 30 ||
          !models.every((model) => typeof model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9./_:@+-]{0,180}$/.test(model))) {
          throw new Error('Enter valid model IDs, one per line.');
        }
        store.data.harnessModels = { ...store.data.harnessModels, [harness]: [...new Set(models)] };
        store.data.harnessCatalogRevision = (store.data.harnessCatalogRevision || 0) + 1;
        store.update();
      },
    },
  };
}

module.exports = { createNativeHarnesses };
