const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { createReviews, fingerprintFile } = require('../src/main/reviews');
const { createProjectChecks } = require('../src/main/project-checks');
const { createStore } = require('../src/main/store');

function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.name=Workbench Tests', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-review-')));
  const repo = path.join(root, 'source');
  const profile = path.join(root, 'profile');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  const initial = Array.from({ length: 35 }, (_, index) => 'line ' + (index + 1)).join('\n') + '\n';
  fs.writeFileSync(path.join(repo, 'code.txt'), initial);
  fs.writeFileSync(path.join(repo, 'remove.txt'), 'delete this\n');
  fs.writeFileSync(path.join(repo, 'user.txt'), 'before local edit\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Initial fixture');
  const store = createStore(profile, () => {});
  const reviews = createReviews({ store });
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return { repo, profile, initial, store, reviews };
}

test('isolates two sessions, records changes and applies and undoes selected hunks', async (t) => {
  const { repo, profile, initial, store, reviews } = fixture(t);
  const source = path.join(repo, 'code.txt');
  const user = path.join(repo, 'user.txt');
  fs.writeFileSync(user, 'keep my local edit\n');
  const info = await reviews.workspace(repo);
  assert.equal(info.branch, 'main');
  assert.equal(info.localChanges, 1);
  const [a, b] = await Promise.all([reviews.createCopy(repo, info), reviews.createCopy(repo, info)]);
  assert.notEqual(a.cwd, b.cwd);
  assert.equal(fs.readFileSync(path.join(a.cwd, 'user.txt'), 'utf8'), 'before local edit\n');
  const aSession = store.addSession(a.cwd, 'First copy', false, 'pi', a);
  const bSession = store.addSession(b.cwd, 'Second copy', false, 'pi', b);
  const aId = randomUUID();
  const [aStart, bStart] = await Promise.all([reviews.begin(aSession, { runId: aId }), reviews.begin(bSession, { runId: randomUUID() })]);
  const partial = initial.replace('line 2\n', 'first change\n');
  fs.writeFileSync(path.join(a.cwd, 'code.txt'), partial.replace('line 33\n', 'second change\n'));
  fs.writeFileSync(path.join(b.cwd, 'new.txt'), 'new file\n');
  fs.unlinkSync(path.join(b.cwd, 'remove.txt'));
  store.saveTranscript(aSession.id, [{ type: 'tool', tool: 'bash', title: 'npm test', status: 'done', text: 'All tests passed' }]);
  const [aReview, bReview] = await Promise.all([reviews.finish(aStart), reviews.finish(bStart)]);
  assert.equal(aReview.id, aId);
  assert.equal(aReview.status, 'pending');
  assert.equal(bReview.fileCount, 2);
  assert.equal(fs.readFileSync(source, 'utf8'), initial);
  assert.equal(reviews.patch(aId, 'code.txt').length, 2);
  assert.equal(reviews.read(aId).commands[0].output, 'All tests passed');
  assert.equal(reviews.read(bReview.id).files.find((file) => file.path === 'new.txt').kind, 'Added');

  const applied = await reviews.apply(aId, [{ path: 'code.txt', hunks: [0] }]);
  assert.deepEqual(applied.files[0].applied, [0]);
  assert.equal(fs.readFileSync(source, 'utf8'), partial);
  fs.writeFileSync(source, partial + 'new local edit\n');
  await assert.rejects(reviews.apply(aId, [{ path: 'code.txt', hunks: [1] }]), /Conflict in code.txt/);
  await assert.rejects(reviews.undo(aId), /Conflict in code.txt/);
  assert.equal(fs.readFileSync(source, 'utf8'), partial + 'new local edit\n');
  fs.writeFileSync(source, partial);
  const reopened = createReviews({ store: createStore(profile, () => {}) });
  await reopened.undo(aId);
  assert.equal(fs.readFileSync(source, 'utf8'), initial);
  assert.equal(fs.readFileSync(user, 'utf8'), 'keep my local edit\n');

  // A conflicting deletion in a batch must leave a non-conflicting addition unapplied.
  const remove = path.join(repo, 'remove.txt');
  fs.writeFileSync(remove, 'local deletion conflict\n');
  await assert.rejects(reopened.apply(bReview.id, [{ path: 'new.txt' }, { path: 'remove.txt' }]), /Conflict in remove.txt/);
  assert.equal(fs.existsSync(path.join(repo, 'new.txt')), false);
  fs.writeFileSync(remove, 'delete this\n');
  const finished = await reopened.apply(bReview.id, [{ path: 'new.txt' }, { path: 'remove.txt' }]);
  assert.equal(finished.status, 'reviewed');
  assert.equal(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8'), 'new file\n');
  assert.equal(fs.existsSync(remove), false);
  await reopened.undo(bReview.id);
  assert.equal(fs.existsSync(path.join(repo, 'new.txt')), false);
  assert.equal(fs.readFileSync(remove, 'utf8'), 'delete this\n');
});

test('direct undo restores only file-tool changes and refuses checkout conflicts', async (t) => {
  const { repo, initial, store, reviews } = fixture(t);
  const tracked = path.join(repo, 'code.txt');
  const untracked = path.join(repo, 'command-output.txt');
  const chat = store.addSession(repo, 'Direct editing');
  const turn = await reviews.begin(chat, { runId: randomUUID() });
  const beforeRevision = fingerprintFile(repo, tracked);
  fs.writeFileSync(tracked, 'changed in file tool\n');
  const afterRevision = fingerprintFile(repo, tracked);
  fs.writeFileSync(untracked, 'created by a command\n');
  store.saveTranscript(chat.id, [{ type: 'tool', tool: 'write', path: tracked, beforeRevision, afterRevision }]);
  const { id } = await reviews.finish(turn);
  assert.equal(reviews.read(id).canUndo, true);
  assert.equal(reviews.read(id).files.find((file) => file.path === 'command-output.txt').reversible, false);
  await assert.rejects(reviews.apply(id, [{ path: 'code.txt' }]), /same checkout/);
  git(repo, 'checkout', '-b', 'other');
  await assert.rejects(reviews.undo(id), /original branch/);
  git(repo, 'checkout', 'main');
  await reviews.undo(id);
  assert.equal(fs.readFileSync(tracked, 'utf8'), initial);
  assert.equal(fs.readFileSync(untracked, 'utf8'), 'created by a command\n');
});

test('runs an opted-in project check in the agent copy and records its exit result', async (t) => {
  const { repo, store, reviews } = fixture(t);
  const checks = createProjectChecks({ store });
  const command = {
    executable: process.execPath,
    args: ['-e', 'const text = require("fs").readFileSync("code.txt", "utf8"); console.log(text); process.exit(text.trim() === "fixture check" ? 7 : 0)'],
    afterEdits: true,
  };
  await assert.rejects(checks.save(repo, { executable: '../test', args: [] }), /absolute path/);
  await checks.save(repo, command);
  const copy = await reviews.createCopy(repo, await reviews.workspace(repo));
  const chat = store.addSession(copy.cwd, 'Checked edit', false, 'pi', copy);
  const turn = await reviews.begin(chat, { runId: randomUUID() });
  const metadata = { afterEdits: (target, cwd) => checks.afterEdits(target, cwd) };
  assert.equal(await reviews.finish(turn, metadata), null);
  const editedTurn = await reviews.begin(chat, { runId: randomUUID() });
  fs.writeFileSync(path.join(copy.cwd, 'code.txt'), 'fixture check\n');
  const review = await reviews.finish(editedTurn, metadata);
  const [record] = reviews.read(review.id).commands;
  assert.equal(review.checkOutcome, 'failed');
  assert.equal(record.exitCode, 7);
  assert.equal(record.output.trim(), 'fixture check');
  const manual = await checks.manual(repo);
  assert.equal(manual.exitCode, 0);
  assert.match(manual.output, /line 1/);
  await checks.save(repo, null);
  assert.equal(checks.afterEdits(repo, copy.cwd), null);
});
