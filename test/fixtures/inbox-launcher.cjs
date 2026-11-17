const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const fixture = require('./inbox.cjs');

const main = process.env.WORKBENCH_INBOX_TEST_MAIN;
if (!main || !path.isAbsolute(main)) throw new Error('Provide the absolute packaged main path.');
const inbox = require(path.join(main, 'inbox.js'));
const mailbox = fixture.fixture({ revoked: () => fs.existsSync(path.join(electron.app.getPath('userData'), 'revoked')) });
const create = inbox.createInbox;
inbox.createInbox = (options) => create({ ...options, safeStorage: fixture.safeStorage, request: mailbox.request });
electron.app.on('browser-window-created', (_, window) => window.webContents.setBackgroundThrottling(false));
void electron.app.whenReady().then(() => {
  electron.session.fromPartition('persist:workbench-web').protocol.handle('https', (request) => {
    const url = new URL(request.url);
    if (url.origin !== 'https://app.fastmail.com' || !url.pathname.startsWith('/mail/search:msgid:')) {
      return new Response('Unexpected fixture navigation', { status: 404 });
    }
    fs.writeFileSync(path.join(electron.app.getPath('userData'), 'original-navigation'), url.href);
    return new Response('<h1>Fastmail original fixture</h1>', { headers: { 'Content-Type': 'text/html' } });
  });
});
require(path.join(main, 'main.js'));
