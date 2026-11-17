const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function atomicWrite(file, contents, mode = 0o600) {
  const temporary = path.join(path.dirname(file), '.' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temporary, contents, { mode, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function createStore(root, onChange) {
  const folders = Object.fromEntries(['workspace', 'artifacts', 'sessions', 'pi'].map((name) => {
    const folder = path.join(root, name);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    return [name, folder];
  }));
  const index = path.join(root, 'workspace.json');
  const data = {
    sessions: [], artifacts: [], automations: [], activity: [], favorites: [], openFolders: [], browserHistory: [], browserDownloads: [],
    model: 'gpt-5.4-mini', harness: 'pi', harnessDefaults: {}, ...readJson(index, {}), cwd: folders.workspace,
  };
  const sessionFile = (id) => path.join(folders.sessions, id + '.json');
  let scheduledUpdate;
  const update = () => {
    clearTimeout(scheduledUpdate);
    scheduledUpdate = undefined;
    atomicWrite(index, JSON.stringify(data, null, 2));
    onChange();
  };
  const scheduleUpdate = () => {
    scheduledUpdate ??= setTimeout(update, 140);
  };
  const flush = () => {
    if (scheduledUpdate) update();
  };
  const activity = (kind, title, description, target) => {
    data.activity.unshift({ id: randomUUID(), kind, title, description, target, at: Date.now() });
    update();
  };
  return {
    root, folders, data, update, scheduleUpdate, flush, activity,
    addSession(cwd, title, readOnly = false, harness = 'pi', extra = {}) {
      const session = { id: randomUUID(), cwd, title, readOnly, harness, createdAt: Date.now(), ...extra };
      data.sessions.unshift(session);
      update();
      return session;
    },
    session(id) {
      const result = data.sessions.find((item) => item.id === id);
      if (!result) throw new Error('Session not found.');
      return result;
    },
    transcript(id) {
      return readJson(sessionFile(id), []);
    },
    saveTranscript(id, entries) {
      atomicWrite(sessionFile(id), JSON.stringify(entries, null, 2));
    },
  };
}

module.exports = { createStore, atomicWrite };
