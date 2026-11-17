const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { parse } = require('parse5');
const { fromBuffer } = require('yauzl');
const { searchEngines, webUrl } = require('./browser-preferences');

const maxFileBytes = 12 * 1024 * 1024;
const maxBookmarks = 10000;
const maxDepth = 24;
const bookmarkFiles = ['Bookmarks', 'AccountBookmarks'];

function browserRoots(home, platform, env) {
  const relative = platform === 'darwin' ? [
    ['Chrome', 'Google/Chrome'], ['Edge', 'Microsoft Edge'], ['Brave', 'BraveSoftware/Brave-Browser'],
    ['Chromium', 'Chromium'], ['Vivaldi', 'Vivaldi'],
  ] : platform === 'win32' ? [
    ['Chrome', 'Google/Chrome/User Data'], ['Edge', 'Microsoft/Edge/User Data'], ['Brave', 'BraveSoftware/Brave-Browser/User Data'],
    ['Chromium', 'Chromium/User Data'], ['Vivaldi', 'Vivaldi/User Data'],
  ] : [
    ['Chrome', 'google-chrome'], ['Edge', 'microsoft-edge'], ['Brave', 'BraveSoftware/Brave-Browser'],
    ['Chromium', 'chromium'], ['Vivaldi', 'vivaldi'],
  ];
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    : env.XDG_CONFIG_HOME || path.join(home, '.config');
  return relative.map(([name, folder]) => [name, path.join(base, folder)]);
}

async function readImportFile(file) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxFileBytes) throw new Error('Choose a regular browser export under 12 MB.');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > stat.size) throw new Error('The browser file changed while reading it. Try again.');
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function readJson(file) {
  return JSON.parse((await readImportFile(file)).toString('utf8').replace(/^\uFEFF/, ''));
}

function label(value, fallback = '') {
  return (typeof value === 'string' ? value.trim().slice(0, 300) : '') || fallback;
}

function collector() {
  const bookmarks = [];
  let skipped = 0;
  return {
    add(href, title, folder) {
      try {
        if (typeof href !== 'string' || href.length > 4096) throw new Error('Unsupported bookmark address');
        const url = webUrl(href);
        if (bookmarks.length >= maxBookmarks) throw new Error('Bookmark limit');
        bookmarks.push({ url, name: label(title, url), folder });
      } catch { skipped++; }
    },
    result: () => ({ bookmarks, skipped }),
  };
}

function parseChromiumBookmarks(data) {
  if (!data?.roots || typeof data.roots !== 'object' || Array.isArray(data.roots)) {
    throw new Error('This file does not contain Chromium bookmarks.');
  }
  const result = collector();
  function visit(entry, folder) {
    if (entry?.type === 'url') result.add(entry.url, entry.name, folder);
    if (entry?.type !== 'folder' || !Array.isArray(entry.children) || folder.length >= maxDepth) return;
    const next = [...folder, label(entry.name, 'Unnamed folder')];
    for (const child of entry.children) visit(child, next);
  }
  const roots = Object.entries(data.roots);
  for (const [id, root] of roots) {
    visit({ ...root, name: label(root?.name, id) }, []);
  }
  return result.result();
}

function nodeText(node) {
  let text = '';
  const pending = [node];
  while (pending.length && text.length < 300) {
    const child = pending.pop();
    if (child.nodeName === '#text') text += child.value;
    if (child.childNodes?.length) for (let i = child.childNodes.length - 1; i >= 0; i--) pending.push(child.childNodes[i]);
  }
  return text;
}

function parseBookmarkHtml(html) {
  const document = parse(html);
  const result = collector();
  const ignored = new Set(['script', 'style', 'template', 'iframe', 'object', 'svg', 'math']);
  let hasList = false;
  function visit(parent, folder, depth, insideList = false) {
    if (depth > maxDepth * 4 || folder.length > maxDepth) return '';
    let heading = '';
    for (const node of parent.childNodes ?? []) {
      const tag = node.tagName;
      if (ignored.has(tag)) continue;
      if (tag === 'h3') {
        heading = label(nodeText(node), 'Unnamed folder');
      } else if (tag === 'dl') {
        hasList = true;
        visit(node, heading ? [...folder, heading] : folder, depth + 1, true);
        heading = '';
      } else if (tag === 'a' && insideList) {
        result.add(node.attrs?.find((attribute) => attribute.name === 'href')?.value, nodeText(node), folder);
      } else if (node.childNodes?.length) {
        const nestedHeading = visit(node, folder, depth + 1, insideList);
        if (nestedHeading) heading = nestedHeading;
      }
    }
    return heading;
  }
  visit(document, [], 0);
  const hasDoctype = document.childNodes.some((node) => node.nodeName === '#documentType' && node.name === 'netscape-bookmark-file-1');
  if (!hasList || !hasDoctype) {
    throw new Error('Choose an HTML bookmarks export from your browser.');
  }
  return result.result();
}

async function readBookmarkExport(file) {
  const bytes = await readImportFile(file);
  if (path.extname(file).toLowerCase() !== '.zip') return bytes.toString('utf8');
  return new Promise((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true }, (error, archive) => {
      if (error) return reject(new Error('This bookmarks archive could not be opened.'));
      archive.on('error', reject);
      if (archive.entryCount > 2048) {
        archive.close();
        return reject(new Error('Export only bookmarks from Safari and try again.'));
      }
      const candidates = [];
      archive.on('entry', (entry) => {
        if (/\.html?$/i.test(entry.fileName) && !entry.fileName.startsWith('__MACOSX/')) candidates.push(entry);
        archive.readEntry();
      });
      archive.on('end', () => {
        const entry = candidates.find((item) => /(?:^|\/)bookmarks\.html$/i.test(item.fileName))
          ?? (candidates.length === 1 ? candidates[0] : null);
        if (!entry) return reject(new Error('This ZIP does not contain a recognizable bookmarks file.'));
        if (entry.uncompressedSize > maxFileBytes) {
          return reject(new Error('Choose a bookmarks export under 12 MB.'));
        }
        archive.openReadStream(entry, async (streamError, stream) => {
          if (streamError) return reject(streamError);
          try {
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            resolve(Buffer.concat(chunks).toString('utf8'));
          } catch (readError) { reject(readError); }
        });
      });
      archive.readEntry();
    });
  });
}

function chromiumPreferences(data) {
  const result = {};
  const provider = data?.default_search_provider_data?.template_url_data;
  const host = typeof provider?.url === 'string'
    ? URL.parse(provider.url.replace('{google:baseURL}', 'https://www.google.com/'))?.hostname : null;
  const known = Object.entries(searchEngines).find(([, prefix]) => {
    const domain = new URL(prefix).hostname.replace(/^www\./, '');
    return host === domain || host?.endsWith('.' + domain);
  });
  if (known) result.searchEngine = known[0];
  if (data?.homepage_is_newtabpage === true) result.homePage = '';
  else if (data?.homepage) {
    try { result.homePage = webUrl(data.homepage); } catch { /* Internal browser URLs have no portable destination. */ }
  }
  if (typeof data?.bookmark_bar?.show_on_all_tabs === 'boolean') {
    result.showBookmarksBar = data.bookmark_bar.show_on_all_tabs;
  }
  return result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function exportBookmarks(items) {
  const root = { children: new Map(), bookmarks: [] };
  for (const item of items) {
    if (item.type !== 'web') continue;
    let url;
    try { url = webUrl(item.url); } catch { continue; }
    let node = root;
    for (const name of (item.bookmarkFolder ?? []).slice(0, maxDepth)) {
      if (!node.children.has(name)) node.children.set(name, { children: new Map(), bookmarks: [] });
      node = node.children.get(name);
    }
    node.bookmarks.push({ name: item.name, url });
  }
  const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', '<TITLE>Bookmarks</TITLE>', '<H1>Bookmarks</H1>'];
  const visit = (node, indent) => {
    lines.push(indent + '<DL><p>');
    for (const bookmark of node.bookmarks) lines.push(indent + '    <DT><A HREF="' + escapeHtml(bookmark.url) + '">' + escapeHtml(bookmark.name) + '</A>');
    for (const [name, child] of node.children) {
      lines.push(indent + '    <DT><H3>' + escapeHtml(name) + '</H3>');
      visit(child, indent + '    ');
    }
    lines.push(indent + '</DL><p>');
  };
  visit(root, '');
  return lines.join('\n') + '\n';
}

function createBrowserImports({ store, home, platform = process.platform, env = process.env }) {
  const previews = new WeakMap();
  async function profiles() {
    const roots = browserRoots(home, platform, env);
    return (await Promise.all(roots.map(async ([browser, folder]) => {
      const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
      if (!entries.length) return [];
      const state = await readJson(path.join(folder, 'Local State')).catch(() => null);
      const names = state?.profile?.info_cache ?? {};
      return (await Promise.all(entries.filter((entry) => entry.isDirectory() &&
        (/^(Default|Profile \d+)$/.test(entry.name) || Object.hasOwn(names, entry.name))).map(async ({ name }) => {
        const directory = path.join(folder, name);
        const files = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
        if (!files.some((entry) => [...bookmarkFiles, 'Preferences'].includes(entry.name) && entry.isFile())) return null;
        const id = createHash('sha256').update(directory).digest('hex').slice(0, 24);
        return { id, browser, name: label(names[name]?.name, name), directory };
      }))).filter(Boolean);
    }))).flat();
  }

  async function readProfile(directory) {
    const [local, account, preferences] = await Promise.allSettled([
      ...bookmarkFiles.map((name) => readJson(path.join(directory, name)).then(parseChromiumBookmarks)),
      readJson(path.join(directory, 'Preferences')).then(chromiumPreferences),
    ]);
    if ([local, account, preferences].every((value) => value.status === 'rejected')) {
      throw new Error('Choose a Chromium profile folder with a readable Bookmarks or Preferences file.');
    }
    const warnings = [
      [local, 'Local bookmarks could not be read.'],
      [account, 'Account bookmarks could not be read.'],
      [preferences, 'Browser preferences could not be read.'],
    ].filter(([value]) => value.status === 'rejected' && value.reason?.code !== 'ENOENT').map(([, message]) => message);
    const entries = [local, account].flatMap(({ value }) => value?.bookmarks ?? []);
    const skipped = (local.value?.skipped ?? 0) + (account.value?.skipped ?? 0);
    return {
      bookmarks: entries.slice(0, maxBookmarks), preferences: preferences.value, warnings,
      skipped: skipped + Math.max(0, entries.length - maxBookmarks),
    };
  }

  function preview(owner, name, { bookmarks = [], skipped = 0, preferences = {}, warnings = [] }) {
    const token = randomUUID();
    previews.set(owner, { token, bookmarks, preferences });
    return { token, name, bookmarkCount: bookmarks.length, skipped, preferences, warnings };
  }

  return {
    async list() {
      return (await profiles()).map(({ id, browser, name }) => ({ id, browser, name }));
    },
    async profile(owner, id) {
      const source = (await profiles()).find((entry) => entry.id === id);
      if (!source) throw new Error('That browser profile is no longer available.');
      return preview(owner, source.browser + ' · ' + source.name, await readProfile(source.directory));
    },
    async folder(owner, directory) {
      return preview(owner, label(path.basename(directory), 'Browser profile'), await readProfile(directory));
    },
    async file(owner, file) {
      return preview(owner, label(path.basename(file), 'Bookmarks'), parseBookmarkHtml(await readBookmarkExport(file)));
    },
    apply(owner, token, options) {
      const source = previews.get(owner);
      if (!source || source.token !== token) throw new Error('Choose a browser import first.');
      const favorites = store.data.favorites;
      const urls = new Set(favorites.filter((item) => item.type === 'web').map((item) => {
        try { return webUrl(item.url); } catch { return item.url; }
      }));
      const added = [];
      let duplicates = 0;
      if (options?.bookmarks === true) {
        const at = Date.now();
        for (const { url, name, folder } of source.bookmarks) {
          if (urls.has(url)) { duplicates++; continue; }
          urls.add(url);
          added.push({ type: 'web', key: 'web:' + url, url, name, at, bookmarkFolder: folder });
        }
      }
      const preferences = options?.preferences === true ? source.preferences : {};
      const fields = Object.keys(preferences);
      if (added.length || fields.length) {
        const previous = store.data.preferences;
        store.data.favorites = [...added, ...favorites];
        store.data.preferences = { ...previous, ...preferences };
        try { store.update(); } catch (error) {
          store.data.favorites = favorites;
          store.data.preferences = previous;
          throw error;
        }
      }
      previews.delete(owner);
      return { added: added.length, duplicates, preferences: fields.length };
    },
    export: () => exportBookmarks(store.data.favorites),
  };
}

module.exports = { createBrowserImports, parseChromiumBookmarks, parseBookmarkHtml, chromiumPreferences, exportBookmarks };
