const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { structuredPatch, applyPatch } = require('diff');
const { atomicWrite } = require('./store');
const { git, gitSource, addWorktree, disabledFilters } = require('./team-sessions');
const { redact } = require('./agent-common');

const maxBytes = 512 * 1024;
const maxChanges = 80;
const maxTotal = 12 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const uuid = /^[a-f0-9-]{36}$/i;
const missing = (error) => error.code === 'ENOENT' || error.code === 'ENOTDIR';
const stat = (file) => fs.lstatSync(file, { throwIfNoEntry: false });

function validatePath(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') ||
    relative.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('This change has an unsupported path.');
  }
  return relative.split('/');
}

function locate(root, relative) {
  const parts = validatePath(relative);
  if (fs.realpathSync(root) !== root) throw new Error('The checkout moved.');
  let next = root;
  let absent = false;
  for (const [index, part] of parts.entries()) {
    next = path.join(next, part);
    if (absent) continue;
    const current = stat(next);
    if (!current) { absent = true; continue; }
    if (index === parts.length - 1 ? !current.isFile() || current.nlink !== 1 : !current.isDirectory()) {
      throw new Error('The change is not a regular file in the checkout.');
    }
  }
  return { file: next, exists: !absent };
}

function asText(bytes, mode) {
  if (bytes.includes(0)) throw new Error('Binary file');
  return { text: decoder.decode(bytes), executable: Boolean(mode & 0o111) };
}

function readVersion(root, relative) {
  const { file, exists } = locate(root, relative);
  if (!exists) return null;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const current = fs.fstatSync(fd);
    if (!current.isFile() || current.nlink !== 1 || current.size > maxBytes) throw new Error('File is too large or unsupported.');
    const bytes = Buffer.alloc(current.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const length = fs.readSync(fd, bytes, offset, bytes.length - offset);
      if (!length) break;
      offset += length;
    }
    if (offset !== current.size) throw new Error('The file changed while reading it.');
    return asText(bytes.subarray(0, offset), current.mode);
  } finally {
    fs.closeSync(fd);
  }
}

async function blob(root, revision, relative) {
  const info = await git(root, ['ls-tree', '-z', revision, '--', relative]);
  if (!info) return null;
  const match = /^(100644|100755) blob ([a-f0-9]+)\t/.exec(info);
  if (!match) throw new Error('Git did not record a regular file.');
  const length = Number(await git(root, ['cat-file', '-s', match[2]]));
  if (!Number.isSafeInteger(length) || length > maxBytes) throw new Error('Git blob is too large.');
  return asText(await git(root, ['cat-file', 'blob', match[2]], [], true), match[1] === '100755' ? 0o755 : 0o644);
}

async function checkout(root) {
  const source = await gitSource(root);
  if (!source) return null;
  const branch = await git(source.top, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
  return { ...source, branch };
}

function within(scope, file) {
  return !scope || file.startsWith(scope + '/');
}

async function dirtyPaths(top, scope) {
  const args = ['status', '--porcelain=v1', '--no-renames', '-z', '--untracked-files=all', '--ignore-submodules=all'];
  const raw = await git(top, [...args, ...scope ? ['--', scope] : []], await disabledFilters(top), true);
  const entries = raw.toString('utf8').split('\0').filter(Boolean);
  const names = entries.map((line) => line.slice(3)).filter((filename) => within(scope, filename));
  if (names.length > maxChanges) throw new Error('Too many changes to record this checkout.');
  return names;
}

function same(a, b) {
  return a === null || b === null ? a === b : a.text === b.text && a.executable === b.executable;
}

function safeVersion(root, relative) {
  try { return readVersion(root, relative); } catch { return undefined; }
}

function fingerprint(version) {
  if (version === undefined || version === null) return version;
  return createHash('sha256').update(version.executable ? 'x\0' : '-\0').update(version.text).digest('hex');
}

function fingerprintFile(root, absolute) {
  try {
    const canonical = fs.realpathSync(root);
    const relative = path.relative(canonical, absolute).split(path.sep).join('/');
    return fingerprint(safeVersion(canonical, relative));
  } catch {
    return undefined;
  }
}

function trackedByTools(rows, absolute, before, after) {
  const edits = rows.filter((row) => row.path === absolute && row.afterRevision !== undefined && row.beforeRevision !== undefined);
  if (!edits.length) return false;
  let expected = fingerprint(before);
  for (const edit of edits) {
    if (edit.beforeRevision !== expected) return false;
    expected = edit.afterRevision;
  }
  return expected === fingerprint(after);
}

function sizeOf(version) {
  return version ? Buffer.byteLength(version.text, 'utf8') : 0;
}

function computedPatch(entry) {
  const patch = structuredPatch(entry.path, entry.path, entry.before?.text ?? '', entry.after?.text ?? '', '', '', { context: 3, timeout: 250 });
  return patch?.hunks;
}

function bySelection(entry, selection) {
  if (!selection.length) return entry.before;
  const indices = selection.filter((index) => index >= 0);
  if (selection.includes(-1) || indices.length === entry.hunkCount) return entry.after;
  const hunks = computedPatch(entry);
  if (!hunks || indices.some((index) => !hunks[index])) throw new Error('The patch is no longer available.');
  const text = applyPatch(entry.before.text, { hunks: indices.map((index) => hunks[index]) }, { fuzzFactor: 0, autoConvertLineEndings: false });
  if (text === false) throw new Error('Could not reconstruct the selected changes.');
  return { text, executable: entry.before.executable };
}

function modifiedVersion(file, current, intended) {
  if (!intended) {
    fs.unlinkSync(file);
    return;
  }
  const existingMode = current ? (stat(file)?.mode & 0o777) : 0o644;
  const mode = intended.executable ? existingMode | 0o111 : existingMode & ~0o111;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, intended.text, mode);
}

function availableHunks(entry) {
  return entry.hunkCount > 0 && !entry.wholeFile;
}

function createReviews({ store }) {
  const folder = path.join(store.root, 'reviews');
  const worktrees = path.join(store.root, 'review-worktrees');

  function load(id) {
    if (typeof id !== 'string' || !uuid.test(id)) throw new Error('Choose a review.');
    try { return JSON.parse(fs.readFileSync(path.join(folder, id + '.json'), 'utf8')); }
    catch (error) {
      if (!missing(error)) throw error;
      throw new Error('This review is no longer available.');
    }
  }

  function save(record) {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    atomicWrite(path.join(folder, record.id + '.json'), JSON.stringify(record));
  }

  function summarize(record) {
    const { id, sessionId, runId, harness, model, at, isolated, undone, journal, files, checkOutcome, title, cwd, target, completedAt } = record;
    const pending = isolated && files.some((entry) => !entry.unavailable && !entry.applied.includes(-1) && (entry.wholeFile || entry.applied.length !== entry.hunkCount));
    const labels = [files.map((file) => file.path).slice(0, 3).join(', ').slice(0, 200)];
    if (files.length > 3) labels.push('+' + (files.length - 3) + ' files');
    if (checkOutcome) labels.push(checkOutcome === 'passed' ? 'Project check passed' : 'Project check failed');
    return {
      id, sessionId, runId, harness, model, at, isolated, fileCount: files.length, checkOutcome, title,
      workspace: target ?? cwd, createdAt: completedAt ?? at, summary: labels.filter(Boolean).join(' · '),
      status: journal ? 'interrupted' : pending ? 'pending' : undone ? 'undone' : 'reviewed',
    };
  }

  function update(record) {
    const rows = store.data.reviews ??= [];
    const summary = summarize(record);
    const index = rows.findIndex(({ id }) => id === record.id);
    if (index >= 0) rows[index] = summary;
    else rows.unshift(summary);
    store.update();
    return summary;
  }

  async function workspace(source) {
    const origin = await checkout(source);
    if (!origin) return null;
    const scope = path.relative(origin.top, fs.realpathSync(source)).split(path.sep).join('/');
    const paths = await dirtyPaths(origin.top, scope);
    return { root: origin.top, branch: origin.branch, revision: origin.head, localChanges: paths.length, scope };
  }

  async function createCopy(source, confirmed) {
    if (!confirmed || typeof confirmed !== 'object') throw new Error('Choose and review the target checkout first.');
    const origin = await workspace(source);
    if (!origin) throw new Error('Choose a Git folder with an initial commit to work on a separate copy.');
    if (origin.revision !== confirmed.revision || origin.branch !== confirmed.branch || origin.root !== confirmed.root) {
      throw new Error('The target branch or revision changed. Reopen the workspace details and choose again.');
    }
    const id = randomUUID();
    fs.mkdirSync(worktrees, { recursive: true, mode: 0o700 });
    const destination = path.join(fs.realpathSync(worktrees), id);
    try {
      await addWorktree(origin.root, destination, origin.revision);
      const cwd = path.join(destination, origin.scope);
      if (!stat(cwd)?.isDirectory() || fs.realpathSync(cwd) !== cwd) throw new Error('The folder is unavailable in the committed copy.');
      return { id, cwd, isolation: 'worktree', sourceCwd: fs.realpathSync(source), reviewWorkspace: {
        root: destination, target: origin.root, branch: origin.branch, revision: origin.revision, explicit: true,
      } };
    } catch (error) {
      await git(origin.root, ['worktree', 'remove', '--force', destination]).catch(() => {});
      // The generated directory belongs only to this failed create operation.
      fs.rmSync(destination, { recursive: true, force: true });
      throw error;
    }
  }

  async function begin(chat, options) {
    if (chat.readOnly || chat.computerId) return null;
    const repo = await checkout(chat.cwd);
    if (!repo) return null;
    const scope = path.relative(repo.top, fs.realpathSync(chat.cwd)).split(path.sep).join('/');
    const names = await dirtyPaths(repo.top, scope);
    const snapshots = new Map();
    let bytes = 0;
    for (const name of names) {
      const snapshot = safeVersion(repo.top, name);
      bytes += sizeOf(snapshot);
      snapshots.set(name, bytes > maxTotal ? undefined : snapshot);
    }
    return {
      chat, repo, scope, snapshots, at: Date.now(), transcriptStart: store.transcript(chat.id).length,
      runId: options?.runId,
    };
  }

  async function finish(start, details = {}) {
    if (!start) return null;
    const { chat, repo, scope, snapshots, transcriptStart, at, runId } = start;
    const next = await checkout(repo.top);
    if (!next || next.top !== repo.top || next.branch !== repo.branch) throw new Error('The working branch changed during the turn.');
    const committed = next.head === repo.head ? '' : await git(repo.top, [
      'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', repo.head, next.head, ...scope ? ['--', scope] : [],
    ]);
    const names = new Set([...snapshots.keys(), ...await dirtyPaths(repo.top, scope), ...committed.split('\0').filter((file) => file && within(scope, file))]);
    const separate = chat.reviewWorkspace;
    const childSource = !separate && chat.isolation === 'worktree' && chat.sourceCwd ? await checkout(chat.sourceCwd) : null;
    const target = separate?.target ?? childSource?.top ?? repo.top;
    const branch = separate ? separate.branch : childSource ? childSource.branch : repo.branch;
    const rows = store.transcript(chat.id).slice(transcriptStart);
    const title = redact(rows.find((row) => row.type === 'user' && !row.steered)?.text || details.title || chat.title)
      .trim().split('\n')[0].slice(0, 120);
    const commands = rows
      .filter((row) => row.type === 'tool' && ['bash', 'powershell', 'execute'].includes(row.tool))
      .slice(0, 30).map((row) => ({ command: redact(row.title).slice(0, 500), status: row.status ?? 'unknown',
        output: redact(row.text).slice(0, 3000) }));
    const files = [];
    let bytes = 0;
    for (const relative of [...names].sort().slice(0, maxChanges)) {
      const before = snapshots.has(relative) ? snapshots.get(relative) : await blob(repo.top, repo.head, relative).catch(() => undefined);
      const after = safeVersion(repo.top, relative);
      if (before !== undefined && after !== undefined && same(before, after)) continue;
      bytes += sizeOf(before) + sizeOf(after);
      if (before === undefined || after === undefined || bytes > maxTotal) {
        files.push({ path: relative, unavailable: true });
        continue;
      }
      const entry = { path: relative, before, after, applied: [],
        reversible: trackedByTools(rows, path.join(repo.top, relative), before, after),
      };
      const hunks = computedPatch(entry);
      files.push({ ...entry, hunkCount: hunks?.length ?? 0,
        wholeFile: !before || !after || before.executable !== after.executable || !hunks });
    }
    if (!files.length) return null;
    const checked = await details.afterEdits?.(target, chat.cwd);
    if (checked) commands.push(checked);
    const record = {
      id: typeof runId === 'string' && uuid.test(runId) ? runId : randomUUID(),
      runId, sessionId: chat.id, title, cwd: chat.cwd, root: repo.top, target, branch, sourceBranch: repo.branch,
      targetRevision: separate?.revision ?? childSource?.head ?? repo.head,
      revision: repo.head, harness: details.actualHarness ?? chat.harness, model: details.actualModel ?? chat.model, at, completedAt: Date.now(),
      isolated: target !== repo.top, commands, files, applications: [], truncated: names.size > maxChanges,
      checkOutcome: checked ? checked.status === 'done' ? 'passed' : 'failed' : undefined,
    };
    save(record);
    const summary = update(record);
    store.activity('review', summary.status === 'pending' ? 'Changes ready to review' : 'Recorded workspace changes',
      title + ' · ' + summary.summary, { type: 'review', id: record.id, sessionId: chat.id });
    return summary;
  }

  function read(id) {
    const record = load(id);
    const { files, applications, journal, ...metadata } = record;
    return {
      ...metadata, ...summarize(record), interrupted: Boolean(journal), canUndo: record.isolated ? Boolean(applications.length) : !record.undone && files.some(({ reversible }) => reversible),
      files: files.map((entry) => ({
        path: entry.path, source: entry.after ? path.join(record.root, entry.path) : null,
        unavailable: Boolean(entry.unavailable), applied: entry.applied ?? [], reversible: entry.reversible, hunkCount: entry.hunkCount, wholeFile: Boolean(entry.wholeFile),
        kind: entry.unavailable ? 'Uncaptured' : !entry.before ? 'Added' : !entry.after ? 'Deleted' : 'Modified',
      })),
    };
  }

  function patch(id, relative) {
    const record = load(id);
    const entry = record.files.find((file) => file.path === relative && !file.unavailable);
    if (!entry) return [];
    return (computedPatch(entry) ?? []).map((hunk, index) => ({ ...hunk, index }));
  }

  async function verifyCheckout(record, applying) {
    const root = applying ? record.target : record.root;
    const branch = applying ? record.branch : record.sourceBranch;
    const current = await checkout(root);
    if (!current || current.top !== root || current.branch !== branch ||
      (applying && !branch && current.head !== record.targetRevision)) throw new Error('The target checkout changed. Open its original branch before applying or undoing.');
    return root;
  }

  function execute(record, root, operation, changes, commit) {
    const resolved = changes.map(({ entry, expected, intended }) => {
      try {
        const location = locate(root, entry.path);
        if (!same(readVersion(root, entry.path), expected)) throw new Error('Version changed');
        return { entry, file: location.file, expected, intended };
      } catch {
        throw new Error('Conflict in ' + entry.path + '. The checkout changed. No changes were applied.');
      }
    });
    record.journal = operation;
    save(record);
    update(record);
    const written = [];
    try {
      for (const item of resolved) {
        const { file, entry, expected, intended } = item;
        if (locate(root, entry.path).file !== file || !same(readVersion(root, entry.path), expected)) {
          throw new Error('Conflict in ' + entry.path + '. The checkout changed during this operation.');
        }
        modifiedVersion(file, expected, intended);
        written.push(item);
      }
      commit();
      delete record.journal;
      save(record);
    } catch (error) {
      let restored = true;
      for (const { file, entry, expected, intended } of written.reverse()) {
        try {
          if (locate(root, entry.path).file === file && same(readVersion(root, entry.path), intended)) modifiedVersion(file, intended, expected);
          else restored = false;
        } catch { restored = false; }
      }
      if (restored) {
        const clean = load(record.id);
        delete clean.journal;
        save(clean);
        update(clean);
      } else update(load(record.id));
      throw error;
    }
    update(record);
  }

  const writing = new Set();
  async function write(id, operation) {
    if (writing.has(id)) throw new Error('A change is already in progress for this review.');
    writing.add(id);
    try {
      const record = load(id);
      if (record.journal) throw new Error('A previous change was interrupted. Inspect the files before using this review again.');
      return await operation(record);
    } finally { writing.delete(id); }
  }

  function apply(id, selected) {
    if (!Array.isArray(selected) || !selected.length || selected.length > maxChanges) throw new Error('Select changes to apply.');
    return write(id, async (record) => {
      if (!record.isolated) throw new Error('These changes are already in the same checkout.');
      const root = await verifyCheckout(record, true);
      const tasks = [], seen = new Set();
      for (const choice of selected) {
        const entry = record.files.find((file) => file.path === choice?.path && !file.unavailable);
        if (!entry || seen.has(entry.path)) throw new Error('Choose distinct review files.');
        seen.add(entry.path);
        if (entry.applied.includes(-1)) continue;
        const previous = entry.applied;
        let next = [-1];
        if (Array.isArray(choice.hunks)) {
          if (!availableHunks(entry) || !choice.hunks.length || choice.hunks.some((num) => !Number.isSafeInteger(num) || num < 0 || num >= entry.hunkCount)) {
            throw new Error('Choose valid hunks from this file.');
          }
          next = [...new Set([...previous, ...choice.hunks])].sort((a, b) => a - b);
          if (next.length === previous.length) continue;
        }
        tasks.push({ entry, previous, next, expected: bySelection(entry, previous), intended: bySelection(entry, next) });
      }
      if (!tasks.length) return read(id);
      const operation = { type: 'apply', files: tasks.map(({ entry, previous, next }) => ({ path: entry.path, previous, next })) };
      execute(record, root, operation, tasks, () => {
        for (const task of tasks) task.entry.applied = task.next;
        record.applications.push(operation.files);
      });
      store.activity('review', 'Applied reviewed changes', tasks.map(({ entry }) => entry.path).join(', '),
        { type: 'review', id });
      return read(id);
    });
  }

  function undo(id) {
    return write(id, async (record) => {
      if (!record.isolated && record.undone) throw new Error('This turn is already undone.');
      const application = record.applications.at(-1);
      if (record.isolated && !application) throw new Error('This review has no applied changes to undo.');
      const changes = record.isolated ? application.map(({ path: file, previous, next }) => {
        const entry = record.files.find(({ path }) => path === file);
        return { entry, previous, expected: bySelection(entry, next), intended: bySelection(entry, previous) };
      }) : record.files.filter(({ reversible }) => reversible).map((entry) => ({ entry, expected: entry.after, intended: entry.before }));
      if (!changes.length) throw new Error('No tracked text changes can be undone.');
      const root = await verifyCheckout(record, record.isolated);
      execute(record, root, { type: 'undo', files: changes.map(({ entry }) => entry.path) }, changes, () => {
        if (record.isolated) {
          for (const change of changes) change.entry.applied = change.previous;
          record.applications.pop();
        } else record.undone = true;
      });
      store.activity('review', record.isolated ? 'Undid last apply' : 'Undid tracked turn changes',
        changes.map(({ entry }) => entry.path).join(', '), { type: 'review', id });
      return read(id);
    });
  }

  return { workspace, createCopy, begin, finish, read, patch, apply, undo };
}

module.exports = { createReviews, fingerprintFile };
