const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createInterface } = require('node:readline');

function findExecutable(override, home) {
  const name = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const candidates = override ? [override] : [
    ...String(process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute).map((folder) => path.join(folder, name)),
    path.join(home, '.local', 'bin', name), path.join(home, '.opencode', 'bin', name),
    path.join(home, '.bun', 'bin', name), '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode',
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* Try the next installation. */ }
  }
  throw new Error(override ? 'The selected OpenCode executable is unavailable. Choose it again in Settings.'
    : 'OpenCode was not found. Install OpenCode 2.3+ or choose its executable in Settings.');
}

async function* readEvents(response) {
  let data = [];
  let partial = '';
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop();
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      if (!line && data.length) {
        const value = JSON.parse(data.join('\n'));
        data = [];
        yield typeof value === 'string' ? JSON.parse(value) : value;
      }
    }
  }
}

function createOpenCodeClient(store, home) {
  let server;
  const catalogs = new Map();

  function connect() {
    if (server) return server.ready;
    const executable = findExecutable(store.data.opencodePath, home);
    const password = randomBytes(32).toString('hex');
    const child = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd: store.data.cwd, env: { ...process.env, OPENCODE_PASSWORD: password },
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    const owner = { child };
    server = owner;
    const forget = () => {
      if (server === owner) { server = undefined; catalogs.clear(); }
    };
    child.once('error', forget);
    child.once('exit', forget);
    owner.ready = new Promise((resolve, reject) => {
      const stdout = createInterface({ input: child.stdout });
      const timer = setTimeout(() => fail(new Error('OpenCode did not start within 15 seconds. Check the executable in Settings.')), 15000);
      function cleanup() {
        clearTimeout(timer);
        stdout.close();
        child.stdout.resume();
        child.off('error', fail);
        child.off('exit', exited);
      }
      function fail(error) { cleanup(); forget(); child.kill(); reject(error); }
      function exited() { fail(new Error('OpenCode exited during startup. Check the executable in Settings.')); }
      child.once('error', fail);
      child.once('exit', exited);
      stdout.on('line', (line) => {
        const match = line.match(/server listening on http:\/\/127\.0\.0\.1:(\d{1,5})\s*$/);
        if (!match) return;
        cleanup();
        resolve('http://127.0.0.1:' + match[1]);
      });
    }).then(async (base) => {
      const authorization = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
      async function fetchLocal(route, { method = 'GET', body, signal = AbortSignal.timeout(15000) } = {}) {
        const response = await fetch(base + route, {
          method, signal, redirect: 'error',
          headers: { Authorization: authorization, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (!response.ok) {
          const detail = await response.json().catch(() => null);
          const error = new Error(typeof detail?.message === 'string' ? detail.message : 'OpenCode request failed (' + response.status + ').');
          error.status = response.status;
          throw error;
        }
        return response;
      }
      const request = async (route, options) => {
        const response = await fetchLocal(route, options);
        return response.status === 204 ? null : response.json();
      };
      const info = await request('/api/info');
      const version = String(info.version ?? '');
      const [major, minor] = version.split('.').map(Number);
      if (major !== 2 || minor < 3 || info.pid !== child.pid) throw new Error('Workbench needs a local OpenCode 2.3 or newer 2.x executable.');
      return { executable, version, request, events: async (signal) => readEvents(await fetchLocal('/api/event', { signal })) };
    }).catch((error) => { forget(); child.kill(); throw error; });
    return owner.ready;
  }

  async function catalog(cwd, refresh = false) {
    const client = await connect();
    const existing = catalogs.get(cwd);
    if (!refresh && existing && existing.expires > Date.now()) return existing.result;
    const query = '?' + new URLSearchParams({ 'location[directory]': cwd });
    const result = Promise.all([
      client.request('/api/model' + query), client.request('/api/model/default' + query), client.request('/api/provider' + query),
    ]).then(([all, preferred, providers]) => {
      if (all.location?.directory !== cwd) throw new Error('OpenCode could not load the model catalog for this workspace.');
      const providerNames = new Map(providers.data.map(({ id, name }) => [id, name]));
      const modelKey = (row) => `${row.providerID}/${row.id}`;
      const models = all.data.filter((model) => model.enabled !== false && model.status !== 'deprecated')
        .map((model) => ({ id: modelKey(model), providerID: model.providerID, modelID: model.id, name: model.name || model.id,
          provider: providerNames.get(model.providerID) || model.providerID, images: model.capabilities?.input?.includes('image') ?? false, contextWindow: model.limit?.context }))
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
      const preferredId = preferred.data ? modelKey(preferred.data) : undefined;
      const defaultModel = models.find((model) => model.id === preferredId)?.id ?? models[0]?.id ?? '';
      return { models, defaultModel, version: client.version, executable: client.executable };
    }).catch((error) => {
      if (catalogs.get(cwd)?.result === result) catalogs.delete(cwd);
      throw error;
    });
    catalogs.set(cwd, { result, expires: Date.now() + 30000 });
    return result;
  }

  return {
    connect, catalog,
    async usageLimits(cwd) {
      const client = await connect();
      const query = new URLSearchParams({ 'location[directory]': cwd });
      const response = await client.request('/api/experimental/usage/limits?' + query);
      return response?.data ?? null;
    },
    close() {
      const previous = server;
      server = undefined;
      catalogs.clear();
      previous?.child.kill();
    },
  };
}

module.exports = { createOpenCodeClient };
