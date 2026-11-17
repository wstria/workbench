const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { openPdf } = require('./pdf');
const { noteData } = require('./knowledge');

const hidden = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'coverage', '__pycache__']);
const excluded = /^(?:id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|(?:credential|secret|private[-_]?key)s?\.[\w-]+)$/i;
const secretTypes = /\.(?:pem|key|p12|pfx|kdbx|jks)$/i;
const textTypes = /\.(?:a?md|markdown|txt|text|rst|adoc|js|jsx|mjs|cjs|ts|tsx|py|rb|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|sh|bash|zsh|fish|ps1|jsonc?|ya?ml|toml|xml|html?|css|scss|sql|csv|tsv|log|ini|conf|properties|vue|svelte)$/i;
const documentLimit = 2200;
const traversalLimit = 14000;
const contentLimit = 24 * 1024 * 1024;
const perTextLimit = 96 * 1024;
const perPdfLimit = 10 * 1024 * 1024;
const pdfLimit = 30;
const pdfPages = 100;

const normal = (value) => typeof value === 'string' ? value.toLowerCase().normalize('NFC') : '';
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const readable = (name) => !name.startsWith('.') && !hidden.has(name.toLowerCase()) && !excluded.test(name) && !secretTypes.test(name);
const isPdf = (file) => /\.pdf$/i.test(file);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function gitIgnored(root, files) {
  if (!files.length) return new Set();
  return new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const git = spawn('git', ['-C', root, 'check-ignore', '-z', '--stdin'], {
      shell: false, env, stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000,
    });
    const chunks = [];
    git.stdout.on('data', (chunk) => chunks.push(chunk));
    git.on('error', () => resolve(new Set()));
    git.stdin.on('error', () => {});
    git.on('close', (code) => resolve(code === 0
      ? new Set(Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean).map((file) => path.join(root, file)))
      : new Set()));
    git.stdin.end(files.join('\0') + '\0');
  });
}

async function fileContents(file, metadata) {
  const limit = isPdf(file) ? perPdfLimit : perTextLimit;
  if (await fs.realpath(file) !== file) return null;
  const descriptor = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await descriptor.stat();
    if (!current.isFile() || current.size > limit || current.ino !== metadata.ino || current.dev !== metadata.dev) return null;
    const limitBytes = Buffer.alloc(current.size);
    const { bytesRead } = await descriptor.read(limitBytes, 0, limitBytes.length, 0);
    return bytesRead === current.size ? limitBytes : null;
  } finally {
    await descriptor.close();
  }
}

async function pdfText(bytes) {
  const task = await openPdf(bytes);
  try {
    const pdf = await task.promise;
    const segments = [];
    let budget = 192000;
    for (let page = 1; page <= Math.min(pdfPages, pdf.numPages) && budget > 0; page++) {
      const layer = await pdf.getPage(page);
      try {
        const content = await layer.getTextContent();
        const text = content.items.map((part) => part.str ?? '').join(' ').replace(/\s+/g, ' ').trim().slice(0, Math.min(9000, budget));
        if (text) segments.push({ text, page });
        budget -= text.length;
      } finally {
        layer.cleanup();
      }
    }
    return segments;
  } finally {
    await task.destroy().catch(() => {});
  }
}

async function extract(file, metadata) {
  if (!isPdf(file) && !textTypes.test(file)) return {};
  const bytes = await fileContents(file, metadata);
  if (!bytes) return {};
  try {
    if (isPdf(file)) return { segments: await pdfText(bytes), fingerprint: sha(bytes) };
    if (bytes.includes(0)) return {};
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const tags = /\.(?:md|markdown)$/i.test(file) ? noteData(content).tags : [];
    return { content, tags, fingerprint: sha(bytes) };
  } catch { return {}; }
}

function words(query) {
  return normal(query).trim().match(/"[^"]+"|[^\s]+/g)?.map((part) => part.replace(/^"|"$/g, '')).filter(Boolean) ?? [];
}

function excerptMatch(text, terms) {
  const normalized = normal(text);
  const match = terms.find((term) => normalized.includes(term));
  const offset = match ? normalized.indexOf(match) : 0;
  const start = Math.max(0, offset - 70);
  const end = Math.min(text.length, start + 420);
  return { excerpt: text.slice(start, end).replace(/\s+/g, ' ').trim(), offset };
}

function resultFor(document, terms) {
  const tags = document.tags ?? [];
  const tagTerms = terms.filter((term) => term.startsWith('#') && term.length > 1).map((term) => term.slice(1));
  if (!tagTerms.every((term) => tags.some((tag) => tag === term || tag.startsWith(term + '/')))) return null;
  const textTerms = terms.filter((term) => !term.startsWith('#'));
  const label = normal([document.name, document.detail, document.notes, ...tags].filter(Boolean).join(' '));
  const content = normal(document.content ?? document.segments?.map((segment) => segment.text).join('\n'));
  if (!textTerms.every((term) => label.includes(term) || content.includes(term))) return null;
  const contentTerms = textTerms.filter((term) => content.includes(term));
  let source = document.source;
  let excerpt = '';
  if (document.segments?.length) {
    const segment = document.segments.reduce((best, row) => {
      const score = contentTerms.filter((term) => normal(row.text).includes(term)).length;
      return score > best.score ? { row, score } : best;
    }, { row: document.segments[0], score: -1 }).row;
    const { text, ...position } = segment;
    excerpt = excerptMatch(text, contentTerms).excerpt;
    source = { ...source, ...position };
  } else if (document.content) {
    const found = excerptMatch(document.content, contentTerms);
    excerpt = found.excerpt;
    if (source.type === 'file' && contentTerms.length) {
      source = { ...source, line: 1 + (document.content.slice(0, found.offset).match(/\n/g)?.length ?? 0) };
    }
  }
  if (document.fingerprint) source = { ...source, fingerprint: document.fingerprint };
  const position = source.page ? 'Page ' + source.page : source.line ? 'Line ' + source.line : '';
  const detail = [document.detail, position].filter(Boolean).join(' · ');
  const score = (textTerms.length && textTerms.every((term) => normal(document.name).includes(term)) ? 7 : 0) +
    contentTerms.length * 2 + (textTerms.every((term) => label.includes(term)) ? 2 : 0);
  return { source: { ...source, tags }, detail, excerpt, group: document.group, score };
}

function createSearchIndex({ store, files, workspaceFolders = () => [] }) {
  const cache = new Map();
  const extracted = new Map();

  async function scan(roots, scoped, paths) {
    const favoriteFile = new Map(store.data.favorites.filter((item) => item.type === 'file').map((item) => [item.path, item]));
    const candidates = new Map();
    const pending = roots.map((root) => ({ root, directory: root }));
    const seenDirs = new Set();
    let entries = 0;
    let limited = false;
    for (const folder of pending) {
      if (seenDirs.has(folder.directory) || await fs.realpath(folder.directory).catch(() => null) !== folder.directory) continue;
      seenDirs.add(folder.directory);
      const handle = await fs.opendir(folder.directory).catch(() => null);
      if (!handle) continue;
      for await (const entry of handle) {
        if (++entries > traversalLimit || candidates.size >= documentLimit) { limited = true; break; }
        if (!readable(entry.name)) continue;
        const currentPath = path.join(folder.directory, entry.name);
        if (entry.isDirectory()) pending.push({ root: folder.root, directory: currentPath });
        else if (entry.isFile() && !candidates.has(currentPath)) candidates.set(currentPath, { detail: path.relative(folder.root, currentPath), root: folder.root });
      }
      if (limited) break;
    }
    for (const item of paths.slice(0, 600)) {
      if (candidates.size >= documentLimit || !readable(path.basename(item.path)) || (scoped && !roots.some((root) => within(root, item.path)))) continue;
      try { const file = files.authorize(item.path); if (!candidates.has(file)) candidates.set(file, { detail: file, root: roots.find((root) => within(root, file)) }); }
      catch { /* Removed files are left out of search. */ }
    }
    const byRoot = new Map();
    for (const [file, { root }] of candidates) {
      if (!root) continue;
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push(path.relative(root, file));
    }
    const ignored = new Set((await Promise.all([...byRoot].map(([root, files]) => gitIgnored(root, files)))).flatMap((set) => [...set]));
    const rows = [];
    let bytes = 0;
    let pdfCount = 0;
    for (const [file, { detail }] of candidates) {
      if (ignored.has(file)) continue;
      const metadata = await fs.lstat(file).catch(() => null);
      if (!metadata?.isFile() || await fs.realpath(file).catch(() => null) !== file) continue;
      const stamp = [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(':');
      let parsed = {};
      if (bytes < contentLimit && (isPdf(file) ? ++pdfCount <= pdfLimit : textTypes.test(file))) {
        let entry = extracted.get(file);
        if (entry?.stamp !== stamp) {
          entry = { stamp, value: await extract(file, metadata).catch(() => ({})) };
          extracted.set(file, entry);
          if (extracted.size > 400) extracted.delete(extracted.keys().next().value);
        }
        parsed = entry.value;
        bytes += (parsed.content?.length ?? parsed.segments?.reduce((size, row) => size + row.text.length, 0) ?? 0) * 2;
      }
      const name = path.basename(file);
      const favorite = favoriteFile.get(file);
      rows.push({ ...parsed, name, detail, notes: favorite?.notes, tags: [...new Set([...(parsed.tags ?? []), ...(favorite?.tags ?? [])])],
        group: isPdf(file) ? 'PDF' : 'Files', source: { type: 'file', name, path: file } });
    }
    return { rows, limited: limited || bytes >= contentLimit || pdfCount > pdfLimit };
  }

  function filesFor(roots, scoped, rebuild) {
    const paths = [...store.data.artifacts, ...store.data.favorites.filter((item) => item.type === 'file')];
    const key = JSON.stringify([scoped, roots]);
    const previous = cache.get(key);
    if (!rebuild && previous && (previous.at === null || Date.now() - previous.at < 2500)) return previous.result;
    const next = { at: null };
    next.result = scan(roots, scoped, paths).then((result) => { next.at = Date.now(); return result; }, (error) => {
      if (cache.get(key) === next) cache.delete(key);
      throw error;
    });
    cache.set(key, next);
    if (cache.size > 4) cache.delete(cache.keys().next().value);
    return next.result;
  }

  async function search(input = {}) {
    const query = typeof input.query === 'string' ? input.query.slice(0, 240) : '';
    if (!query.trim()) return { items: [], limited: false };
    const scoped = typeof input.cwd === 'string' && Boolean(input.cwd);
    const roots = [...new Set((scoped ? [input.cwd] : [...workspaceFolders(), store.data.cwd, store.folders.artifacts,
      ...store.data.openFolders, ...(store.data.knowledgeVaults ?? []).map((vault) => vault.path),
      ...store.data.sessions.slice(0, 20).filter((session) => !session.isolation).map((session) => session.cwd)]).filter(Boolean)
      .flatMap((candidate) => { try { return [files.authorize(candidate)]; } catch { return []; } }))].slice(0, 20);
    const { rows, limited } = await filesFor(roots, scoped, input.rebuild === true);
    const documents = [...rows];
    const favorites = new Map(store.data.favorites.filter((item) => item.type === 'web').map((item) => [item.url, item]));
    const shared = !scoped || input.includeShared === true;
    for (const saved of shared ? (store.data.webCaptures ?? []).slice(0, 160) : []) {
      const { captureId, url, name, excerpt } = saved;
      documents.push({ name, detail: url, content: excerpt, tags: favorites.get(url)?.tags, notes: favorites.get(url)?.notes, group: 'Saved web',
        source: { type: 'web', name, url, captureId } });
    }
    for (const favorite of shared ? favorites.values() : []) {
      if (!documents.some((entry) => entry.source.url === favorite.url)) documents.push({
        ...favorite, detail: favorite.url, group: 'Bookmarks', source: { type: 'web', url: favorite.url, name: favorite.name },
      });
    }
    for (const session of store.data.sessions.slice(0, 80)) {
      if (scoped && !roots.some((root) => within(root, session.cwd))) continue;
      let transcript;
      try { transcript = store.transcript(session.id); } catch { continue; }
      const segments = transcript.filter((entry) => entry.type === 'user' || entry.type === 'assistant').slice(-28).reverse()
        .filter((entry) => typeof entry.text === 'string').map((entry) => ({ text: entry.text.slice(0, 2200), messageId: entry.id }));
      documents.push({ name: session.title, detail: session.cwd, segments, group: 'Chats', source: { type: 'session', id: session.id, name: session.title } });
    }
    const terms = words(query);
    const limit = Number.isSafeInteger(input.limit) ? Math.min(60, Math.max(1, input.limit)) : 30;
    const results = documents.map((row) => resultFor(row, terms)).filter(Boolean)
      .sort((a, b) => b.score - a.score || a.source.name.localeCompare(b.source.name));
    return { items: results.slice(0, limit).map(({ score, ...item }) => item), limited: limited || results.length > limit };
  }

  return {
    search,
    invalidate() { cache.clear(); },
    save(input) {
      const query = typeof input?.query === 'string' ? input.query.trim().slice(0, 240) : '';
      if (!query) throw new Error('Enter a search to save.');
      const cwd = input.cwd ? files.authorize(input.cwd) : undefined;
      const previous = store.data.savedSearches ?? [];
      const saved = previous.find((item) => item.query === query && item.cwd === cwd) ?? { id: randomUUID(), query, cwd };
      store.data.savedSearches = [saved, ...previous.filter((item) => item.id !== saved.id)].slice(0, 30);
      store.update();
      return saved;
    },
    remove(id) {
      store.data.savedSearches = (store.data.savedSearches ?? []).filter((item) => item.id !== id);
      store.update();
    },
    async relink(source, chosen) {
      if (source?.type !== 'file' || typeof source.path !== 'string' || !/^[a-f\d]{64}$/.test(source.fingerprint ?? '')) {
        throw new Error('Only an indexed file can be relinked.');
      }
      const file = await fs.realpath(chosen);
      const metadata = await fs.lstat(file);
      if (!metadata.isFile() || !readable(path.basename(file)) || (!isPdf(file) && !textTypes.test(file)) ||
        (await fileContents(file, metadata).then((bytes) => bytes && sha(bytes))) !== source.fingerprint) {
        throw new Error('The selected file does not match the original indexed content.');
      }
      const registered = files.register(file);
      const aliases = store.data.sourceAliases ?? {};
      store.data.sourceAliases = { ...aliases, [source.path + ':' + source.fingerprint]: registered.path };
      store.update();
      cache.clear();
      return registered;
    },
  };
}

module.exports = { createSearchIndex, resultFor };
