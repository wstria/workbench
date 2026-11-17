const { app, BrowserWindow, dialog, ipcMain, nativeTheme, session } = require('electron');
const path = require('node:path');
const { registerWorkbench } = require('./workbench');

const nativeFiles = [];
let notifyNativeFiles;
app.on('open-file', (event, file) => {
  event.preventDefault();
  nativeFiles.push(file);
  notifyNativeFiles?.();
  if (app.isReady() && !BrowserWindow.getAllWindows().length) createWindow();
});

const isMac = process.platform === 'darwin';

function createWindow() {
  nativeTheme.themeSource = 'dark';

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#000000',
    movable: true,
    resizable: true,
    show: false,
    title: 'Workbench',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-prevent-unload', (event) => {
    const answer = dialog.showMessageBoxSync(window, {
      type: 'question',
      message: 'Close Workbench and discard unsaved file edits?',
      buttons: ['Keep editing', 'Discard edits'],
      defaultId: 0,
      cancelId: 0,
    });
    if (answer === 1) event.preventDefault();
  });
  window.once('ready-to-show', () => window.show());
  window.loadFile(path.join(__dirname, '../../renderer-dist/index.html'));

  // Let the UI know when the window is fullscreen: macOS hides the traffic
  // lights there, so the toolbar can drop its left gutter.
  const syncFullscreen = () => {
    window.webContents
      .executeJavaScript(
        `document.documentElement.classList.toggle('is-fullscreen', ${window.isFullScreen()})`
      )
      .catch(() => {});
  };
  window.on('enter-full-screen', syncFullscreen);
  window.on('leave-full-screen', syncFullscreen);
  window.webContents.on('did-finish-load', syncFullscreen);
}

if (app.requestSingleInstanceLock()) {
  app.whenReady().then(() => {
    notifyNativeFiles = registerWorkbench(nativeFiles);
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    app.on('second-instance', () => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) {
        createWindow();
        return;
      }
      if (window.isMinimized()) window.restore();
      window.focus();
    });
  });
} else {
  app.quit();
}

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

app.on('before-quit', () => {
  if (app.isReady()) session.defaultSession.flushStorageData();
});

ipcMain.handle('app:platform', () => process.platform);

ipcMain.on('window:appearance', (event, scheme, background) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || (scheme !== 'light' && scheme !== 'dark')) return;
  if (typeof background !== 'string' || !/^#[0-9a-f]{6}$/i.test(background)) return;

  nativeTheme.themeSource = scheme;
  window.setBackgroundColor(background);
});

ipcMain.on('window:resize-start', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) window.__resizeStartBounds = window.getBounds();
});

ipcMain.on('window:resize', (event, payload) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !payload?.edge || !window.__resizeStartBounds) return;

  const { edge, dx = 0, dy = 0 } = payload;
  const bounds = window.__resizeStartBounds;
  const [minWidth, minHeight] = window.getMinimumSize();
  const next = { ...bounds };

  if (edge.includes('e')) next.width = Math.max(minWidth, bounds.width + dx);
  if (edge.includes('s')) next.height = Math.max(minHeight, bounds.height + dy);

  if (edge.includes('w')) {
    const width = Math.max(minWidth, bounds.width - dx);
    next.x = bounds.x + bounds.width - width;
    next.width = width;
  }

  if (edge.includes('n')) {
    const height = Math.max(minHeight, bounds.height - dy);
    next.y = bounds.y + bounds.height - height;
    next.height = height;
  }

  window.setBounds(next);
});

ipcMain.on('window:resize-end', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) delete window.__resizeStartBounds;
});
