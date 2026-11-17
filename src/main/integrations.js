const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { atomicWrite } = require('./store');
const { redact } = require('./agent-common');

const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const integrationId = /^[a-z0-9-]{1,80}$/;
const maxSkill = 48000;
const maxEntries = 128;
const workspaceServer = 'workbench-files';

const catalog = [
  { id: workspaceServer, kind: 'mcp', name: 'Workspace documents', description: 'List, search, and read text in the selected workspace.', transport: 'builtin', enabled: true, allowAutomation: true },
  { id: 'context7', kind: 'mcp', name: 'Context7', description: 'Look up public library documentation and current code examples.', transport: 'http', url: 'https://mcp.context7.com/mcp', credentialHint: 'Optional Context7 API key', credentialHeader: 'CONTEXT7_API_KEY', reference: 'https://github.com/upstash/context7', allowAutomation: true },
  { id: 'github-readonly', kind: 'mcp', name: 'GitHub read-only', description: 'Read repositories, issues, and pull requests with a GitHub token you supply.', transport: 'http', url: 'https://api.githubcopilot.com/mcp/readonly', credentialHint: 'GitHub personal access token', requiresCredential: true, reference: 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md', allowAutomation: true },
  { id: 'gmail-readonly', kind: 'mcp', name: 'Gmail read-only', description: 'Search inbox threads and read messages through Google’s Developer Preview MCP.',
    transport: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1', credentialHint: 'Google OAuth access token',
    setupHint: 'Requires the Workspace Developer Preview and an agent-enabled OAuth client. Use the gmail.readonly scope and replace the token when it expires.',
    requiresCredential: true, reference: 'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server',
    allowAutomation: true, allowedTools: ['get_message', 'get_thread', 'list_labels', 'search_threads'] },
  { id: 'email-triage', kind: 'skill', name: 'email-triage', description: 'Prioritize an inbox snapshot or collection of attached messages for review.', body: [
    'Use when the user asks to triage email. Start with messages attached to the current request or an explicitly enabled read-only mail connection.',
    'Sort into needs a reply, needs a decision, follow up, and reference. For each actionable thread give the sender, subject, concrete ask, deadline if known, and a source link if available.',
    'Distinguish facts in the message from your interpretation. Include draft replies only when requested. Leave mailbox state and external communication to the user.',
  ].join('\n\n') },
  { id: 'research-brief', kind: 'skill', name: 'research-brief', description: 'Turn supplied documents and available sources into a concise cited brief.', body: [
    'Identify the decision or question the brief needs to answer. Use supplied material first and record which source supports each meaningful claim.',
    'Prefer primary evidence. Name disagreements, gaps, and dates that affect the result. Finish with the decision or next action the available evidence supports.',
  ].join('\n\n') },
  { id: 'meeting-follow-up', kind: 'skill', name: 'meeting-follow-up', description: 'Pull decisions, action items, and open questions from a meeting transcript.', body: [
    'Separate decisions, actions, and open questions. Use explicit people and dates only when the source states them; identify missing owners or deadlines.',
    'Keep each action short and give the source timestamp or section when available. Keep proposed follow-up text as draft copy.',
  ].join('\n\n') },
  { id: 'workspace-review', kind: 'skill', name: 'workspace-review', description: 'Map a project from its files and report the next useful task.', body: [
    'Inspect the README and relevant project files for the task. Identify the entry points, build or test command, and conventions in use before suggesting changes.',
    'Record concrete evidence with paths. Separate verified behavior, missing evidence, and steps that need to be run.',
  ].join('\n\n') },
];

function field(value, maximum, label, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || (required && !value.trim())) {
    throw new Error('Enter a valid ' + label + '.');
  }
  return value.trim();
}

function streamableUrl(value) {
  const url = URL.parse(field(value, 3000, 'MCP URL', true));
  const local = url && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!url || (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.hash || url.search) {
    throw new Error('Enter an HTTPS URL or a local HTTP URL. Put credentials in the connection fields.');
  }
  return url.href;
}

function secretsMap(value, kind) {
  if (!value) return {};
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 30) throw new Error('Enter up to 30 key–value pairs.');
  return Object.fromEntries(Object.entries(value).map(([key, secret]) => {
    const pattern = kind === 'http' ? /^[A-Za-z0-9_-]{1,80}$/ : /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;
    if (!pattern.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)
      || typeof secret !== 'string' || !secret || secret.length > 5000 || /[\r\n\u0000]/.test(secret)) {
      throw new Error('Enter valid names and values for the connection.');
    }
    return [key, secret];
  }));
}

function skillDocument(name, description, body) {
  return ['---', 'name: ' + name, 'description: ' + JSON.stringify(description), '---', '', body, ''].join('\n');
}

function redactIntegration(value, secrets = {}) {
  let message = redact(value);
  const values = Object.values(secrets);
  const tokens = values.filter((value) => /^bearer\s+/i.test(value)).map((value) => value.replace(/^bearer\s+/i, ''));
  for (const secret of [...values, ...tokens]) {
    if (secret) message = message.split(secret).join('[saved credential]');
  }
  return message;
}

function clientError(error, row, secrets) {
  if ([401, 403].includes(error.status)) return new Error('Authentication failed for ' + row.name + '. Check the connection credentials.');
  const message = redactIntegration(error.message || error, secrets).slice(0, 600);
  return new Error(message || 'Could not connect to ' + row.name + '.');
}

function commandEnvironment() {
  const env = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'USERPROFILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join(os.homedir(), '.local', 'bin')]
    .filter(Boolean).join(path.delimiter);
  return env;
}

function createIntegrations({ store, safeStorage }) {
  const root = path.join(store.root, 'integrations');
  const skillRoot = path.join(root, 'skills');
  fs.mkdirSync(skillRoot, { recursive: true, mode: 0o700 });

  const changes = () => store.data.integrations ?? {};
  const all = () => [
    ...catalog.map((row) => ({ ...row, enabled: row.enabled === true, ...changes()[row.id], builtin: true })),
    ...Object.values(changes()).filter((row) => !catalog.some(({ id }) => id === row.id)),
  ];
  const find = (id) => all().find((row) => row.id === id);
  const get = (id) => {
    const row = find(id);
    if (!row) throw new Error('This integration is no longer available.');
    return row;
  };
  const activeClients = new Set();

  const skillPath = (row) => row.importedPath || path.join(skillRoot, row.name, 'SKILL.md');
  const keychain = (id) => path.join(root, id + '.keychain');
  const hasSecrets = (id) => integrationId.test(id) && fs.existsSync(keychain(id));

  function materializeSkill(row) {
    if (row.importedPath) return row.importedPath;
    const filename = skillPath(row);
    const document = skillDocument(row.name, row.description, row.body);
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(filename)) atomicWrite(filename, document);
    return filename;
  }

  function secretValues(row) {
    if (!hasSecrets(row.id)) return {};
    try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(keychain(row.id)))); }
    catch { throw new Error('The saved credentials for ' + row.name + ' could not be unlocked. Re-enter them in Integrations.'); }
  }

  function writeSecrets(id, values) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('System credential storage is unavailable.');
    atomicWrite(keychain(id), safeStorage.encryptString(JSON.stringify(values)));
  }

  function list() {
    return all().map((row) => ({
      ...row, availableForAutomation: row.kind === 'skill' || (row.kind === 'mcp' && row.allowAutomation === true),
      hasSecrets: row.kind === 'mcp' && hasSecrets(row.id),
    }));
  }

  function persist(row) {
    store.data.integrations = { ...changes(), [row.id]: row };
    store.update();
    return row.id;
  }

  function save(input) {
    if (!input || typeof input !== 'object') throw new Error('Choose an integration type.');
    const previous = input.id ? get(input.id) : undefined;
    if (!previous && Object.keys(changes()).length >= maxEntries) throw new Error('Remove an integration before adding more.');
    const id = previous?.id ?? randomUUID();
    const kind = previous?.kind ?? input.kind;
    const base = catalog.find((row) => row.id === id);
    if (kind === 'extension') throw new Error('Use Import Pi extension to add a local source file.');
    if (kind === 'skill') {
      if (base) throw new Error('Create a new skill to customize its instructions.');
      const name = field(input.name, 64, 'skill name', true);
      if (!skillName.test(name)) throw new Error('Use lowercase letters, digits, and single hyphens for the skill name.');
      if (all().some((row) => row.kind === 'skill' && row.name === name && row.id !== id)) throw new Error('A skill with that name already exists.');
      const row = { id, kind, name, enabled: input.enabled !== false, description: field(input.description, 1024, 'description', true),
        body: field(input.body, maxSkill, 'skill instructions', true) };
      const filename = skillPath(row);
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      atomicWrite(filename, skillDocument(row.name, row.description, row.body));
      persist(row);
      return id;
    }
    if (kind !== 'mcp') throw new Error('Choose an integration type.');
    const transport = base?.transport ?? input.transport;
    if (transport === 'builtin') return persist({ id, enabled: input.enabled !== false });
    if (!['http', 'stdio'].includes(transport)) throw new Error('Choose a connection type.');
    const row = { id, kind, transport, name: base?.name ?? field(input.name, 80, 'name', true),
      description: base?.description ?? field(input.description, 400, 'description'), enabled: input.enabled !== false,
      allowAutomation: base?.allowAutomation === true || input.allowAutomation === true };
    if (transport === 'http') row.url = base?.url ?? streamableUrl(input.url);
    else {
      row.command = field(input.command, 600, 'command', true);
      if (!Array.isArray(input.args) || input.args.length > 40) throw new Error('Enter up to 40 command arguments, one per line.');
      row.args = input.args.map((arg) => field(arg, 2000, 'command argument', true));
    }
    const values = secretsMap(input.secrets, transport);
    const token = field(input.token, 5000, 'API token');
    if (token) {
      if (transport !== 'http' || /[\r\n]/.test(token)) throw new Error('Enter a single-line HTTP token.');
      values[base?.credentialHeader ?? 'Authorization'] = base?.credentialHeader ? token : 'Bearer ' + token;
    }
    const moved = previous && !base && (previous.transport !== transport || previous.url !== row.url || previous.command !== row.command
      || JSON.stringify(previous.args) !== JSON.stringify(row.args));
    if (row.enabled && base?.requiresCredential && !Object.keys(values).length && (!hasSecrets(id) || input.clearSecrets)) {
      throw new Error('Enter a token to enable ' + row.name + '.');
    }
    if (Object.keys(values).length) writeSecrets(id, values);
    else if (input.clearSecrets || moved) fs.rmSync(keychain(id), { force: true });
    persist(base ? { id, enabled: row.enabled } : row);
    return id;
  }

  function setEnabled(id, enabled) {
    const row = get(id);
    if (enabled === true && row.requiresCredential && !hasSecrets(id)) throw new Error('Open this integration and enter its token first.');
    return persist(row.builtin ? { id, enabled: enabled === true } : { ...row, enabled: enabled === true });
  }

  function remove(id) {
    const row = get(id);
    if (row.builtin) throw new Error('Built-in integrations can be turned off.');
    const next = { ...changes() };
    delete next[id];
    store.data.integrations = next;
    store.update();
    fs.rmSync(keychain(id), { force: true });
  }

  async function importSkill(input) {
    if (typeof input !== 'string') throw new Error('Choose a SKILL.md file.');
    const selected = fs.realpathSync(input);
    const info = fs.statSync(selected);
    if (path.basename(selected).toLowerCase() !== 'skill.md' || !info.isFile() || info.size > maxSkill) {
      throw new Error('Choose a SKILL.md file smaller than 48 KB.');
    }
    if (Object.keys(changes()).length >= maxEntries) throw new Error('Remove an integration before adding more.');
    const { parseFrontmatter } = await import('@earendil-works/pi-coding-agent');
    const parsed = parseFrontmatter(fs.readFileSync(selected, 'utf8'));
    const name = field(parsed.frontmatter?.name, 64, 'skill name', true);
    if (!skillName.test(name)) throw new Error('Use a lowercase, hyphenated name in the skill’s YAML header.');
    if (all().some((row) => row.kind === 'skill' && row.name === name)) throw new Error('A skill with that name already exists.');
    return persist({ id: randomUUID(), kind: 'skill', name, description: field(parsed.frontmatter.description, 1024, 'description', true),
      body: field(parsed.body, maxSkill, 'skill instructions', true), importedPath: selected, enabled: false });
  }

  function importExtension(input) {
    if (typeof input !== 'string') throw new Error('Choose a Pi extension file.');
    const selected = fs.realpathSync(input);
    if (!['.js', '.mjs', '.cjs', '.ts'].includes(path.extname(selected)) || !fs.statSync(selected).isFile()) {
      throw new Error('Choose a JavaScript or TypeScript Pi extension.');
    }
    if (all().some((row) => row.extensionPath === selected)) throw new Error('That extension is already installed.');
    if (Object.keys(changes()).length >= maxEntries) throw new Error('Remove an integration before adding more.');
    return persist({ id: randomUUID(), kind: 'extension', name: path.basename(selected), description: 'Local Pi extension',
      extensionPath: selected, enabled: false });
  }

  function selectedRows(selection, readOnly = false) {
    const includes = Array.isArray(selection) ? new Set(selection) : null;
    return all().filter((row) => row.enabled && (!includes || includes.has(row.id)) &&
      (!readOnly || (row.kind === 'skill' || row.allowAutomation === true)));
  }

  function configuration(row, cwd) {
    const values = secretValues(row);
    if (row.transport === 'http') return { type: 'remote', url: row.url, headers: values, oauth: false, codemode: false };
    const env = { ...commandEnvironment(), ...values };
    if (row.id === workspaceServer) {
      if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
      return { type: 'local', command: [process.execPath, path.join(__dirname, 'workspace-mcp.js'), cwd], cwd, environment: env, codemode: false };
    }
    return { type: 'local', command: [row.command, ...row.args], cwd, environment: env, codemode: false };
  }

  async function connect(row, cwd) {
    const mcp = await import('@earendil-works/pi-mcp');
    const config = configuration(row, cwd);
    const transport = config.type === 'local'
      ? new mcp.StdioTransport({ command: config.command[0], args: config.command.slice(1), cwd, env: config.environment, inheritEnv: false })
      : new mcp.StreamableHttpTransport({ url: config.url, headers: config.headers, openGetStream: false,
        fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }) });
    const client = new mcp.McpClient({ name: 'Workbench', version: '1.0.0', requestTimeoutMs: 15000 });
    activeClients.add(client);
    client.onClose(() => activeClients.delete(client));
    try { await client.connect(transport); return client; }
    catch (error) { await client.close().catch(() => {}); throw clientError(error, row, secretValues(row)); }
  }

  function visibleTools(row, tools, readOnly) {
    if (row.allowedTools) return tools.filter((tool) => row.allowedTools.includes(tool.name));
    if (readOnly) return tools.filter((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true);
    return tools;
  }

  async function inspect(id) {
    const row = get(id);
    if (row.kind !== 'mcp') throw new Error('Only MCP servers have a tool catalog.');
    const client = await connect(row, store.data.cwd);
    try {
      const values = secretValues(row);
      const tools = visibleTools(row, await client.listTools(), false).slice(0, 250).map((tool) => ({
        name: redactIntegration(tool.name, values), description: redactIntegration(tool.description, values),
        readOnly: Boolean(row.allowedTools) || tool.annotations?.readOnlyHint === true,
      }));
      return { name: client.serverInfo?.name || row.name, tools };
    } catch (error) { throw clientError(error, row, secretValues(row)); }
    finally { await client.close().catch(() => {}); }
  }

  function piBindings({ cwd, selection, readOnly, signal }) {
    const rows = selectedRows(selection, readOnly);
    const servers = rows.filter((row) => row.kind === 'mcp');
    const additionalSkillPaths = rows.filter((row) => row.kind === 'skill').map(materializeSkill);
    const additionalExtensionPaths = rows.filter((row) => row.kind === 'extension').map((row) => row.extensionPath);
    const clients = new Map();
    async function lookup(row) {
      if (!clients.has(row.id)) clients.set(row.id, connect(row, cwd).catch((error) => { clients.delete(row.id); throw error; }));
      return clients.get(row.id);
    }
    const list = servers.map((row) => row.name + ' [' + row.id + ']').join(', ');
    const customTools = servers.length ? [{
      name: 'workbench_mcp',
      label: 'Workbench integration',
      description: 'Discover and use enabled MCP tools. Use operation list first to see tool names and argument schemas. Available servers: ' + list,
      parameters: {
        type: 'object', properties: { server: { type: 'string' }, operation: { type: 'string', enum: ['list', 'call'] },
          tool: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } },
        required: ['server', 'operation'], additionalProperties: false,
      },
      executionMode: 'sequential',
      async execute(_, args, callSignal) {
        const row = servers.find((item) => item.id === args.server);
        if (!row || !get(row.id).enabled) throw new Error('Choose an enabled integration for this turn.');
        const client = await lookup(row);
        const activeSignal = signal && callSignal ? AbortSignal.any([signal, callSignal]) : signal ?? callSignal;
        try {
          const secrets = secretValues(row);
          const declared = await client.listTools({ signal: activeSignal });
          const allowed = visibleTools(row, declared, readOnly);
          if (args.operation === 'list') {
            const result = allowed.slice(0, 50).map(({ name, description, inputSchema }) => ({ name, description: redactIntegration(description, secrets), inputSchema }));
            return { content: [{ type: 'text', text: redactIntegration(JSON.stringify(result), secrets).slice(0, 22000) }], details: {} };
          }
          if (!allowed.some((item) => item.name === args.tool)) throw new Error('Choose an available tool from the server catalog.');
          const result = await client.callTool(args.tool, args.arguments ?? {}, { signal: activeSignal });
          if (result.isError) throw new Error(result.content.find((item) => item.type === 'text')?.text || 'The integration reported a tool error.');
          const { toLlmContent } = await import('@earendil-works/pi-mcp');
          const content = toLlmContent(result).slice(0, 15).filter((item) => item.type !== 'image' || item.data.length <= 1500000)
            .map((item) => item.type === 'text' ? { ...item, text: redactIntegration(item.text, secrets).slice(0, 15000) } : item);
          return { content, details: {} };
        } catch (error) { throw clientError(error, row, secretValues(row)); }
      },
    }] : [];
    return { additionalSkillPaths, additionalExtensionPaths, customTools,
      close: () => Promise.allSettled([...clients.values()].map(async (pending) => (await pending).close())) };
  }

  function promptContext(selection, readOnly = false) {
    const rows = selectedRows(selection, readOnly).filter((row) => row.kind === 'skill');
    return rows.map((row) => {
      const instructions = row.importedPath ? 'Open ' + row.importedPath + ' if the task needs the original skill or its resources.\n' : '';
      return '## ' + row.name + '\n' + row.description + '\n\n' + instructions + row.body.slice(0, 5500);
    }).join('\n\n').slice(0, 18000);
  }

  function acpServers(selection, cwd, readOnly = false) {
    const entries = (input) => Object.entries(input).map(([name, value]) => ({ name, value }));
    return selectedRows(selection, readOnly).filter((row) => row.kind === 'mcp' && !row.allowedTools).map((row) => {
      const config = configuration(row, cwd ?? store.data.cwd);
      if (config.type === 'local') {
        const [command, ...args] = config.command;
        return { name: row.id, type: 'stdio', command, args, env: entries(config.environment) };
      }
      return { name: row.id, type: 'http', url: config.url, headers: entries(config.headers) };
    });
  }

  async function openCodeBindings({ api, cwd, selection, mode, readOnly }) {
    const chosen = selectedRows(selection, readOnly).filter((row) => row.kind === 'mcp');
    const registered = [];
    const credentials = [];
    const group = 'wbm_' + randomUUID().slice(0, 8) + '_';
    const location = '?' + new URLSearchParams({ 'location[directory]': cwd });
    async function close() {
      await Promise.allSettled(registered.map(({ route }) => api.request(route, { method: 'DELETE', signal: AbortSignal.timeout(3000) })));
    }
    try {
      for (const [index, row] of chosen.entries()) {
        const name = group + index;
        const route = '/api/experimental/mcp/' + name + location;
        const config = configuration(row, cwd);
        credentials.push(...Object.values(secretValues(row)));
        await api.request(route, { method: 'PUT', body: { config } });
        registered.push({ route, name, allowedTools: row.allowedTools });
      }
    } catch (error) { await close(); throw new Error('Could not connect a Workbench integration in OpenCode. Test the connection in Integrations.'); }
    const rules = [
      { action: 'wbm_*', resource: '*', effect: 'deny' },
      ...['opencode_list_mcp_resources', 'opencode_read_mcp_resource'].map((action) => ({ action, resource: 'wbm_*', effect: 'deny' })),
      ...registered.flatMap(({ name, allowedTools }) => (allowedTools ?? ['*'])
        .map((tool) => ({ action: name + '_' + tool, resource: '*', effect: mode === 'auto' ? 'allow' : 'ask' }))),
    ];
    return { rules, prompt: promptContext(selection, readOnly), clean: (value) => redactIntegration(value, credentials), close };
  }

  return { list, save, setEnabled, remove, inspect, importSkill, importExtension, piBindings, openCodeBindings, acpServers, promptContext,
    close: () => Promise.allSettled([...activeClients].map((client) => client.close())) };
}

module.exports = { createIntegrations };
