const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/main/store');
const { createFiles } = require('../src/main/files');
const { createKnowledge, noteData } = require('../src/main/knowledge');

async function fixture(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-vault-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const vaultPath = path.join(temporary, 'Notes');
  const projects = path.join(vaultPath, 'Projects');
  const plugins = path.join(vaultPath, '.obsidian', 'plugins', 'sample');
  await fs.mkdir(projects, { recursive: true });
  await fs.mkdir(plugins, { recursive: true });
  const write = (name, text) => fs.writeFile(path.join(vaultPath, name), text);
  const guide = '---\ntitle: Workshop Guide\ntags:\n  - planning/Workshop\naliases: ["The Guide"]\n---\n# Guide\nLuminous index keyword. #urgent\n[Agenda](Projects/Day%20One.md#notes)\n[[Map.svg|Attachment]]';
  await write('Guide.md', guide);
  await write('Projects/Day One.md', '# Day One\nRead [[The Guide]] about the workshop. #planning/workshop');
  await write('Map.svg', '<svg xmlns="http://www.w3.org/2000/svg" />');
  await write('.obsidian/plugins/sample/private.md', 'Vault plugin secret marker');
  await fs.writeFile(path.join(temporary, 'outside.md'), '# Outside source secret marker');
  await fs.symlink(path.join(temporary, 'outside.md'), path.join(vaultPath, 'excluded.md'));
  const store = createStore(path.join(temporary, 'data'), () => {});
  store.data.memories = [{ id: 'approved', title: 'Prefer workshops', content: 'Read [[Guide]] when planning. #planning/workshop', at: Date.now() }];
  store.data.favorites = [{ key: 'web:https://example.invalid/', type: 'web', name: 'Reference site', url: 'https://example.invalid/',
    tags: ['planning/workshop'], notes: 'Saved example', at: Date.now() }];
  const files = createFiles(store);
  const knowledge = createKnowledge({ store, files });
  return { temporary, vaultPath, guide, knowledge, files };
}

test('opens an Obsidian vault in place and searches Markdown text, metadata and nested tags', async (t) => {
  const { vaultPath, guide, knowledge, files } = await fixture(t);
  const linked = await knowledge.addVault(vaultPath);
  assert.equal(linked.isObsidian, true);
  assert.equal((await knowledge.addVault(vaultPath)).id, linked.id);
  assert.equal(knowledge.list().length, 1);
  const terms = await knowledge.search({ vaultId: linked.id, query: '"luminous index" tag:planning', kind: 'note' });
  assert.deepEqual(terms.items.map((item) => item.title), ['Workshop Guide']);
  assert(terms.items[0].tags.includes('planning/workshop'));
  assert(terms.items[0].excerpt.includes('Luminous index keyword'));
  assert.equal(files.read(terms.items[0].source.path).text, guide);
  assert.equal((await knowledge.search({ query: 'secret marker' })).total, 0);

  knowledge.removeVault(linked.id);
  assert.equal((await knowledge.search({ query: 'luminous index' })).total, 0);
  assert.equal(await fs.readFile(path.join(vaultPath, 'Guide.md'), 'utf8'), guide);
});

test('resolves original wikilink and Markdown targets and builds honest note and approved-memory edges', async (t) => {
  const { vaultPath, knowledge } = await fixture(t);
  await knowledge.addVault(vaultPath);
  const guide = path.join(vaultPath, 'Guide.md');
  const agenda = path.join(vaultPath, 'Projects', 'Day One.md');
  assert.equal(await knowledge.resolveLink(guide, 'Projects/Day%20One.md#notes', 'markdown'), agenda);
  assert.equal(await knowledge.resolveLink(agenda, 'The Guide', 'wiki'), guide);
  assert.equal(await knowledge.resolveLink(guide, 'Map.svg', 'wiki'), path.join(vaultPath, 'Map.svg'));
  assert.equal(await knowledge.resolveLink(guide, 'excluded.md', 'wiki'), null);
  assert.equal(await knowledge.resolveLink(guide, '../outside.md', 'markdown'), null);
  assert.equal(await knowledge.resolveLink(guide, '.obsidian/plugins/sample/private.md', 'wiki'), null);
  const relations = await knowledge.relations(guide);
  assert.deepEqual(relations.backlinks.map((item) => item.path), [agenda]);
  assert.deepEqual(relations.related.map((item) => item.path), [agenda]);
  const { nodes, edges } = await knowledge.graph({ mode: 'memory' });
  for (const id of [`file:${guide}`, `file:${agenda}`, 'memory:approved', 'tag:planning/workshop']) assert(nodes.find((item) => item.id === id));
  assert(edges.some((edge) => edge.from === 'memory:approved' && edge.to === `file:${guide}` && edge.kind === 'link'));
  assert(edges.some((edge) => edge.from === 'web:https://example.invalid/' && edge.to === 'tag:planning/workshop'));
  assert(edges.some((edge) => edge.from === `file:${agenda}` && edge.to === `file:${guide}`));
});

test('retains bounded metadata and ignores tags and links in source code examples', () => {
  const parsed = noteData('---\ntags: [Finance, finance, example/nested]\n---\n#weekly `#code [[Literal]]`\n```md\n#sandbox [[Example]]\n```\n[[Source|Real link]]');
  assert.deepEqual(parsed.tags, ['finance', 'example/nested', 'weekly']);
  assert.deepEqual(parsed.links, [{ kind: 'wiki', target: 'Source' }]);
});
