const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');

const textExtensions = new Set(['.md', '.txt', '.csv', '.tsv', '.json', '.html', '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.swift']);
const ignored = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', 'target', 'secrets']);
const maxFileBytes = 256000;
const noArgs = { type: 'object', properties: {}, additionalProperties: false };
const schemas = {
  list_workspace_documents: noArgs,
  find_workspace_text: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 160 } }, required: ['query'], additionalProperties: false },
  read_workspace_document: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['path'], additionalProperties: false },
};
const descriptions = {
  list_workspace_documents: 'List supported documents and source files inside the selected Workbench project.',
  find_workspace_text: 'Find a literal phrase in supported project documents and source files.',
  read_workspace_document: 'Read a text document returned by the Workbench project file list.',
};

function publicName(name) {
  return !name.startsWith('.') && !ignored.has(name.toLowerCase())
    && !/(^|[_. -])(secret|secrets|keychain|credentials?|private[_-]?key|id_rsa)([_. -]|$)/i.test(name);
}

function listFiles(root) {
  const result = [];
  const pending = [root];
  let seen = 0;
  while (pending.length && seen < 200) {
    const folder = pending.pop();
    seen++;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!publicName(entry.name)) continue;
      const location = path.join(folder, entry.name);
      if (entry.isDirectory() && pending.length < 200) pending.push(location);
      if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) result.push(path.relative(root, location));
      if (result.length >= 1000) return result;
    }
  }
  return result;
}

function readText(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('Use a workspace-relative file path.');
  const parts = relative.split(/[\\/]/);
  if (!parts.every(publicName) || parts.includes('..') || !textExtensions.has(path.extname(relative).toLowerCase())) {
    throw new Error('This is not a supported workspace document.');
  }
  const requested = path.resolve(root, ...parts);
  const real = fs.realpathSync(requested);
  if (real !== requested || !real.startsWith(root + path.sep)) throw new Error('Choose a document inside this workspace.');
  const handle = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const info = fs.fstatSync(handle);
    if (!info.isFile() || info.size > maxFileBytes) throw new Error('This file is too large or is not a regular file.');
    return fs.readFileSync(handle, 'utf8');
  } finally {
    fs.closeSync(handle);
  }
}

function dispatch(root, method, args) {
  if (method === 'list_workspace_documents') return listFiles(root).slice(0, 250).join('\n') || 'No supported project documents found.';
  if (method === 'read_workspace_document') return readText(root, args?.path).slice(0, 18000);
  if (method !== 'find_workspace_text') throw new Error('Unknown workspace tool.');
  const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : '';
  if (!query || query.length > 160) throw new Error('Enter a search phrase.');
  const matches = [];
  for (const file of listFiles(root)) {
    let lines;
    try { lines = readText(root, file).split(/\r?\n/); } catch { continue; }
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].toLowerCase().includes(query)) continue;
      matches.push(file + ':' + (index + 1) + ': ' + lines[index].trim().slice(0, 250));
      if (matches.length === 35) return matches.join('\n');
    }
  }
  return matches.join('\n') || 'No matches.';
}

const root = fs.realpathSync(process.argv[2] || process.cwd());
const versions = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28']);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id == null) return;
  let result;
  let error;
  if (request.method === 'initialize') {
    const version = request.params?.protocolVersion;
    result = { protocolVersion: versions.has(version) ? version : '2025-11-25', serverInfo: { name: 'workbench-workspace', version: '1.0.0' }, capabilities: { tools: {} } };
  } else if (request.method === 'ping') result = {};
  else if (request.method === 'tools/list') {
    result = { tools: Object.entries(schemas).map(([name, inputSchema]) => ({
      name, description: descriptions[name], inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    })) };
  } else if (request.method === 'tools/call') {
    try { result = { content: [{ type: 'text', text: dispatch(root, request.params?.name, request.params?.arguments) }] }; }
    catch (cause) { result = { isError: true, content: [{ type: 'text', text: cause.message }] }; }
  } else error = { code: -32601, message: 'Method not found' };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) }) + '\n');
});
