const fs = require('node:fs/promises');
const path = require('node:path');
const { isInside } = require('./files');

const noteLimit = 160 * 1024;
const ignored = new Set(['node_modules', 'dist', 'build', 'vendor']);
const comparable = (value) => value.trim().replace(/\.md$/i, '').replaceAll('\\', '/').toLowerCase();

function parseNote(text) {
  const body = text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, '')
    .replace(/`[^`\n]+`/g, '');
  const links = [...body.matchAll(/\[\[([^\]\n#|]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]+)?\]\]/g)].map((match) => match[1].trim());
  const tags = [...body.matchAll(/(?:^|[\s(])#([\p{L}_][\p{L}\p{N}_/-]{0,59})/gu)].map((match) => match[1].toLowerCase());
  return { links: [...new Set(links)].slice(0, 50), tags: [...new Set(tags)].slice(0, 50) };
}

async function readNote(file) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size > noteLimit) return '';
  return fs.readFile(file, 'utf8').catch(() => '');
}

async function noteLinks(files, input, directory) {
  const file = files.authorize(input);
  if (!/\.md$/i.test(file)) throw new Error('Links are available for Markdown notes.');
  const current = parseNote(await readNote(file));
  let root;
  try {
    root = files.authorize(directory || path.dirname(file));
    if (!isInside(root, file)) root = files.authorize(path.dirname(file));
  } catch {
    return { tags: current.tags, outgoing: current.links.map((label) => ({ label })), backlinks: [], related: [], truncated: false };
  }
  const notes = [];
  const pending = [root];
  let truncated = false;
  for (let index = 0; index < pending.length && index < 90 && notes.length < 300; index++) {
    const folder = pending[index];
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
      const target = path.join(folder, entry.name);
      if (entry.isDirectory() && pending.length < 90) pending.push(target);
      if (entry.isFile() && /\.md$/i.test(entry.name)) notes.push(target);
      if (pending.length >= 90 || notes.length >= 300) truncated = true;
      if (notes.length >= 300) break;
    }
  }
  const rows = notes.map((note) => ({ path: note, name: path.basename(note), relative: comparable(path.relative(root, note)) }));
  function resolve(value, from) {
    const key = comparable(value);
    const local = comparable(path.relative(root, path.resolve(path.dirname(from), value)));
    const candidates = rows.filter((row) => row.relative === key || row.relative === local);
    if (candidates.length === 1) return candidates[0];
    const byName = rows.filter((row) => comparable(row.name) === key);
    return byName.length === 1 ? byName[0] : null;
  }
  const found = [];
  for (let i = 0; i < rows.length; i += 15) {
    const batch = await Promise.all(rows.slice(i, i + 15).filter((note) => note.path !== file).map(async (note) => {
      const parsed = parseNote(await readNote(note.path));
      const related = parsed.tags.filter((tag) => current.tags.includes(tag));
      const backlink = parsed.links.some((link) => resolve(link, note.path)?.path === file);
      return { ...note, related, backlink };
    }));
    found.push(...batch);
  }
  return {
    tags: current.tags,
    outgoing: current.links.map((link) => ({ label: link, path: resolve(link, file)?.path })),
    backlinks: found.filter((note) => note.backlink).slice(0, 80),
    related: found.filter((note) => note.related.length > 0).sort((a, b) => b.related.length - a.related.length).slice(0, 40),
    truncated,
  };
}

module.exports = { noteLinks };
