const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseDocument } = require('yaml');

const markdown = /\.(md|markdown)$/i;
const knownFiles = /\.(pdf|txt|rtf|docx?|pptx?|xlsx?|csv|tsv|json|ya?ml|toml|xml|png|jpe?g|gif|svg|webp|avif|mp3|m4a|wav|mp4|webm|mov|canvas)$/i;
const ignored = new Set(['node_modules', 'dist', 'build', 'vendor']);
const MAX_VAULTS = 12;
const MAX_ITEMS = 1800;
const MAX_ENTRIES = 15000;
const MAX_COMBINED = 4000;
const MAX_FILE_BYTES = 96 * 1024;
const MAX_TEXT = 16 * 1024;
const cacheLifetime = 4000;

const normalized = (value) => value.normalize('NFC').toLowerCase();
const relativeKey = (value) => normalized(value.replaceAll('\\', '/').replace(/\.(md|markdown)$/i, ''));
const visiblePath = (file) => file.split(path.sep).every((part) => !part.startsWith('.') && !ignored.has(part));

function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function tagName(input) {
  if (typeof input !== 'string') return '';
  return normalized(input.trim().replace(/^#/, '')).slice(0, 60);
}

function removeCode(text) {
  return text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, '')
    .replace(/`+[^`\n]+`+/g, '');
}

function noteData(text) {
  const frontMatter = /^(?:\uFEFF)?---\s*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  const fields = frontMatter && frontMatter[1].length < 16000 ? readFields(frontMatter[1]) : {};
  const body = removeCode(frontMatter ? text.slice(frontMatter[0].length) : text);
  const inlineTags = [...body.matchAll(/(?:^|[\s(])#([\p{L}\p{N}\p{Extended_Pictographic}_/-]{1,60})(?![\p{L}\p{N}_/-])/gu)]
    .map((match) => match[1]);
  const tags = [...new Set([...(fields.tags ?? []), ...inlineTags].map(tagName).filter((tag) => tag && !/^\d+$/.test(tag)))].slice(0, 30);
  const wiki = [...body.matchAll(/(?<!\\)\[\[([^\]\n#|]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]+)?\]\]/g)]
    .map((match) => ({ target: match[1].trim(), kind: 'wiki' }));
  const md = [...body.matchAll(/(?<!\\)\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\)/g)]
    .map((match) => ({ target: match[1] ?? match[2], kind: 'markdown' }));
  return { aliases: fields.aliases ?? [], body: body.slice(0, MAX_TEXT), links: [...wiki, ...md].slice(0, 100),
    tags, title: fields.title ?? '' };
}

function readFields(text) {
  try {
    const document = parseDocument(text, { schema: 'core', strict: true, logLevel: 'silent' });
    if (document.errors.length) return {};
    const value = document.toJS({ maxAliasCount: 0 });
    const asList = (input) => (Array.isArray(input) ? input : [input])
      .filter((item) => typeof item === 'string').map((item) => item.trim().slice(0, 100)).filter(Boolean).slice(0, 30);
    return { tags: asList(value?.tags), aliases: asList(value?.aliases), title: asList(value?.title)[0] };
  } catch {
    return {};
  }
}

async function canonical(input) {
  return fs.realpath(input).catch(() => null);
}

async function readExcerpt(file, root) {
  const real = await canonical(file);
  if (!real || real !== file || !within(root, real)) return null;
  const descriptor = await fs.open(real, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
    .catch(() => null);
  if (!descriptor) return null;
  try {
    const stat = await descriptor.stat();
    if (!stat.isFile()) return null;
    const bytes = Buffer.alloc(Math.min(maxBytesFor(file), stat.size));
    const { bytesRead } = await descriptor.read(bytes, 0, bytes.length, 0);
    return { text: bytes.subarray(0, bytesRead).toString('utf8'), at: stat.mtimeMs };
  } catch {
    return null;
  } finally {
    await descriptor.close();
  }
}

function maxBytesFor(file) {
  return markdown.test(file) ? MAX_FILE_BYTES : /\.txt$/i.test(file) ? MAX_TEXT : 0;
}

function itemId(source) {
  return [source.type, source.path ?? source.url ?? source.id ?? source.page].join(':');
}

async function fileItem(file, root, vault) {
  const excerpt = await readExcerpt(file, root);
  if (!excerpt) return null;
  const name = path.basename(file);
  const parsed = markdown.test(name) ? noteData(excerpt.text) : { aliases: [], links: [], tags: [], body: excerpt.text };
  const source = { type: 'file', name, path: file };
  return { ...parsed, id: itemId(source), kind: markdown.test(name) ? 'note' : 'file', name,
    title: parsed.title || (markdown.test(name) ? name.replace(markdown, '') : name),
    path: file, relative: path.relative(root, file), at: excerpt.at, vaultId: vault?.id, vaultName: vault?.name, source };
}

async function indexVault(vault) {
  if (await canonical(vault.path) !== vault.path) throw new Error('Folder is unavailable.');
  const pending = [vault.path];
  const candidates = [];
  let visited = 0;
  let limited = false;
  for (let i = 0; i < pending.length; i++) {
    const folder = pending[i];
    if (await canonical(folder) !== folder || !within(vault.path, folder)) continue;
    const directory = await fs.opendir(folder).catch((error) => { if (!i) throw error; });
    if (!directory) continue;
    for await (const entry of directory) {
      if (++visited > MAX_ENTRIES || candidates.length >= MAX_ITEMS) { limited = true; break; }
      if (!visiblePath(entry.name)) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && (markdown.test(entry.name) || knownFiles.test(entry.name))) candidates.push(file);
    }
    if (limited) break;
  }
  const items = [];
  for (let i = 0; i < candidates.length; i += 32) {
    items.push(...(await Promise.all(candidates.slice(i, i + 32).map((file) => fileItem(file, vault.path, vault)))).filter(Boolean));
  }
  return { items, limited };
}

function linkLookup(items) {
  const byPath = new Map();
  const byName = new Map();
  function add(index, key, item) {
    const bucket = index.get(key) ?? new Set();
    bucket.add(item);
    index.set(key, bucket);
  }
  for (const item of items) {
    add(byPath, relativeKey(item.relative), item);
    add(byName, relativeKey(item.name), item);
    for (const alias of item.aliases) add(byName, relativeKey(alias), item);
  }
  const unique = (index, key) => index.get(key)?.size === 1 ? index.get(key).values().next().value : null;
  return (target, kind, relative = '') => {
    if (typeof target !== 'string' || target.length > 1500) return null;
    const decoded = kind === 'markdown' ? decodeLink(target) : target;
    if (!decoded || decoded.startsWith('#') || decoded.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(decoded)) return null;
    const cleaned = decoded.split('#')[0].replaceAll('\\', '/');
    const targetKey = relativeKey(path.posix.normalize(cleaned).replace(/^\//, ''));
    const local = relativeKey(path.posix.normalize(path.posix.join(path.posix.dirname(relative), cleaned)));
    const atRoot = unique(byPath, targetKey);
    const atLocal = unique(byPath, local);
    if (cleaned.startsWith('/')) return atRoot;
    if (cleaned.startsWith('./') || cleaned.startsWith('../')) return atLocal;
    if (kind === 'markdown') return atLocal ?? atRoot;
    return atLocal ?? atRoot ?? unique(byName, targetKey);
  };
}

function decodeLink(value) {
  try { return decodeURIComponent(value); }
  catch { return ''; }
}

function compact(item, query = '') {
  const { body, aliases, links, ...row } = item;
  const plain = (body ?? '').replace(/\s+/g, ' ').trim();
  const offset = normalized(plain).indexOf(normalized(query));
  const start = offset > 100 ? offset - 45 : 0;
  const end = start + 205;
  return { ...row, excerpt: (start ? '…' : '') + plain.slice(start, end) + (end < plain.length ? '…' : '') };
}

const tagMatches = (tag, query) => tag === query || tag.startsWith(query + '/');

function matches(item, terms, queryTag) {
  if (queryTag && !item.tags.some((tag) => tagMatches(tag, queryTag))) return false;
  const first = normalized([item.title, item.name, item.relative, item.description, item.vaultName, ...item.tags, ...item.aliases].join(' '));
  const body = normalized(item.body ?? '');
  return terms.every((part) => part.startsWith('#')
    ? item.tags.some((tag) => tagMatches(tag, part.slice(1)))
    : first.includes(part) || body.includes(part));
}

function parseTerms(query) {
  return (typeof query === 'string' ? query.slice(0, 180) : '').trim()
    .match(/"[^"]+"|[^\s]+/g)?.map((term) => normalized(term.replace(/^"|"$/g, '').replace(/^tag:/, '#').replace(/^##/, '#'))) ?? [];
}

function createKnowledge({ store, files }) {
  const cache = new Map();
  const list = () => (store.data.knowledgeVaults ?? []).map((vault) => ({ ...vault }));

  async function addVault(input) {
    const folder = typeof input === 'string' && path.isAbsolute(input) ? await canonical(input) : null;
    const stat = folder && await fs.stat(folder).catch(() => null);
    if (!stat?.isDirectory()) throw new Error('Choose an existing vault or notes folder.');
    const current = list();
    const existing = current.find((vault) => vault.path === folder);
    if (existing) return existing;
    const isObsidian = (await fs.stat(path.join(folder, '.obsidian')).catch(() => null))?.isDirectory() ?? false;
    // Re-read after I/O so simultaneous folder picks cannot replace each other's additions.
    const latest = list();
    const addedMeanwhile = latest.find((vault) => vault.path === folder);
    if (addedMeanwhile) return addedMeanwhile;
    if (latest.length >= MAX_VAULTS) throw new Error('Remove a linked folder before adding another.');
    const vault = { id: randomUUID(), name: path.basename(folder) || folder, path: folder, isObsidian };
    store.data.knowledgeVaults = [...latest, vault];
    store.update();
    return vault;
  }

  function removeVault(id) {
    store.data.knowledgeVaults = list().filter((vault) => vault.id !== id);
    cache.delete(id);
    store.update();
  }

  function invalidate(file) {
    for (const vault of list()) if (!file || within(vault.path, file)) cache.delete(vault.id);
  }

  function getIndex(vault, refresh) {
    const old = cache.get(vault.id);
    if (old && (!old.at || (!refresh && Date.now() - old.at < cacheLifetime))) return old.result;
    const entry = { result: null, at: 0 };
    entry.result = indexVault(vault).then((snapshot) => {
      entry.at = Date.now();
      const stale = [...cache].filter(([id, current]) => id !== vault.id && current.at).sort((a, b) => a[1].at - b[1].at);
      for (const [id] of stale.slice(0, Math.max(0, stale.length - 3))) cache.delete(id);
      return snapshot;
    }, (error) => {
      if (cache.get(vault.id) === entry) cache.delete(vault.id);
      return { items: [], limited: false, error: error.code === 'EACCES' || error.code === 'EPERM' ? 'Permission denied' : 'Folder is unavailable' };
    });
    cache.set(vault.id, entry);
    return entry.result;
  }

  async function build(input) {
    const all = list();
    const selected = input.vaultId && input.vaultId !== 'all' ? all.filter((vault) => vault.id === input.vaultId) : all;
    const vaults = [];
    const corpus = new Map();
    const lookup = new Map();
    let limited = false;
    // Index several large vaults sequentially to keep I/O and parsing pressure bounded.
    for (const vault of selected) {
      if (corpus.size >= MAX_COMBINED) {
        vaults.push({ ...vault });
        limited = true;
        continue;
      }
      const { items, error, limited: capped } = await getIndex(vault, input.refresh === true);
      if (!list().some((item) => item.id === vault.id)) continue;
      vaults.push({ ...vault, count: items.length, error });
      const included = items.slice(0, Math.max(0, MAX_COMBINED - corpus.size));
      lookup.set(vault.id, linkLookup(included));
      for (const item of included) corpus.set(item.id, item);
      limited ||= capped || included.length < items.length;
    }

    for (const artifact of (input.vaultId && input.vaultId !== 'all' ? [] : store.data.artifacts.slice(0, 180))) {
      const id = itemId({ type: 'file', path: artifact.path });
      if (corpus.has(id)) continue;
      let filename;
      try { filename = files.authorize(artifact.path); } catch { continue; }
      const item = await fileItem(filename, path.dirname(filename), null);
      if (item) corpus.set(id, item);
    }

    for (const favorite of store.data.favorites) {
      const id = itemId(favorite);
      const old = corpus.get(id);
      const tags = (favorite.tags ?? []).map(tagName).filter(Boolean);
      if (old) corpus.set(id, { ...old, description: favorite.notes, favorite: true, tags: [...new Set([...old.tags, ...tags])] });
      if (!old && (!input.vaultId || input.vaultId === 'all')) {
        const { type, name, key, tags: _, notes, at, ...rest } = favorite;
        if (type === 'file') {
          try { files.authorize(favorite.path); } catch { continue; }
        }
        corpus.set(id, { id, kind: type === 'web' ? 'link' : 'file', name, title: name, description: notes, tags,
          body: notes ?? '', aliases: [], links: [], at, source: { type, name, ...rest }, favorite: true });
      }
    }
    for (const item of input.mode === 'memory' ? store.data.memories ?? [] : []) {
      const parsed = noteData(item.content ?? '');
      const id = 'memory:' + item.id;
      corpus.set(id, { ...parsed, id, kind: 'memory', title: item.title, name: item.title, at: item.at });
    }
    const looseNotes = linkLookup([...corpus.values()].filter((item) => item.path && !item.vaultId));
    return { corpus, vaults, limited, lookup, looseNotes };
  }

  async function search(input = {}) {
    const options = input ?? {};
    const { corpus, vaults, limited } = await build(options);
    const query = parseTerms(options.query);
    const tag = tagName(options.tag);
    const rows = [...corpus.values()];
    const counts = new Map();
    for (const row of rows) for (const tag of row.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const found = rows.filter((item) => (!['note', 'file', 'link'].includes(options.kind) || item.kind === options.kind) &&
      (!options.favorites || item.favorite) && matches(item, query, tag)).sort((a, b) => b.at - a.at || a.title.localeCompare(b.title));
    const offset = Number.isSafeInteger(options.offset) ? Math.max(0, options.offset) : 0;
    const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(options.limit, 80)) : 40;
    return { items: found.slice(offset, offset + limit).map((item) => compact(item, query.find((term) => !term.startsWith('#')))),
      tags: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 80).map(([tag, count]) => ({ tag, count })),
      total: found.length, hasMore: offset + limit < found.length, limited, vaults };
  }

  async function graph(input = {}) {
    const options = input ?? {};
    const { corpus, lookup, looseNotes, limited } = await build(options);
    const query = parseTerms(options.query);
    const tag = tagName(options.tag);
    const all = [...corpus.values()];
    const filtered = all.filter((entry) => matches(entry, query, tag));
    const edges = [];
    function resolve(item, link) {
      if (item.vaultId) return lookup.get(item.vaultId)?.(link.target, link.kind, item.relative);
      if (item.kind === 'memory') {
        const entries = [...lookup.values(), looseNotes].map((read) => read(link.target, link.kind)).filter(Boolean);
        if (new Set(entries.map((entry) => entry.id)).size === 1) return entries[0];
      }
      return looseNotes(link.target, link.kind, item.relative);
    }

    const degree = new Map();
    for (const item of all) {
      const targets = new Set();
      for (const link of item.links) {
        const target = resolve(item, link)?.id;
        if (!target || target === item.id || !corpus.has(target) || targets.has(target)) continue;
        targets.add(target);
        edges.push({ from: item.id, to: target, kind: 'link' });
        degree.set(item.id, (degree.get(item.id) ?? 0) + 1);
        degree.set(target, (degree.get(target) ?? 0) + 1);
      }
    }

    const limit = 140;
    const selected = filtered.sort((a, b) => Number(b.kind === 'memory') - Number(a.kind === 'memory') ||
      (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || b.at - a.at).slice(0, limit);
    const selectedIds = new Set(selected.map((item) => item.id));
    const links = edges.filter(({ from, to }) => selectedIds.has(from) && selectedIds.has(to)).slice(0, 650);
    const tags = new Map();
    for (const item of selected) for (const tag of item.tags) {
      const items = tags.get(tag) ?? [];
      items.push(item.id);
      tags.set(tag, items);
    }
    const tagItems = [...tags].filter(([, ids]) => ids.length > 1)
      .sort((a, b) => b[1].length - a[1].length).slice(0, 25);
    for (const [tag, ids] of tagItems) {
      const id = 'tag:' + tag;
      selected.push({ id, kind: 'tag', name: '#' + tag, title: '#' + tag, tags: [tag], aliases: [], links: [] });
      ids.forEach((from) => links.push({ from, to: id, kind: 'tag' }));
    }

    return { nodes: selected.map((item) => compact(item)), edges: links.slice(0, 900),
      limited: limited || filtered.length > limit || links.length > 900 || edges.length > 650, total: filtered.length, vaults: list() };
  }

  function containingVault(file) {
    return list().filter((item) => within(item.path, file)).sort((a, b) => b.path.length - a.path.length)[0];
  }

  async function relations(input) {
    const file = files.authorize(input);
    const vault = containingVault(file);
    if (!vault || !markdown.test(file)) return null;
    const index = await getIndex(vault, false);
    const current = await fileItem(file, vault.path, vault);
    if (!current) return null;
    const resolve = linkLookup(index.items);
    const backlinks = [];
    const related = [];
    for (const item of index.items) {
      if (item.path === file || item.kind !== 'note') continue;
      const row = { path: item.path, name: item.name, relative: item.relative };
      if (item.links.some((link) => resolve(link.target, link.kind, item.relative)?.path === file)) backlinks.push(row);
      const tags = item.tags.filter((tag) => current.tags.includes(tag));
      if (tags.length) related.push({ ...row, related: tags });
    }
    return {
      tags: current.tags, backlinks: backlinks.slice(0, 80),
      related: related.sort((a, b) => b.related.length - a.related.length).slice(0, 40),
      outgoing: current.links.map((link) => ({ label: link.target, path: resolve(link.target, link.kind, current.relative)?.path })),
      truncated: index.limited,
    };
  }

  async function resolveLink(input, target, kind) {
    if (!['wiki', 'markdown'].includes(kind) || typeof target !== 'string' || target.length > 1500) return null;
    const file = files.authorize(input);
    const vault = containingVault(file);
    if (vault) {
      const index = await getIndex(vault, false);
      const item = linkLookup(index.items)(target, kind, path.relative(vault.path, file));
      if (item) return files.authorize(item.path);
    }
    const candidate = kind === 'markdown' ? decodeLink(target) : target;
    if (!candidate || /^[a-z][a-z\d+.-]*:|^\/\//i.test(candidate)) return null;
    const local = candidate.split('#')[0];
    if (!local) return null;
    const resolved = path.resolve(path.dirname(file), local);
    for (const name of [resolved, resolved + '.md', resolved + '.markdown']) {
      if (vault && !within(vault.path, name)) continue;
      try {
        const candidate = files.authorize(name);
        if (vault && (!within(vault.path, candidate) || !visiblePath(path.relative(vault.path, candidate)))) continue;
        if ((await fs.stat(candidate)).isFile()) return candidate;
      } catch { /* An unresolved link remains visible in the preview. */ }
    }
    return null;
  }

  return { addVault, removeVault, list, search, graph, invalidate, resolveLink, relations };
}

module.exports = { createKnowledge, noteData };
