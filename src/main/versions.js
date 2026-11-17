const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createTwoFilesPatch } = require('diff');
const { atomicWrite } = require('./store');

const run = promisify(execFile);
const limit = 8 * 1024 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');

function createVersions(store) {
  const base = path.join(store.root, 'versions');
  function readRecords(file) {
    const folder = path.join(base, hash(file));
    const index = path.join(folder, 'index.json');
    const entries = fs.existsSync(index) ? JSON.parse(fs.readFileSync(index, 'utf8')) : [];
    return { entries, index, folder };
  }

  function checkpoint(file, { bytes, label = 'Before editing' } = {}) {
    if (bytes === undefined) {
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.size > limit) return;
      bytes = fs.readFileSync(file);
    }
    if (bytes.length > limit) return;
    const { entries, index, folder } = readRecords(file);
    const id = hash(bytes);
    if (entries[0]?.id === id) return;
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    atomicWrite(path.join(folder, id), bytes);
    const next = [{ id, at: Date.now(), title: label },
      ...entries.filter((entry) => entry.id !== id)];
    atomicWrite(index, JSON.stringify(next.slice(0, 12)));
    for (const obsolete of next.slice(12)) fs.rmSync(path.join(folder, obsolete.id), { force: true });
  }

  async function git(cwd, args) {
    const { stdout } = await run('git', ['--literal-pathspecs', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
      timeout: 6000, maxBuffer: limit, env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  }
  async function repo(cwd) {
    try { return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim(); }
    catch { return null; }
  }

  async function timeline(file) {
    const local = readRecords(file).entries.map((entry) => ({ ...entry, source: 'local' }));
    const top = await repo(path.dirname(file));
    if (!top) return local;
    const result = await git(top, ['log', '-n', '25', '--format=%H%x00%at%x00%s', '--', path.relative(top, file)]).catch(() => '');
    const commits = result.trimEnd().split('\n').filter(Boolean).map((row) => {
      const [id, seconds, title] = row.split('\0');
      return { id, at: Number(seconds) * 1000, title, source: 'git' };
    });
    return [...local, ...commits].sort((a, b) => b.at - a.at);
  }

  function stored(file, id) {
    const { folder, entries } = readRecords(file);
    if (!/^[a-f0-9]{64}$/.test(id) || !entries.some((entry) => entry.id === id)) throw new Error('This snapshot is unavailable.');
    return fs.readFileSync(path.join(folder, id));
  }

  async function preview(file, source, id) {
    let before;
    if (source === 'local') before = stored(file, id);
    else {
      if (source !== 'git' || !/^[a-f0-9]{40,64}$/.test(id)) throw new Error('Choose a file version.');
      const top = await repo(path.dirname(file));
      if (!top) throw new Error('This file is outside a Git repository.');
      before = Buffer.from(await git(top, ['show', id + ':' + path.relative(top, file)]));
    }
    const info = fs.statSync(file);
    if (info.size > limit) return 'This file is too large for a text comparison.';
    const after = fs.readFileSync(file);
    if (before.includes(0) || after.includes(0)) return 'Binary file. Use a local snapshot to restore earlier content.';
    const result = createTwoFilesPatch('Earlier version', 'Current file', before.toString(), after.toString(), '', '', { context: 3, timeout: 600 });
    return typeof result === 'string' ? result.slice(0, 65000) : 'This file has too many changes for a text comparison.';
  }

  function restore(file, id, expected) {
    const stat = fs.statSync(file);
    if (stat.size > limit) throw new Error('This file is too large to restore here.');
    const current = fs.readFileSync(file);
    if (hash(current) !== expected) throw new Error('The file changed on disk. Reload it first.');
    const snapshot = stored(file, id);
    checkpoint(file, { bytes: current, label: 'Before restoring a version' });
    atomicWrite(file, snapshot, stat.mode & 0o777);
    store.activity('file', 'Restored ' + path.basename(file), 'Local version restored', { type: 'file', path: file });
  }

  async function changes(directory, requested) {
    const top = await repo(directory);
    if (!top) return { branch: '', root: null, items: [] };
    const content = await git(top, ['status', '--porcelain=v1', '--branch', '-z', '--untracked-files=normal']);
    const [branch, ...rows] = content.split('\0');
    const items = [];
    for (let i = 0; i < rows.length && items.length < 500; i++) {
      const row = rows[i];
      if (!row) continue;
      const status = row.slice(0, 2);
      const relative = row.slice(3);
      if (/[RC]/.test(status)) i++;
      const file = path.resolve(top, relative);
      const relativeToSelection = path.relative(directory, file);
      if (relativeToSelection === '..' || relativeToSelection.startsWith('..' + path.sep) || path.isAbsolute(relativeToSelection)) continue;
      items.push({ path: file, name: relative, status });
    }
    const current = items.find((item) => item.path === requested);
    const diff = current && current.status !== '??' ? await git(top, [
      'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', path.relative(top, current.path),
    ]).catch(() => '') : '';
    return { branch: branch.slice(3).split('...')[0], root: top, items, diff: diff.slice(0, 65000) };
  }
  return { checkpoint, timeline, preview, restore, changes };
}
module.exports = { createVersions };
