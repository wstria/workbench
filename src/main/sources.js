const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { webUrl } = require('./tab-tools');

const pageNames = {
  settings: 'Settings', automations: 'Automations', activity: 'Activity',
  integrations: 'Integrations', artifacts: 'Artifacts', favorites: 'Favorites', browser: 'Web', files: 'Files', changes: 'Changes', computers: 'Computers', terminal: 'Terminal',
};

function listDirectory(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((item) => !item.name.startsWith('.') && item.name !== 'node_modules' && (item.isDirectory() || item.isFile()))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 300)
    .map((item) => ({ path: path.join(directory, item.name), name: item.name, directory: item.isDirectory() }));
}

function createSources(store, files, attachments) {
  const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 10000000 ? value : undefined;
  function resolvePath(input) {
    const alias = typeof input.fingerprint === 'string' && store.data.sourceAliases?.[input.path + ':' + input.fingerprint];
    return files.authorize(alias || input.path);
  }

  function normalize(input) {
    switch (input?.type) {
      case 'web': {
        const url = webUrl(input.url);
        const name = typeof input.name === 'string' ? input.name.trim().slice(0, 240) : '';
        const captureId = (store.data.webCaptures ?? []).find((item) => item.url === url &&
          (!input.captureId || input.captureId === item.captureId))?.captureId;
        return { type: 'web', url, name: name || new URL(url).hostname, ...(captureId && { captureId }) };
      }
      case 'file':
      case 'folder': {
        const file = resolvePath(input);
        const status = fs.statSync(file);
        if (input.type === 'file' ? !status.isFile() : !status.isDirectory()) throw new Error('The source has moved.');
        return { type: input.type, path: input.fingerprint ? input.path : file, name: path.basename(file) || file,
          line: positive(input.line), page: positive(input.page),
          fingerprint: /^[a-f\d]{64}$/.test(input.fingerprint ?? '') ? input.fingerprint : undefined };
      }
      case 'session': {
        const session = store.session(input.id);
        return { type: 'session', id: session.id, name: session.title,
          messageId: /^[\w-]{1,128}$/.test(input.messageId ?? '') ? input.messageId : undefined };
      }
      case 'automation-edit': {
        const task = store.data.automations.find((item) => item.id === input.id);
        if (!task) throw new Error('Save this automation before bookmarking it.');
        return { type: 'automation-edit', id: task.id, name: task.name };
      }
      case 'page':
        if (Object.hasOwn(pageNames, input.page)) return { type: 'page', page: input.page, name: pageNames[input.page] };
        break;
    }
    throw new Error('Choose an available Workbench source.');
  }

  async function capture(input, draft) {
    const source = normalize(input);
    let text;
    const snippet = typeof input.excerpt === 'string' ? input.excerpt.slice(0, 3400) : '';
    if (snippet.trim() && (source.line || source.page)) {
      const location = source.page ? 'Page ' + source.page : 'Line ' + source.line;
      return { name: source.name, source: { ...source, excerpt: snippet }, text: location + '\n' + snippet };
    }
    switch (source.type) {
      case 'file':
        if (typeof draft !== 'string') {
          const [file] = await attachments.register([resolvePath(source)]);
          return { name: file.name, source, path: file.path };
        }
        text = 'Unsaved editor buffer for ' + source.path + ':\n' + draft.slice(0, 32000);
        if (draft.length > 32000) text += '\n[Excerpt ends here.]';
        break;
      case 'folder':
        text = 'Folder: ' + source.path + '\n' + listDirectory(source.path)
          .map((entry) => entry.name + (entry.directory ? '/' : '')).join('\n');
        break;
      case 'session': {
        const saved = store.transcript(source.id);
        const message = source.messageId && saved.find((entry) => entry.id === source.messageId && ['user', 'assistant'].includes(entry.type));
        if (typeof message?.text === 'string') {
          text = message.text.slice(0, 32000);
          break;
        }
        const messages = saved.filter((entry) => ['user', 'assistant'].includes(entry.type))
          .slice(-18).map((entry) => entry.type + ': ' + (entry.text ?? '').slice(-8000));
        text = messages.join('\n\n').slice(-32000) || 'This chat has no saved messages yet.';
        break;
      }
      case 'automation-edit': {
        const { prompt, frequency, time, cwd, paused } = store.data.automations.find((item) => item.id === source.id);
        text = ['Schedule: ' + [frequency, time].filter(Boolean).join(' '), 'Status: ' + (paused ? 'Paused' : 'Active'),
          cwd && 'Workspace: ' + cwd, prompt].filter(Boolean).join('\n');
        break;
      }
      case 'page': {
        const data = store.data;
        const summaries = {
          automations: () => data.automations.slice(0, 100).map((item) => item.name + (item.paused ? ' (paused)' : '')).join('\n'),
          activity: () => data.activity.slice(0, 30).map((item) => item.title).join('\n'),
          artifacts: () => data.artifacts.slice(0, 100).map((item) => item.name).join('\n'),
          favorites: () => data.favorites.slice(0, 100).map((item) => item.name).join('\n'),
          browser: () => 'Workbench browser start page.',
          settings: () => 'Default harness: ' + data.harness + '\nPi default model: ' + data.model,
          integrations: () => 'Workbench integrations and provider connections.',
          files: () => data.openFolders.join('\n'),
          changes: () => 'Repository changes and file versions.',
          computers: () => 'Workbench local computers.',
          terminal: () => 'Workbench terminal.',
        };
        text = summaries[source.page]() || 'There are no items on this page yet.';
        break;
      }
      case 'web': {
        const capture = (store.data.webCaptures ?? []).find((item) => source.captureId === item.captureId);
        text = 'URL: ' + source.url + (capture ? '\n' + capture.excerpt : '');
        break;
      }
    }
    return { name: source.name, source: { ...source, excerpt: text.slice(0, 34000) }, text: text.slice(0, 34000) };
  }

  function addFavorite(input) {
    const source = normalize(input);
    const key = source.type + ':' + (source.url ?? source.path ?? source.id ?? source.page);
    if (store.data.favorites.some((item) => item.key === key)) return;
    store.data.favorites = [{ ...source, key, at: Date.now() }, ...store.data.favorites];
    store.update();
  }

  return {
    capture, resolvePath, addFavorite,
    saveWeb(source, excerpt, selected = false) {
      const { url, name } = normalize(source);
      if (!excerpt) throw new Error('There is no readable page text to save.');
      const captures = store.data.webCaptures ?? [];
      const found = captures.find((record) => record.url === url && record.excerpt === excerpt);
      const saved = found ?? { captureId: randomUUID(), url, name, excerpt, selected, at: Date.now() };
      store.data.webCaptures = [saved, ...captures.filter((record) => record.captureId !== saved.captureId)].slice(0, 160);
      const existing = store.data.favorites.find((item) => item.type === 'web' && item.url === url);
      if (existing) existing.captureId = saved.captureId;
      else store.data.favorites = [{ type: 'web', url, name, captureId: saved.captureId, key: 'web:' + url, at: Date.now() }, ...store.data.favorites];
      store.update();
      return saved;
    },
    updateFavorite(key, input) {
      const favorite = store.data.favorites.find((item) => item.key === key);
      if (!favorite) throw new Error('This favorite was removed.');
      if (!Array.isArray(input?.tags) || input.tags.length > 20 || typeof input.notes !== 'string' || input.notes.length > 3000 ||
        input.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 60)) {
        throw new Error('Use up to 20 tags and 3,000 characters of notes.');
      }
      favorite.tags = [...new Set(input.tags.map((tag) => tag.trim().replace(/^#+/, '').toLowerCase()).filter(Boolean))];
      favorite.notes = input.notes.trim();
      store.update();
    },
    removeFavorite(key) {
      store.data.favorites = store.data.favorites.filter((item) => item.key !== key);
      store.update();
    },
  };
}

module.exports = { createSources, listDirectory };
