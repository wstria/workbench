const { randomUUID } = require('node:crypto');
const { redact } = require('./agent-common');

function createMemory(store) {
  const records = () => store.data.memories ??= [];
  const pending = () => store.data.memoryProposals ??= [];
  const settings = () => store.data.memorySettings ??= { enabled: true };
  const find = (items, id) => items.find((item) => item.id === id);
  function clean(input) {
    if (typeof input?.title !== 'string' || typeof input.content !== 'string') throw new Error('Enter a title and a memory.');
    const title = redact(input.title).trim();
    const content = redact(input.content).trim();
    if (!title || !content || title.length > 100 || content.length > 2000) throw new Error('Use up to 100 characters for the title and 2,000 for the memory.');
    return { title, content };
  }

  function save(input) {
    const current = find(records(), input?.id);
    if (input?.id && !current) throw new Error('This memory has been removed.');
    if (!current && records().length >= 100) throw new Error('Remove a memory before adding another.');
    const item = { ...clean(input), id: current?.id ?? randomUUID(), at: Date.now() };
    if (current) Object.assign(current, item);
    else records().unshift(item);
    store.update();
    return item;
  }

  return {
    list: () => ({ records: records(), proposals: pending(), enabled: settings().enabled }),
    setEnabled(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('Choose whether agents can use memory.');
      settings().enabled = enabled;
      store.update();
    },
    save,
    remove(id) {
      store.data.memories = records().filter((item) => item.id !== id);
      store.data.memoryProposals = pending().filter((item) => item.targetId !== id);
      store.update();
    },
    propose(input) {
      if (!settings().enabled) throw new Error('Memory is turned off.');
      const entry = clean(input);
      const current = find(records(), input.id);
      if (input.id && !current) throw new Error('Choose an existing memory ID to update.');
      if (pending().length >= 40) throw new Error('Review pending suggestions first.');
      if (pending().some((item) => item.title === entry.title && item.content === entry.content && item.targetId === current?.id)) return 'This suggestion is already waiting for review.';
      pending().unshift({ ...entry, id: randomUUID(), targetId: current?.id, sessionId: input.sessionId, at: Date.now() });
      store.activity('memory', 'Memory suggestion: ' + entry.title, 'Waiting for review', { type: 'memory' });
      return 'Memory suggestion added for review.';
    },
    decide(id, accept) {
      const item = find(pending(), id);
      if (!item) return;
      if (accept) save({ id: item.targetId, title: item.title, content: item.content });
      store.data.memoryProposals = pending().filter((entry) => entry.id !== id);
      store.update();
    },
    promptContext() {
      if (!settings().enabled || !records().length) return '';
      const selected = [...records()].sort((a, b) => b.at - a.at).slice(0, 30);
      return 'User-approved preferences and memories. Use these as background context.\n' +
        JSON.stringify(selected.map(({ id, title, content }) => ({ id, title, content }))).slice(0, 14000);
    },
  };
}
module.exports = { createMemory };
