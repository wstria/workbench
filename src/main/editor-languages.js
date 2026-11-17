const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { redact } = require('./agent-common');

const languages = {
  '.ts': ['typescript', 'typescript-language-server', ['--stdio']],
  '.mts': ['typescript', 'typescript-language-server', ['--stdio']],
  '.cts': ['typescript', 'typescript-language-server', ['--stdio']],
  '.tsx': ['typescriptreact', 'typescript-language-server', ['--stdio']],
  '.js': ['javascript', 'typescript-language-server', ['--stdio']],
  '.mjs': ['javascript', 'typescript-language-server', ['--stdio']],
  '.cjs': ['javascript', 'typescript-language-server', ['--stdio']],
  '.jsx': ['javascriptreact', 'typescript-language-server', ['--stdio']],
  '.py': ['python', 'pylsp', []],
  '.pyi': ['python', 'pylsp', []],
};
const maxMessage = 12 * 1024 * 1024;
const timeout = 15_000;

function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function stdioConnection(child, receive) {
  let buffer = Buffer.alloc(0);
  let expected;
  let closed = false;
  let sequence = 0;
  const pending = new Map();
  function close(error = new Error('The language server closed.')) {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    child.kill();
  }
  function send(message) {
    if (closed) throw new Error('The language server closed.');
    const body = JSON.stringify({ jsonrpc: '2.0', ...message });
    if (Buffer.byteLength(body) > maxMessage) throw new Error('The language server message is too large.');
    child.stdin.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body, 'utf8');
  }
  function route(message) {
    if (message.method && message.id !== undefined) {
      const result = message.method === 'workspace/configuration' ? (message.params?.items ?? []).map(() => null) : null;
      send({ id: message.id, result });
    } else if (message.method) receive(message);
    else {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) {
        const explanation = typeof message.error.message === 'string' ? redact(message.error.message).slice(0, 340) : '';
        request.reject(new Error(explanation || 'The language server could not complete ' + request.method + '.'));
      }
      else request.resolve(message.result);
    }
  }
  child.on('error', () => close(new Error('Could not start the language server.')));
  child.on('exit', () => close());
  child.stdin.on('error', () => close());
  child.stdout.on('data', (chunk) => {
    if (closed) return;
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (buffer.length) {
        if (expected === undefined) {
          const boundary = buffer.indexOf('\r\n\r\n');
          if (boundary === -1 && buffer.length <= 1024) return;
          const header = buffer.toString('ascii', 0, boundary);
          expected = Number(/^Content-Length:\s*(\d+)\s*$/im.exec(header)?.[1]);
          if (boundary < 0 || !Number.isSafeInteger(expected) || expected <= 0 || expected > maxMessage) throw new Error();
          buffer = buffer.subarray(boundary + 4);
        }
        if (buffer.length < expected) return;
        const message = JSON.parse(buffer.toString('utf8', 0, expected));
        buffer = buffer.subarray(expected);
        expected = undefined;
        route(message);
      }
    } catch {
      close(new Error('The language server sent an invalid response.'));
    }
  });
  return {
    get closed() { return closed; },
    close,
    notify: (method, params) => send({ method, params }),
    request(method, params) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('The language server did not respond to ' + method + '.'));
        }, timeout);
        pending.set(id, { method, resolve, reject, timer });
        try { send({ id, method, params }); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
  };
}

const position = (value) => Number.isSafeInteger(value?.line) && Number.isSafeInteger(value.character) && value.line >= 0 && value.character >= 0;

function createEditorLanguages({ home, publish, authorize, commands = {}, start = spawn }) {
  const clients = new Map();
  const directories = [...String(process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute),
    ...(process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']),
    path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin')];

  function executable(name) {
    if (commands[name]) return commands[name];
    for (const folder of directories) {
      const candidate = path.join(folder, name + (process.platform === 'win32' ? '.exe' : ''));
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return [candidate];
      } catch { /* Try the next installed directory. */ }
    }
    return null;
  }

  function inspect(root, input) {
    const file = authorize(input);
    if (!within(root, file)) throw new Error('Choose the file’s folder from Files before using project intelligence.');
    const language = languages[path.extname(file).toLowerCase()];
    if (!language) throw new Error('This file type has no configured language server.');
    const [languageId, name, args] = language;
    const command = executable(name);
    if (!command) throw new Error('Install ' + name + ' on your local PATH to use language features.');
    return { file, key: root + '\0' + name, uri: pathToFileURL(file).href, languageId, command: [...command, ...args] };
  }

  async function client(root, { key, command }) {
    const previous = clients.get(key);
    if (previous && !previous.rpc.closed) return previous.ready;
    if (clients.size >= 8) {
      const [old, item] = clients.entries().next().value;
      item.rpc.close();
      clients.delete(old);
    }
    const [executable, ...args] = command;
    const env = Object.fromEntries(['HOME', 'USERPROFILE', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot']
      .filter((key) => typeof process.env[key] === 'string').map((key) => [key, process.env[key]]));
    env.PATH = directories.join(path.delimiter);
    const processServer = start(executable, args, { cwd: root, shell: false, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const documents = new Map();
    const rpc = stdioConnection(processServer, ({ method, params }) => {
      if (method !== 'textDocument/publishDiagnostics') return;
      const doc = documents.get(params?.uri);
      if (!doc || Number.isSafeInteger(params.version) && params.version !== doc.version || !Array.isArray(params.diagnostics)) return;
      doc.diagnostics = params.diagnostics.slice(0, 200).filter((item) => position(item?.range?.start) && typeof item.message === 'string')
        .map(({ range, severity, message, source }) => ({ line: range.start.line + 1, column: range.start.character + 1,
          severity: severity === 1 ? 'Error' : severity === 2 ? 'Warning' : 'Information', message: message.slice(0, 1000),
          source: typeof source === 'string' ? source.slice(0, 80) : undefined }));
      publish({ path: doc.file, diagnostics: doc.diagnostics });
    });
    const item = { rpc, documents };
    const rootUri = pathToFileURL(root).href;
    const ready = rpc.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
      capabilities: { workspace: { workspaceFolders: true, configuration: true }, general: { positionEncodings: ['utf-16'] },
        textDocument: { publishDiagnostics: { versionSupport: true }, definition: { linkSupport: true } } } }).then(({ capabilities }) => {
      item.capabilities = capabilities;
      rpc.notify('initialized', {});
      return item;
    }).catch((error) => {
      rpc.close();
      if (clients.get(key) === item) clients.delete(key);
      throw error;
    });
    item.ready = ready;
    clients.set(key, item);
    return ready;
  }

  async function update(root, input, text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('The file is too large for language features.');
    const target = inspect(root, input);
    const state = await client(root, target);
    const { rpc, documents } = state;
    const doc = documents.get(target.uri);
    if (!doc) {
      if (documents.size >= 24) {
        const evicted = documents.keys().next().value;
        rpc.notify('textDocument/didClose', { textDocument: { uri: evicted } });
        documents.delete(evicted);
      }
      const next = { version: 1, text, file: target.file, diagnostics: [] };
      documents.set(target.uri, next);
      rpc.notify('textDocument/didOpen', { textDocument: { uri: target.uri, languageId: target.languageId, version: next.version, text } });
    } else if (doc.text !== text) {
      const lines = doc.text.split(/\r\n|\r|\n/);
      const sync = state.capabilities?.textDocumentSync;
      const incremental = sync === 2 || sync?.change === 2;
      const range = { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1).length } };
      doc.text = text;
      doc.version += 1;
      doc.diagnostics = [];
      rpc.notify('textDocument/didChange', { textDocument: { uri: target.uri, version: doc.version },
        contentChanges: [{ ...(incremental && { range }), text }] });
    }
    return { target, state, diagnostics: documents.get(target.uri).diagnostics };
  }

  return {
    sync: async (...args) => (await update(...args)).diagnostics,
    async closeDocument(root, input) {
      let target;
      try { target = inspect(root, input); } catch { return; }
      const active = clients.get(target.key);
      if (!active || active.rpc.closed) return;
      const state = await active.ready.catch(() => null);
      if (state && !state.rpc.closed && state.documents.delete(target.uri)) {
        state.rpc.notify('textDocument/didClose', { textDocument: { uri: target.uri } });
      }
    },
    async definition(root, input, text, at) {
      if (!position(at)) throw new Error('Place the cursor on a symbol first.');
      const { target, state } = await update(root, input, text);
      if (!state.capabilities?.definitionProvider) throw new Error('This language server did not advertise definition lookup.');
      const result = await state.rpc.request('textDocument/definition', { textDocument: { uri: target.uri }, position: at });
      const locations = Array.isArray(result) ? result : result ? [result] : [];
      return locations.slice(0, 20).flatMap((item) => {
        const start = (item.targetSelectionRange ?? item.range)?.start;
        try {
          if (!position(start)) return [];
          const file = authorize(fileURLToPath(item.targetUri ?? item.uri));
          return within(root, file) ? [{ path: file, line: start.line + 1 }] : [];
        } catch { return []; }
      });
    },
    dispose() {
      for (const { rpc } of clients.values()) rpc.close();
      clients.clear();
    },
  };
}

module.exports = { createEditorLanguages };
