const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, clipboard, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite, createStore } = require('./store');
const { createFiles } = require('./files');
const { createAgent } = require('./agent');
const { createOpenCodeAgent } = require('./opencode-agent');
const { createOpenCodeClient } = require('./opencode-client');
const { createAutomation } = require('./automation');
const { createAttachments } = require('./attachments');
const { readPdfResource } = require('./pdf');
const { createTabTools } = require('./tab-tools');
const { createBrowserImports } = require('./browser-import');
const { validateBrowserPreferences } = require('./browser-preferences');
const { createTurnQueue } = require('./turn-queue');
const { createRunJournal } = require('./run-journal');
const { createTeamSessions } = require('./team-sessions');
const { createReviews } = require('./reviews');
const { createProjectChecks } = require('./project-checks');
const { createEditorLanguages } = require('./editor-languages');
const { createProviders } = require('./providers');
const { createComputers } = require('./computers');
const { noteLinks } = require('./note-links');
const { createKnowledge } = require('./knowledge');
const { createMemory } = require('./memory');
const { createUsage } = require('./usage');
const { createNativeHarnesses } = require('./native-harnesses');
const { createIntegrations } = require('./integrations');
const { createInbox } = require('./inbox');
const { createSources, listDirectory } = require('./sources');
const { createSearchIndex } = require('./search-index');
const { sourceLink, sourceFromLink } = require('./source-reference.mjs');

function registerWorkbench(nativeFiles = []) {
  const notify = (name, payload) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(name, payload);
  };
  const root = path.join(app.getPath('userData'), 'Workbench');
  const store = createStore(root, () => notify('wb:changed'));
  const appearanceFile = path.join(root, 'appearance.json');
  let savedAppearance;
  const browserImports = createBrowserImports({ store, home: app.getPath('home') });
  const inheritedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const providers = createProviders({ store, safeStorage, inheritedKey });

  const chosenWorkspaces = new Set();
  function workspaceDirectory(cwd) {
    const folder = cwd ?? store.data.cwd;
    if (folder !== store.data.cwd && !chosenWorkspaces.has(folder) && !store.data.openFolders.includes(folder) && !store.data.sessions.some((session) => session.cwd === folder)) {
      throw new Error('Choose a workspace folder first.');
    }
    if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error('The workspace folder is no longer available.');
    return folder;
  }

  const files = createFiles(store, chosenWorkspaces);
  const editorLanguages = createEditorLanguages({ home: app.getPath('home'),
    authorize: files.authorize, publish: (event) => notify('wb:editor-problems', event) });
  const attachments = createAttachments();
  const sources = createSources(store, files, attachments);
  const sourceIndex = createSearchIndex({ store, files, workspaceFolders: () => [...chosenWorkspaces] });
  const computers = createComputers({ store, changed: notify, safeStorage, files });
  const memory = createMemory(store);
  const knowledge = createKnowledge({ store, files });
  const integrations = createIntegrations({ store, safeStorage });
  const inbox = createInbox({ store, safeStorage });
  const client = createOpenCodeClient(store, app.getPath('home'));
  const usage = createUsage({ store, subscriptionStatus: () => client.usageLimits?.(store.data.cwd) ?? [] });
  const reviews = createReviews({ store });
  const projectChecks = createProjectChecks({ store });
  const team = createTeamSessions({ store, submit: (...args) => turns.submit(...args) });
  const runs = createRunJournal({ store });
  const lastApproval = new Map();
  const turns = createTurnQueue({ store, runs, agentFor: (id) => agentFor(id),
    assertAttachments: attachments.assertPicked, restoreAttachments: attachments.restorePicked,
    beforeRun: (...args) => automations.prepare(...args),
    onFinish: (run) => automations.finish(run),
    send(event) {
      team.observe(event);
      notify('wb:transcript', event);
      const pending = event.approvals?.at(-1)?.id;
      if (!pending) lastApproval.delete(event.id);
      else if (lastApproval.get(event.id) !== pending) {
        lastApproval.set(event.id, pending);
        const windows = BrowserWindow.getAllWindows();
        if (Notification.isSupported() && windows.length && !windows.some((window) => window.isFocused())) {
          const message = new Notification({ title: 'Workbench needs your input', body: 'An agent is waiting for a tool approval.' });
          message.on('click', () => {
            const window = BrowserWindow.getAllWindows()[0];
            if (!window) return;
            if (window.isMinimized()) window.restore();
            window.focus();
            notify('wb:review-approval', event.id);
          });
          message.show();
        }
      }
    },
  });
  const agentOptions = { store, files, team, computers, memory, usage, integrations, prepareAttachments: attachments.prepare, send: (event) => turns.publish(event.id, event) };
  const pi = createAgent({ ...agentOptions, providers });
  const opencode = createOpenCodeAgent({ ...agentOptions, client });
  const runtimes = createNativeHarnesses({ ...agentOptions, home: app.getPath('home') });
  const automations = createAutomation(store, turns, { runs, workspaceDirectory, inbox, integrations });
  const agents = new Map([['pi', pi], ['opencode', opencode], ...runtimes.agents]);
  function validateHarness(harness) {
    if (!agents.has(harness)) throw new Error('Choose a supported harness.');
    return harness;
  }
  const agentFor = (id) => {
    const chat = store.session(id);
    const agent = agents.get(validateHarness(chat.harness ?? 'pi'));
    return { ...agent, async run(sessionId, text, options) {
      const unavailable = (error) => {
        const reason = String(error.message ?? error).slice(0, 400);
        options?.reportRun?.({ reviewError: reason });
        store.activity('review', 'Could not record workspace changes', reason, { type: 'session', id });
      };
      const start = await reviews.begin(chat, options).catch((error) => { unavailable(error); return null; });
      if (start) options?.reportRun?.({ startingRevision: start.repo.head,
        targetBranch: chat.reviewWorkspace ? chat.reviewWorkspace.branch : start.repo.branch });
      try { return await agent.run(sessionId, text, options); }
      finally {
        const review = await reviews.finish(start, {
          ...runs.get(options?.runId),
          afterEdits: (target, cwd) => projectChecks.afterEdits(target, cwd, options),
        }).catch((error) => { unavailable(error); return null; });
        if (review) options?.reportRun?.({ reviewId: review.id, checkOutcome: review.checkOutcome });
      }
    } };
  };
  async function catalog(harness, cwd, refresh) {
    validateHarness(harness);
    const directory = fs.realpathSync(workspaceDirectory(cwd));
    const available = harness === 'opencode' ? await client.catalog(directory, refresh)
      : harness === 'pi' ? await providers.catalog() : await runtimes.catalog(harness, directory, refresh);
    return usage.withRouting(available, harness);
  }
  async function importIntegration(event, name, extensions, load) {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Import ' + name, properties: ['openFile'], filters: [{ name, extensions }],
    });
    if (!result.canceled) return load(result.filePaths[0]);
  }

  const selectedExecutables = new Set();
  const handlers = {
    loadAppearance: () => {
      try {
        savedAppearance = fs.readFileSync(appearanceFile, 'utf8');
        return JSON.parse(savedAppearance);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return null;
      }
    },
    saveAppearance: (_, theme) => {
      if (!theme || typeof theme !== 'object' || Array.isArray(theme)) throw new Error('Choose valid appearance settings.');
      const value = JSON.stringify(theme);
      if (Buffer.byteLength(value) > 512 * 1024) throw new Error('The saved appearance library is too large.');
      if (value === savedAppearance) return;
      atomicWrite(appearanceFile, value);
      savedAppearance = value;
    },
    ...computers.handlers,
    sessionFamily: (_, id) => team.family(id),
    ...runtimes.handlers,
    ...usage.handlers,
    inboxList: () => inbox.list(),
    inboxConnect: (_, token) => inbox.connect(token),
    inboxDisconnect: () => inbox.disconnect(),
    inboxRefresh: () => inbox.refresh(),
    inboxTriage: () => inbox.triage(),
    inboxSaveDraft: (_, id, draft) => inbox.saveDraft(id, draft),
    listIntegrations: () => integrations.list(),
    saveIntegration: (_, input) => integrations.save(input),
    toggleIntegration: (_, id, enabled) => integrations.setEnabled(id, enabled),
    removeIntegration: (_, id) => integrations.remove(id),
    inspectIntegration: (_, id) => integrations.inspect(id),
    importSkill: (event) => importIntegration(event, 'Agent skill', ['md'], (file) => integrations.importSkill(file)),
    importExtension: (event) => importIntegration(event, 'Pi extension', ['ts', 'js', 'mjs'], (file) => integrations.importExtension(file)),
    memoryList: () => memory.list(),
    memorySave: (_, input) => memory.save(input),
    memoryRemove: (_, id) => memory.remove(id),
    memoryEnabled: (_, enabled) => memory.setEnabled(enabled),
    memoryDecide: (_, id, accept) => memory.decide(id, accept === true),
    savePreferences: (_, input) => {
      const { editorWrap, lineNumbers } = input ?? {};
      if (typeof editorWrap !== 'boolean' || typeof lineNumbers !== 'boolean') {
        throw new Error('Choose valid editor preferences.');
      }
      store.data.preferences = { ...store.data.preferences, editorWrap, lineNumbers };
      store.update();
    },
    saveBrowserPreferences: (_, input) => {
      store.data.preferences = { ...store.data.preferences, ...validateBrowserPreferences(input) };
      store.update();
    },
    browserChromeHelp: () => shell.openExternal('https://support.google.com/chrome/answer/165139'),
    browserOpenChrome: async () => {
      const locations = ['/Applications', path.join(app.getPath('home'), 'Applications')];
      for (const directory of locations) {
        const chrome = path.join(directory, 'Google Chrome.app');
        if (fs.existsSync(chrome) && !await shell.openPath(chrome)) return;
      }
      throw new Error('Chrome could not be opened. Open Chrome from Applications and sign in there.');
    },
    browserImportProfiles: () => browserImports.list(),
    browserPreviewProfile: (event, id) => browserImports.profile(event.sender, id),
    browserChooseImport: async (event, kind) => {
      if (kind !== 'profile' && kind !== 'bookmarks') throw new Error('Choose a browser profile or bookmarks file.');
      const isProfile = kind === 'profile';
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), isProfile
        ? { title: 'Choose browser profile folder', properties: ['openDirectory', 'showHiddenFiles'] }
        : { title: 'Import bookmarks', properties: ['openFile'], filters: [{ name: 'Bookmark exports', extensions: ['html', 'htm', 'zip'] }] });
      if (result.canceled) return null;
      const [selected] = result.filePaths;
      return isProfile ? browserImports.folder(event.sender, selected) : browserImports.file(event.sender, selected);
    },
    browserApplyImport: (event, token, options) => browserImports.apply(event.sender, token, options),
    browserExportBookmarks: async (event) => {
      const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
        title: 'Export bookmarks', defaultPath: 'workbench-bookmarks.html',
        filters: [{ name: 'Bookmarks', extensions: ['html'] }],
      });
      if (result.canceled || !result.filePath) return false;
      await fs.promises.writeFile(result.filePath, browserImports.export(), { encoding: 'utf8', mode: 0o600 });
      return true;
    },
    saveProfile: (_, input) => {
      if (typeof input?.name !== 'string' || input.name.length > 60) throw new Error('Enter a display name up to 60 characters.');
      store.data.profile = { name: input.name.trim() };
      store.update();
    },
    chooseKnowledgeVault: async (event) => {
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: 'Connect a Markdown vault', properties: ['openDirectory'],
      });
      return result.canceled ? null : knowledge.addVault(result.filePaths[0]);
    },
    knowledgeList: () => knowledge.list(),
    knowledgeRemoveVault: (_, id) => knowledge.removeVault(id),
    knowledgeSearch: (_, input) => knowledge.search(input),
    knowledgeGraph: (_, input) => knowledge.graph(input),
    knowledgeResolveLink: (_, ...args) => knowledge.resolveLink(...args),
    noteLinks: async (_, file, folder) => await knowledge.relations(file) ?? noteLinks(files, file, folder),
    fileTimeline: (_, file) => files.timeline(file),
    fileVersionPreview: (_, ...args) => files.versionPreview(...args),
    restoreFileVersion: (_, ...args) => {
      const file = files.restoreVersion(...args);
      knowledge.invalidate(file.path);
      sourceIndex.invalidate();
      return file;
    },
    workspaceChanges: (_, folder, file) => files.changes(folder || store.data.cwd, file),
    openNativeFiles: () => nativeFiles.splice(0).flatMap((file) => {
      try { return [files.register(file)]; } catch { return []; }
    }),
    ...createTabTools(store, workspaceDirectory, (file) => files.register(file, false, false), sources.saveWeb),
    snapshot: () => {
      const { webCaptures, sourceAliases, ...visible } = store.data;
      return { ...visible, runs: runs.list(), root };
    },
    searchSources: (_, input) => sourceIndex.search(input),
    saveSourceSearch: (_, input) => sourceIndex.save(input),
    removeSourceSearch: (_, id) => sourceIndex.remove(id),
    copySourceLink: (_, source) => {
      const link = sourceLink(source);
      if (!sourceFromLink(link)) throw new Error('Choose a source to link.');
      clipboard.writeText(link);
      return link;
    },
    openIndexedFile: (_, source) => files.register(sources.resolvePath(source)),
    relinkIndexedFile: async (event, source) => {
      const selected = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: 'Locate the original source', properties: ['openFile'],
      });
      if (selected.canceled) return null;
      return sourceIndex.relink(source, selected.filePaths[0]);
    },
    chooseWorkspace: async (event, cwd) => {
      const parent = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(parent, {
        title: 'Choose workspace folder', defaultPath: cwd && chosenWorkspaces.has(cwd) ? cwd : store.data.cwd,
        properties: ['openDirectory'],
      });
      if (result.canceled) return null;
      const folder = fs.realpathSync(result.filePaths[0]);
      if (!fs.statSync(folder).isDirectory()) throw new Error('Choose a workspace folder.');
      chosenWorkspaces.add(folder);
      if (!store.data.openFolders.includes(folder)) {
        store.data.openFolders = [folder, ...store.data.openFolders];
        store.update();
      }
      return folder;
    },
    chooseFiles: async (event, cwd) => {
      const parent = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(parent, {
        title: 'Open files in Workbench', defaultPath: workspaceDirectory(cwd), properties: ['openFile', 'multiSelections'],
      });
      return result.canceled ? [] : result.filePaths.map((file) => files.register(file));
    },
    chooseAttachments: async (event, cwd) => {
      const parent = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(parent, {
        title: 'Attach files to message', defaultPath: workspaceDirectory(cwd), properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled) return [];
      const items = await attachments.register(result.filePaths);
      return items.map((item) => {
        files.register(item.path, false, false);
        return { ...item, source: { type: 'file', path: item.path, name: item.name } };
      });
    },
    chooseFolder: async (event) => {
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: 'Open folder in Workbench', defaultPath: app.getPath('home'), properties: ['openDirectory'],
      });
      if (result.canceled) return null;
      const folder = fs.realpathSync(result.filePaths[0]);
      if (!fs.statSync(folder).isDirectory()) throw new Error('Choose a folder.');
      if (!store.data.openFolders.includes(folder)) {
        store.data.openFolders.push(folder);
        store.update();
      }
      return { path: folder, name: path.basename(folder) || folder };
    },
    addFavorite: (_, input) => sources.addFavorite(input),
    updateFavorite: (_, key, input) => sources.updateFavorite(key, input),
    removeFavorite: (_, key) => sources.removeFavorite(key),
    captureSource: (_, input, draft) => sources.capture(input, draft),
    listFiles: (_, input) => listDirectory(files.authorize(input || store.data.cwd)),
    revealFile: (_, file) => shell.showItemInFolder(files.authorize(file)),
    openWorkspaceFile: (_, input) => files.register(files.authorize(input)),
    readFile: (_, file) => files.read(file),
    readSheet: (_, ...args) => files.sheet(...args),
    pdfResource: (_, kind, filename) => readPdfResource(kind, filename),
    saveFile: async (_, ...args) => {
      const file = await files.save(...args);
      knowledge.invalidate(file.path);
      sourceIndex.invalidate();
      return file;
    },
    createArtifact: (_, kind, cwd) => files.create(kind, kind === 'note' && cwd ? workspaceDirectory(cwd) : undefined),
    openExternal: async (_, file) => {
      const error = await shell.openPath(files.authorize(file));
      if (error) throw new Error(error);
    },
    revealData: async (_, scope) => {
      const error = await shell.openPath(scope === 'workspace' ? store.data.cwd : root);
      if (error) throw new Error(error);
    },
    reviewWorkspace: (_, cwd) => reviews.workspace(workspaceDirectory(cwd)),
    reviewRead: (_, id) => reviews.read(id),
    reviewPatch: (_, id, file) => reviews.patch(id, file),
    reviewApply: (_, id, choices) => reviews.apply(id, choices),
    reviewUndo: (_, id) => reviews.undo(id),
    projectCheck: (_, cwd) => projectChecks.setup(workspaceDirectory(cwd)),
    saveProjectCheck: (_, cwd, input) => projectChecks.save(workspaceDirectory(cwd), input),
    runProjectCheck: (_, cwd) => projectChecks.manual(workspaceDirectory(cwd)),
    editorLanguageSync: (_, cwd, file, text) => editorLanguages.sync(fs.realpathSync(workspaceDirectory(cwd)), file, text),
    editorLanguageClose: (_, cwd, file) => editorLanguages.closeDocument(fs.realpathSync(workspaceDirectory(cwd)), file),
    editorDefinition: (_, cwd, file, text, position) => editorLanguages.definition(fs.realpathSync(workspaceDirectory(cwd)), file, text, position),
    createSession: async (_, cwd, harness = store.data.harness, computerId, separate) => {
      if (!computerId) {
        const source = workspaceDirectory(cwd);
        validateHarness(harness);
        const copy = separate ? await reviews.createCopy(source, separate) : null;
        if (copy && !store.data.openFolders.includes(source)) store.data.openFolders.push(source);
        return store.addSession(copy?.cwd ?? source, 'New session', false, harness, copy ?? {});
      }
      const name = computers.name(computerId);
      if (!name || harness !== 'pi') throw new Error('Choose an available computer for a Pi chat.');
      return store.addSession(store.data.cwd, name, false, 'pi', { computerId });
    },
    transcript: (_, id) => turns.snapshot(id),
    runRecord: (_, id) => runs.read(id),
    retryRun: (_, id) => turns.retry(id),
    catalog: (_, harness, cwd, refresh) => catalog(harness, cwd, refresh === true),
    prompt: (_, id, input, options) => turns.submit(id, input, options),
    steer: (_, id, messageId) => turns.steer(id, messageId),
    removeQueued: (_, id, messageId) => turns.remove(id, messageId),
    resumeQueue: (_, id) => turns.resume(id),
    decide: (_, id, requestId, allowed) => agentFor(id).decide(id, requestId, allowed),
    stop: (_, id) => turns.stop(id),
    setHarness: (_, harness) => {
      store.data.harness = validateHarness(harness);
      store.update();
    },
    setHarnessDefaults: async (_, harness, changes) => {
      validateHarness(harness);
      const { model, permission } = changes ?? {};
      if (permission !== undefined && !['ask', 'auto'].includes(permission)) throw new Error('Choose Auto or Ask.');
      if (model !== undefined && model !== '') {
        const available = await catalog(harness);
        if (!available.models.some((item) => item.id === model)) throw new Error('Choose a model from this harness.');
      }
      const defaults = { ...store.data.harnessDefaults[harness] };
      if (model !== undefined) {
        if (harness === 'pi') {
          if (!model) throw new Error('Choose a Pi model.');
          store.data.model = model;
        } else defaults.model = model;
      }
      if (permission !== undefined) defaults.permission = permission;
      store.data.harnessDefaults[harness] = defaults;
      store.update();
    },
    pickOpenCode: async (event) => {
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: 'Choose the OpenCode executable', properties: ['openFile'],
        defaultPath: store.data.opencodePath ?? app.getPath('home'),
      });
      if (result.canceled) return null;
      const executable = fs.realpathSync(result.filePaths[0]);
      if (!fs.statSync(executable).isFile()) throw new Error('Choose the OpenCode executable.');
      fs.accessSync(executable, fs.constants.X_OK);
      selectedExecutables.add(executable);
      return executable;
    },
    setOpenCodePath: (_, executable) => {
      if (executable !== null && !selectedExecutables.has(executable)) throw new Error('Choose the executable first.');
      if (opencode.busy()) throw new Error('Stop active OpenCode turns before changing the executable.');
      store.data.opencodePath = executable;
      client.close();
      store.update();
    },
    reconnectOpenCode: () => {
      if (opencode.busy()) throw new Error('Stop active OpenCode turns before reconnecting.');
      client.close();
    },
    saveAutomation: (_, input) => automations.save(input),
    pauseAutomation: (_, id, paused) => automations.setPaused(id, paused),
    runAutomation: (_, id) => automations.run(id),
    removeAutomation: (_, id) => automations.remove(id),
    listProviders: () => providers.list(),
    saveProvider: (_, input) => providers.save(input),
    removeProvider: (_, id) => providers.remove(id),
    discoverModels: (_, input) => providers.discover(input),
  };

  for (const [name, operation] of Object.entries(handlers)) {
    ipcMain.handle('wb:' + name, (event, ...args) => {
      if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || !event.senderFrame.url.startsWith('file:')) {
        throw new Error('Workspace operations are only available in the desktop app.');
      }
      return operation(event, ...args);
    });
  }
  process.once('SIGTERM', () => app.quit());
  app.on('before-quit', () => {
    turns.close();
    store.flush();
    automations.dispose();
    team.close();
    pi.stopAll();
    opencode.stopAll();
    runtimes.close();
    integrations.close();
    editorLanguages.dispose();
    computers.close();
    client.close();
  });
  return () => notify('wb:nativeFiles');
}

module.exports = { registerWorkbench };
