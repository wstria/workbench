const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { PDFDocument } = require('pdf-lib');
const { test } = require('node:test');
const { createStore } = require('../src/main/store');
const { createFiles } = require('../src/main/files');
const { createAttachments } = require('../src/main/attachments');
const { createSearchIndex } = require('../src/main/search-index');
const { createSources } = require('../src/main/sources');
const { sourceLink, sourceFromLink } = require('../src/main/source-reference.mjs');

test('search and receipts reopen the exact PDF page, text line, saved passage and chat message', async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-source-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'fixture-data');
  let store = createStore(root, () => {});
  let files = createFiles(store);
  let attachments = createAttachments();
  let sources = createSources(store, files, attachments);
  let index = createSearchIndex({ store, files });
  const workspace = store.data.cwd;
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  await fs.writeFile(path.join(workspace, '.gitignore'), 'staging-notes.txt\n');
  await fs.writeFile(path.join(workspace, 'staging-notes.txt'), 'unique ignore fixture\n');
  assert.deepEqual((await index.search({ cwd: workspace, query: 'unique ignore fixture' })).items, []);

  const note = path.join(workspace, 'Procurement notes.md');
  await fs.writeFile(note, '---\ntags: [work/procurement]\n---\n\nThe agreed vendor discount is eight percent.\n');
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('Introduction to the master services agreement.');
  pdf.addPage().drawText('Receipts must arrive within fourteen business days.');
  const pdfPath = path.join(workspace, 'Signed agreement.pdf');
  await fs.writeFile(pdfPath, await pdf.save());

  const passage = 'The supplier must maintain cyber insurance throughout the renewal period.';
  const saved = sources.saveWeb({ type: 'web', url: 'https://example.com/contract', name: 'Vendor portal' }, passage, true);
  sources.updateFavorite('web:' + saved.url, { tags: ['work/procurement'], notes: '' });
  index.save({ query: '#work' });
  const scopedSearch = index.save({ query: '#work', cwd: workspace });
  const chat = store.addSession(workspace, 'Contract walkthrough');
  store.saveTranscript(chat.id, [
    { id: 'message-first', type: 'user', text: 'What are the financial terms?' },
    { id: 'message-second', type: 'assistant', text: 'The term is coterminous with the order form.' },
  ]);

  const results = await index.search({ cwd: workspace, query: '"fourteen business days"', rebuild: true });
  const [result] = results.items;
  assert.equal(result.source.path, pdfPath);
  assert.equal(result.source.page, 2);
  const encoded = sourceLink(result.source);
  assert.equal(sourceFromLink(encoded).page, 2);

  const [noteResult] = (await index.search({ query: 'vendor discount' })).items;
  assert.equal(noteResult.source.line, 5);
  assert.equal(noteResult.source.path, note);
  assert.deepEqual((await index.search({ query: '#work' })).items.map((item) => item.source.type).sort(), ['file', 'web']);
  assert.deepEqual((await index.search({ query: '#work', cwd: workspace })).items.map((item) => item.source.type), ['file']);
  assert.deepEqual((await index.search({ query: '#work', cwd: workspace, includeShared: true })).items.map((item) => item.source.type).sort(), ['file', 'web']);
  const [chatResult] = (await index.search({ query: 'coterminous' })).items;
  assert.equal(chatResult.source.messageId, 'message-second');
  const receipt = await sources.capture({ ...result.source, excerpt: result.excerpt });
  const prepared = await attachments.prepare([], [receipt]);
  assert.match(prepared.text[0], /Page 2\nReceipts must arrive within fourteen business days/);
  assert.equal(prepared.sources[0].excerpt, result.excerpt);
  assert.match(prepared.text[0], /workbench:\/\/source\?/);

  const moved = path.join(workspace, 'Archived agreement.pdf');
  await fs.rename(pdfPath, moved);
  await assert.rejects(index.relink(result.source, note), /does not match/);
  await index.relink(result.source, moved);
  assert.equal(sources.resolvePath(sourceFromLink(encoded)), moved);

  store = createStore(root, () => {});
  files = createFiles(store);
  attachments = createAttachments();
  index = createSearchIndex({ store, files });
  sources = createSources(store, files, attachments);
  assert.equal(sources.resolvePath(sourceFromLink(encoded)), moved);
  assert.deepEqual(store.data.savedSearches[0], scopedSearch);
  assert.equal(store.data.savedSearches[1].query, '#work');
  const [archived] = (await index.search({ query: 'insurance throughout' })).items;
  assert.equal(archived.source.captureId, saved.captureId);
  assert.match((await sources.capture(archived.source)).text, /insurance throughout/);
  assert.equal((await index.search({ query: 'fourteen business days' })).items[0].source.path, moved);
});
