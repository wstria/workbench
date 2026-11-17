const { BrowserWindow, Menu, WebContentsView, clipboard, session, shell } = require('electron');
const path = require('node:path');

const { searchEngines, webUrl } = require('./browser-preferences');

function address(value, engine = 'google') {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input || input.length > 4096) throw new Error('Enter a search or web address.');
  if (/^https?:/i.test(input)) return webUrl(input);
  if (/^(localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(input)) return webUrl('http://' + input);
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^[\w.-]+\.\w+:\d+(?:[/?#]|$)/.test(input)) throw new Error('Enter an HTTP or HTTPS address.');
  if (/^[\w-]+(?:\.[\w-]+)+(?:[:/?#]|$)/u.test(input) && !/\s/.test(input)) return webUrl('https://' + input);
  return (Object.hasOwn(searchEngines, engine) ? searchEngines[engine] : searchEngines.google) + encodeURIComponent(input);
}

function allowed(value) {
  try { webUrl(value); return true; } catch { return false; }
}

function createTabTools(store, workspaceDirectory, registerDownload, saveWeb) {
  const webSession = session.fromPartition('persist:workbench-web');
  let cookieFlush;
  webSession.cookies.on('changed', (_, cookie) => {
    if (cookie.session || cookieFlush) return;
    cookieFlush = setTimeout(() => {
      cookieFlush = undefined;
      void webSession.cookies.flushStore().catch(() => {});
    }, 750);
    cookieFlush.unref();
  });
  const everydayPermissions = new Set(['clipboard-sanitized-write', 'fullscreen']);
  const builtInPermission = (contents, permission, origin) =>
    Boolean(contents && !contents.isDestroyed() && allowed(contents.getURL()) && allowed(origin) && everydayPermissions.has(permission));
  webSession.setPermissionRequestHandler((contents, permission, reply, details) => reply(builtInPermission(contents, permission, details.requestingUrl)));
  webSession.setPermissionCheckHandler((contents, permission, origin) => builtInPermission(contents, permission, origin));
  const owners = new Map();
  webSession.on('will-download', (_, item) => {
    item.once('done', (_, status) => {
      if (status !== 'completed' || !item.getSavePath()) return;
      try {
        const file = registerDownload(item.getSavePath());
        store.data.browserDownloads = [{ path: file.path, name: file.name, at: Date.now() },
          ...store.data.browserDownloads.filter((entry) => entry.path !== file.path)].slice(0, 100);
        store.update();
      } catch { /* The downloaded file was moved before it could be indexed. */ }
    });
  });

  function remember(url, title) {
    if (!allowed(url)) return;
    const [latest, ...rest] = store.data.browserHistory;
    if (latest?.url === url && latest.title === title) return;
    const history = latest ? [latest, ...rest] : [];
    store.data.browserHistory = [{ url, title, at: Date.now() }, ...history.filter((entry) => entry.url !== url)].slice(0, 250);
    store.scheduleUpdate();
  }

  function owner(event) {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error('The workspace window is closed.');
    if (owners.has(window.id)) return owners.get(window.id);
    const tools = { window, contents: event.sender, browsers: new Map(), terminals: new Map() };
    const reset = () => {
      for (const id of tools.browsers.keys()) closeBrowser(tools, id);
      for (const id of tools.terminals.keys()) closeTerminal(tools, id);
    };
    tools.contents.on('did-start-navigation', (_, __, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) reset();
    });
    window.once('closed', () => { reset(); owners.delete(window.id); });
    owners.set(window.id, tools);
    return tools;
  }

  function validId(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid tab.');
  }

  function send(tools, channel, payload) {
    if (!tools.contents.isDestroyed()) tools.contents.send(channel, payload);
  }

  function closeBrowser(tools, id) {
    const state = tools.browsers.get(id);
    if (!state) return;
    tools.browsers.delete(id);
    if (!tools.window.isDestroyed()) tools.window.contentView.removeChildView(state.view);
    if (!state.view.webContents.isDestroyed()) state.view.webContents.close();
  }

  function createBrowser(tools, id) {
    const view = new WebContentsView({
      webPreferences: { session: webSession, nodeIntegration: false, contextIsolation: true, sandbox: true, plugins: true },
    });
    view.setVisible(false);
    tools.window.contentView.addChildView(view);
    const contents = view.webContents;
    const state = { view, url: '', title: '', error: '', find: null };
    tools.browsers.set(id, state);
    const publish = () => {
      if (contents.isDestroyed()) return;
      send(tools, 'wb:browser', {
        id, url: state.url, title: state.title, error: state.error, loading: contents.isLoading(),
        zoom: contents.getZoomFactor(), find: state.find,
        back: contents.navigationHistory.canGoBack(), forward: contents.navigationHistory.canGoForward(),
      });
    };
    state.navigate = (url) => {
      state.url = url;
      state.title = '';
      state.error = '';
      state.find = null;
      const load = contents.loadURL(url);
      void load.catch((error) => {
        if (contents.isDestroyed() || state.url !== url || error.code === 'ERR_ABORTED') return;
        state.error = 'Couldn’t load this page.';
        view.setVisible(false);
        publish();
      });
      publish();
      return load;
    };
    state.publish = publish;
    function publishHistory() {
      const navigation = contents.navigationHistory;
      const raw = navigation.getAllEntries();
      const index = navigation.getActiveIndex();
      if (!raw[index] || !allowed(raw[index].url)) return;
      const first = Math.max(0, index - 20);
      const group = raw.slice(first, index + 21).filter((entry) => allowed(entry.url));
      const entries = group.map(({ url, title }) => ({ url, title: title.slice(0, 240) }));
      const activeIndex = raw.slice(first, index + 1).filter((entry) => allowed(entry.url)).length - 1;
      const stack = { entries, index: activeIndex };
      const serialized = JSON.stringify(stack);
      if (state.history !== serialized) {
        state.history = serialized;
        send(tools, 'wb:browserNavigation', { id, navigation: stack });
      }
    }
    const openTab = (url, background = false) => send(tools, 'wb:browserOpen', { id, url, background });
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (allowed(url)) openTab(url, disposition === 'background-tab');
      return { action: 'deny' };
    });
    contents.on('context-menu', (_, params) => {
      const link = allowed(params.linkURL) ? params.linkURL : null;
      const selectedPage = contents.getURL();
      const selectedTitle = contents.getTitle();
      const items = [];
      if (link) {
        items.push(
          { label: 'Open link in new tab', click: () => openTab(link, true) },
          { label: 'Copy link address', click: () => clipboard.writeText(link) },
          { type: 'separator' },
        );
      }
      if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
      else if (params.selectionText) items.push({ role: 'copy' },
        { label: 'Save passage to Workbench', click: () => {
          try {
            if (contents.isDestroyed() || contents.getURL() !== selectedPage) throw new Error('This page changed. Select the passage again.');
            saveWeb?.({ type: 'web', url: selectedPage, name: selectedTitle }, params.selectionText.slice(0, 32000), true);
          } catch (error) { send(tools, 'wb:browserSaveError', error.message); }
        } });
      else items.push(
        { label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
        { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
        { label: 'Reload', click: () => contents.reload() },
      );
      if (!params.isEditable && allowed(selectedPage)) items.push({ type: 'separator' }, {
        label: params.selectionText ? 'Ask about this selection' : 'Ask about this element',
        click: async () => {
          try {
            if (contents.isDestroyed() || contents.getURL() !== selectedPage) throw new Error('This page changed. Open its menu again.');
            const selected = params.selectionText?.trim().slice(0, 3400);
            const excerpt = selected || await contents.executeJavaScriptInIsolatedWorld(109, [{ code: `(() => {
              const item = document.elementFromPoint(${Number(params.x)}, ${Number(params.y)});
              if (!item) return '';
              const target = item.closest('a, button, figure, label, nav, article, section, [role]') || item;
              if (target.closest('input, textarea, select, form, [contenteditable]') ||
                target.querySelector('input, textarea, select, form, [contenteditable]')) return '';
              const role = target.getAttribute('role');
              const label = target.getAttribute('aria-label') || target.getAttribute('alt') || target.getAttribute('title');
              const text = target.innerText?.trim() || '';
              const tag = target.tagName.toLowerCase();
              const heading = role ? tag + ' (' + role + ')' : tag;
              return [heading.slice(0, 120), label?.trim().slice(0, 300), text.slice(0, 3000)].filter(Boolean).join('\\n');
            })()` }]);
            if (contents.isDestroyed() || contents.getURL() !== selectedPage) throw new Error('This page changed. Open its menu again.');
            if (!excerpt) throw new Error('Select readable text or a non-editable element to attach.');
            const name = selectedTitle || selectedPage;
            const source = { type: 'web', url: selectedPage, name, excerpt };
            send(tools, 'wb:browserAsk', { context: { name, source,
              text: 'URL: ' + selectedPage + '\n' + (selected ? 'Selected text:\n' : 'Element:\n') + excerpt }, kind: selected ? 'selection' : 'element' });
          } catch (error) { send(tools, 'wb:browserSaveError', error.message); }
        },
      });
      Menu.buildFromTemplate(items).popup({ window: tools.window });
    });
    const guard = (event, url) => { if (!allowed(url)) event.preventDefault(); };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    const moved = (_, url, isMainFrame = true) => {
      if (!isMainFrame || !allowed(url)) return;
      state.url = url;
      state.title = url === contents.getTitle() ? '' : contents.getTitle().slice(0, 240);
      state.error = '';
      state.find = null;
      publish();
    };
    contents.on('did-navigate', (event, url) => moved(event, url));
    contents.on('did-navigate-in-page', (event, url, isMainFrame) => {
      moved(event, url, isMainFrame);
      if (isMainFrame && !state.error && allowed(url)) {
        publishHistory();
        remember(state.url, state.title);
      }
    });
    contents.on('did-start-loading', publish);
    contents.on('did-stop-loading', () => {
      publish();
      if (!state.error && contents.getURL() === state.url) {
        publishHistory();
        remember(state.url, state.title);
      }
    });
    contents.on('page-title-updated', (_, title) => {
      state.title = title === state.url ? '' : title.slice(0, 240);
      publish();
    });
    contents.on('found-in-page', (_, result) => {
      if (!result.finalUpdate || result.requestId !== state.findRequest) return;
      state.find = { active: result.activeMatchOrdinal, total: result.matches };
      publish();
    });
    contents.on('render-process-gone', (_, details) => {
      if (details.reason === 'clean-exit') return;
      state.error = 'This page closed unexpectedly.';
      view.setVisible(false);
      publish();
    });
    contents.on('did-fail-load', (_, code, __, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || !allowed(url)) return;
      state.error = 'Couldn’t load this page.';
      view.setVisible(false);
      publish();
    });
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return;
      const key = input.key.toLowerCase();
      const command = input.meta || input.control;
      const shortcut = command && !input.alt && !input.shift && ['l', 't', 'w', 'f', 'p', 'r', 'd', '=', '+', '-', '0'].includes(key);
      const reopen = command && !input.alt && input.shift && key === 't';
      const back = (input.alt && key === 'arrowleft') || (command && key === '[');
      const forward = (input.alt && key === 'arrowright') || (command && key === ']');
      const adjacent = input.control && !input.alt && key === 'tab';
      const tabNumber = command && !input.alt && !input.shift && /^[1-9]$/.test(key);
      if (!shortcut && !reopen && !back && !forward && !adjacent && !tabNumber) return;
      event.preventDefault();
      if (adjacent || tabNumber || ['l', 't', 'w', 'f', 'p'].includes(key)) tools.contents.focus();
      const action = adjacent ? (input.shift ? 'prev-tab' : 'next-tab')
        : reopen ? 'reopen' : back ? 'back' : forward ? 'forward' : key;
      send(tools, 'wb:browserShortcut', { id, key: action });

    });
    return state;
  }

  async function restoreBrowser(tools, id, value, stack) {
    const url = webUrl(value);
    const existing = tools.browsers.get(id);
    if (existing) { existing.publish(); return; }
    const state = createBrowser(tools, id);
    const { entries, index } = stack ?? {};
    const canRestore = Array.isArray(entries) && entries.length <= 41 && Number.isInteger(index) &&
      entries[index]?.url === url && entries.every((entry) => allowed(entry?.url) && typeof entry.title === 'string');
    if (!canRestore) {
      await state.navigate(url);
      return;
    }
    state.url = url;
    state.title = entries[index].title.slice(0, 240);
    const contents = state.view.webContents;
    try {
      const load = contents.navigationHistory.restore({
        entries: entries.map(({ url, title }) => ({ url: webUrl(url), title: title.slice(0, 240) })),
        index,
      });
      state.publish();
      await load;
    } catch (error) {
      if (contents.isDestroyed() || error.code === 'ERR_ABORTED' || state.url !== url) return;
      if (!state.error) await state.navigate(url);
    }
  }

  function closeTerminal(tools, id) {
    const terminal = tools.terminals.get(id);
    if (!terminal) return;
    tools.terminals.delete(id);
    try { terminal.kill(); } catch { /* Already exited. */ }
  }

  return {
    tabMenu: (event, entries, active) => {
      const tools = owner(event);
      if (!Array.isArray(entries)) return;
      const items = entries.slice(0, 150).filter(({ id, name }) => Number.isSafeInteger(id) && typeof name === 'string')
        .map(({ id, name }) => ({
          label: name.slice(0, 100).replaceAll('&', '&&'), type: 'radio', checked: id === active,
          click: () => send(tools, 'wb:chooseTab', id),
        }));
      if (items.length) Menu.buildFromTemplate(items).popup({ window: tools.window });
    },
    browserNavigate: (event, id, value) => {
      validId(id);
      const url = address(value, store.data.preferences?.searchEngine);
      const tools = owner(event);
      const state = tools.browsers.get(id) ?? createBrowser(tools, id);
      state.navigate(url);
      return url;
    },
    browserRestore: async (event, id, url, stack) => {
      validId(id);
      try { await restoreBrowser(owner(event), id, url, stack); }
      catch (error) { if (error.code !== 'ERR_ABORTED' && !error.code?.startsWith('ERR_')) throw error; }
    },
    browserBounds: (event, id, bounds) => {
      const tools = owner(event);
      const state = tools.browsers.get(id);
      if (!state) return;
      if (!bounds) { state.view.setVisible(false); return; }
      const { x, y, width, height } = bounds;
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
      const [winWidth, winHeight] = tools.window.getContentSize();
      const left = Math.max(0, Math.min(winWidth, Math.round(x)));
      const top = Math.max(0, Math.min(winHeight, Math.round(y)));
      const w = Math.min(winWidth - left, Math.round(width));
      const h = Math.min(winHeight - top, Math.round(height));
      if (w <= 0 || h <= 0) { state.view.setVisible(false); return; }
      const previous = state.view.getBounds();
      if (previous.x !== left || previous.y !== top || previous.width !== w || previous.height !== h) {
        state.view.setBounds({ x: left, y: top, width: w, height: h });
      }
      state.view.setVisible(!state.error);
    },
    browserAction: (event, id, action) => {
      const state = owner(event).browsers.get(id);
      if (!state) return;
      const contents = state.view.webContents;
      if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      if (action === 'reload' && state.url) {
        if (state.error) state.navigate(state.url);
        else contents.reload();
      }
      if (action === 'stop') contents.stop();
      if (action === 'focus') contents.focus();
      if (action === 'zoom-in' || action === 'zoom-out' || action === 'zoom-reset') {
        const current = contents.getZoomFactor();
        const factor = action === 'zoom-reset' ? 1 : Math.max(0.5, Math.min(3, Math.round((current + (action === 'zoom-in' ? 0.1 : -0.1)) * 10) / 10));
        contents.setZoomFactor(factor);
        state.publish();
      }
      if (action === 'external' && state.url) return shell.openExternal(webUrl(state.url));
    },
    browserFind: (event, id, query, direction) => {
      const state = owner(event).browsers.get(id);
      if (!state || typeof query !== 'string' || query.length > 256) return;
      const contents = state.view.webContents;
      if (!query) {
        state.find = null;
        state.findRequest = undefined;
        contents.stopFindInPage('clearSelection');
        state.publish();
      } else state.findRequest = contents.findInPage(query, { forward: direction !== 'previous', findNext: !direction });
    },
    browserCapture: async (event, id, expectedUrl, stack, save) => {
      validId(id);
      const tools = owner(event);
      if (!tools.browsers.has(id)) {
        try { await restoreBrowser(tools, id, expectedUrl, stack); }
        catch { throw new Error('Open this web page before attaching it.'); }
      }
      const state = tools.browsers.get(id);
      const contents = state?.view.webContents;
      if (!contents || state.error || !allowed(expectedUrl) || contents.getURL() !== expectedUrl || contents.isLoadingMainFrame()) {
        throw new Error('Wait for the web page to finish loading before attaching it.');
      }
      const excerpt = await contents.executeJavaScriptInIsolatedWorld(109, [{ code: `(() => {
        const selected = window.getSelection()?.toString().trim();
        const article = document.querySelector('main, article, [role="main"]');
        const page = article || document.body;
        const content = selected || page?.innerText?.trim() || '';
        return { url: location.href, text: content.slice(0, 32000), truncated: content.length > 32000, selected: Boolean(selected) };
      })()` }]);
      if (contents.isDestroyed() || !excerpt || excerpt.url !== expectedUrl || contents.getURL() !== expectedUrl) {
        throw new Error('The page changed while it was being attached. Try again.');
      }
      const name = state.title || expectedUrl;
      const header = excerpt.selected ? 'Selected text' : 'Page text';
      const source = { type: 'web', url: expectedUrl, name };
      const saved = save === true ? saveWeb?.(source, excerpt.text, excerpt.selected) : undefined;
      return { name, source: { ...source, captureId: saved?.captureId, excerpt: excerpt.text },
        text: 'URL: ' + expectedUrl + '\n' + (excerpt.text ? header + ':\n' + excerpt.text : 'No readable page text.') +
          (excerpt.truncated ? '\n[Excerpt ends here.]' : '') };
    },
    browserClose: (event, id) => closeBrowser(owner(event), id),
    terminalStart: (event, id, cols, rows, sessionId, draftCwd) => {
      validId(id);
      const tools = owner(event);
      if (tools.terminals.has(id)) return;
      const cwd = workspaceDirectory(sessionId ? store.session(sessionId).cwd : draftCwd);
      const executable = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/zsh');
      const env = { ...process.env };
      delete env.OPENAI_API_KEY;
      delete env.ELECTRON_RUN_AS_NODE;
      const terminal = require('node-pty').spawn(executable, [], {
        cwd: path.resolve(cwd), env, name: 'xterm-256color',
        cols: Math.max(2, Math.min(500, Number(cols) || 80)),
        rows: Math.max(2, Math.min(300, Number(rows) || 24)),
      });
      tools.terminals.set(id, terminal);
      terminal.onData((text) => send(tools, 'wb:terminal', { id, text }));
      terminal.onExit(({ exitCode }) => {
        if (tools.terminals.get(id) !== terminal) return;
        tools.terminals.delete(id);
        send(tools, 'wb:terminal', { id, exitCode });
      });
    },
    terminalWrite: (event, id, input) => {
      if (typeof input === 'string' && input.length <= 1024 * 1024) owner(event).terminals.get(id)?.write(input);
    },
    terminalResize: (event, id, cols, rows) => {
      if ([cols, rows].every(Number.isInteger) && cols >= 2 && cols <= 500 && rows >= 2 && rows <= 300) owner(event).terminals.get(id)?.resize(cols, rows);
    },
    terminalClose: (event, id) => closeTerminal(owner(event), id),
  };
}

module.exports = { createTabTools, address, webUrl };
