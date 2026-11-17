const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createComputers } = require('../src/main/computers.js');
const { createStore } = require('../src/main/store.js');
const { createFiles } = require('../src/main/files.js');
const { cloudDisplay, createDaytonaComputers } = require('../src/main/daytona-computers.js');
const { fakeDaytona, pixel, key } = require('./fixtures/daytona.cjs');

// Exercise the encrypted-storage boundary without depending on a system keychain in CI.
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text).reverse(),
  decryptString: (bytes) => Buffer.from(bytes).reverse().toString(),
};

function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-daytona-test-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return createStore(root, () => {});
}

function windowWithId(id) {
  return { sender: Object.assign(new EventEmitter(), { id }) };
}

async function waitFor(assertion) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(assertion(), 'Computer did not reach the expected state');
}

test('a private Daytona sandbox can be taken over, resumed, exported, stopped, and removed', async (t) => {
  const store = profile(t);
  const fixture = fakeDaytona();
  const create = (store) => createComputers({ store, files: createFiles(store, new Set()), changed() {}, safeStorage, daytonaClient: fixture.client });
  const computers = create(store);
  t.after(() => computers.close());
  const { handlers } = computers;
  const main = windowWithId(1);
  const other = windowWithId(2);
  await assert.rejects(handlers.computerConnectDaytona(main, 'bad-fixture-key'), /denied access/);
  assert.equal(handlers.computerList(main).daytona, false);
  await handlers.computerConnectDaytona(main, key);
  assert.ok(!fs.readFileSync(path.join(store.root, 'daytona.keychain')).includes(key));
  const id = await handlers.computerCreate(main, 'Fixture sandbox', 'daytona');
  await handlers.computerStart(main, id);
  await waitFor(() => handlers.computerList(main).computers[0].status === 'running');
  const [{ value: creation }] = fixture.calls.filter(({ name }) => name === 'create');
  assert.equal(creation.public, false);
  assert.equal(creation.autoStopInterval, 15);
  const image = await handlers.computerFrame(main, id);
  assert.equal(image.data, pixel);
  assert.equal(await handlers.computerFrame(main, id, image.revision), null);

  const chat = store.addSession(store.data.cwd, 'Guest fixture');
  const release = computers.lease(id, chat.id);
  const guest = Object.fromEntries(computers.tools(id).map((tool) => [tool.name, tool]));
  const handoff = guest.computer_handoff.execute('handoff', { reason: 'Sign in to the fixture.' });
  assert.equal(handlers.computerList(main).computers[0].handoff.sessionId, chat.id);
  await assert.rejects(guest.computer_screen.execute('shot', {}), /reserved for the user/);
  await handlers.computerTakeover(main, id, true);
  assert.equal(await handlers.computerFrame(other, id), null);
  await assert.rejects(handlers.computerTakeover(other, id, true), /another Workbench window/);
  await handlers.computerInput(main, id, { type: 'key', key: 'x', down: true });
  await assert.rejects(guest.computer_shell.execute('shell', { command: 'echo hello' }), /reserved for the user/);
  await handlers.computerTakeover(main, id, false);
  assert.match((await handoff).content[0].text, /released/);
  assert.equal(handlers.computerList(main).computers[0].handoff, undefined);
  assert.match((await guest.computer_shell.execute('shell', { command: 'echo hello' })).content[0].text, /fixture guest/);
  const reply = await guest.computer_export.execute('export', { path: '/tmp/receipt.txt' });
  assert.equal(fs.readFileSync(reply.details.artifact, 'utf8'), 'Fixture receipt\n');
  assert.equal(store.data.activity.find(({ title }) => title === 'Computer artifact exported').target.path, reply.details.artifact);
  release();

  // Restarting Workbench reuses the same sandbox and exposes Stop even before reconnecting.
  computers.close();
  const restarted = create(createStore(store.root, () => {}));
  t.after(() => restarted.close());
  assert.equal(restarted.handlers.computerList(main).computers[0].status, 'detached');
  await restarted.handlers.computerStop(main, id);
  assert.equal(restarted.handlers.computerList(main).computers[0].status, 'stopped');
  await restarted.handlers.computerStart(main, id);
  await waitFor(() => restarted.handlers.computerList(main).computers[0].status === 'running');
  assert.equal(fixture.calls.filter(({ name }) => name === 'create').length, 1);
  await restarted.handlers.computerStop(main, id);
  await restarted.handlers.computerRemove(main, id);
  assert.equal(fixture.sandboxes.size, 0);
  restarted.handlers.computerDisconnectDaytona(main);
  assert.equal(restarted.handlers.computerList(main).daytona, false);
});

test('a failed lookup does not provision a second sandbox and cloud errors hide remote payloads', async (t) => {
  const store = profile(t);
  const fake = fakeDaytona();
  const original = fake.client(key);
  const cloud = createDaytonaComputers({ store, safeStorage, makeClient: () => ({
    ...original, async get() { throw Object.assign(new Error('sensitive response body'), { statusCode: 403 }); },
  }) });
  await cloud.connectKey(key);
  await assert.rejects(cloud.start({ vmName: 'workbench-example' }, { onCreated: () => assert.fail(), signal: new AbortController().signal }),
    { message: 'Daytona denied access. Check the API key and its sandbox permissions.' });
  assert.equal(fake.calls.length, 0);

  const display = cloudDisplay({ computerUse: {
    keyboard: { async type() { throw new Error('sensitive host input'); } },
    screenshot: { async takeCompressed() { return { screenshot: 'invalid' }; } },
  } });
  await assert.rejects(display.key('x', true), { message: 'Daytona did not complete the request. Check your Daytona dashboard and try again.' });
  await assert.rejects(display.frame(), /invalid desktop frame/);
});
