const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright-core');
const { token, renewed } = require('../test/fixtures/inbox.cjs');
const { serveFixture } = require('../test/fixtures/model.cjs');

const binary = require('electron');
const app = path.resolve(process.argv[2] || 'dist/mac-arm64/Workbench.app');
const archive = path.join(app, 'Contents', 'Resources', 'app.asar');
const launcher = path.join(__dirname, '..', 'test', 'fixtures', 'inbox-launcher.cjs');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, description, timeout = 25000) {
  const stop = Date.now() + timeout;
  let last;
  while (Date.now() < stop) {
    try { const result = await fn(); if (result) return result; }
    catch (err) { last = err; }
    await pause(125);
  }
  throw Error(description + (last ? ': ' + last.message : ''));
}
async function launch(profile) {
  await fs.rm(path.join(profile, 'DevToolsActivePort'), { force: true });
  const env = { ...process.env, WORKBENCH_INBOX_TEST_MAIN: path.join(archive, 'src', 'main') };
  for (const key of Object.keys(env)) if (/(_KEY|_TOKEN|_SECRET)$/.test(key)) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, [launcher, '--user-data-dir=' + profile, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], {
    env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let browser;
  let mainLog = '';
  child.stderr.on('data', (chunk) => { mainLog = (mainLog + chunk).slice(-5000); });
  child.on('error', (error) => { mainLog = error.message; });
  async function stop() {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGTERM');
      await Promise.race([exit, pause(1800)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exit;
      }
    }
    await browser?.close().catch(() => {});
  }
  try {
    const port = await until(async () => (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0], 'Expected Electron debug port');
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    const page = await until(() => browser.contexts().flatMap((ctx) => ctx.pages()).find((page) => page.url().endsWith('/renderer-dist/index.html')), 'Expected packaged renderer');
    await page.getByRole('navigation', { name: 'Workbench' }).waitFor({ timeout: 10000 });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    return { page, stop, errors };
  } catch (error) {
    await stop();
    throw new Error(error.message + '\n' + mainLog);
  }
}

const active = (page) => page.locator('.stage-panel:not([hidden])');
const rail = (page, name) => page.getByRole('navigation', { name: 'Workbench' }).getByRole('button', { name, exact: true });
const inboxTab = (page) => page.getByRole('tab', { name: 'Inbox', exact: true });
const draftBody = 'Fixture: please use the final numbers from the review.';
const click = (locator) => locator.click({ force: true });

async function run() {
  await fs.access(archive);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-packaged-inbox-'));
  let models;
  let instance;
  let passed = false;
  try {
    models = await serveFixture({});
    instance = await launch(profile);
    let { page } = instance;
    await page.evaluate(async (endpoint) => {
      const wb = window.workbench;
      await wb.saveProvider({ custom: true, name: 'Fixture model', api: 'openai-completions', noAuth: true,
        baseUrl: endpoint + '/v1', models: ['demo-model'] });
      const { cwd } = await wb.snapshot();
      const model = (await wb.catalog('pi', cwd)).models.find(({ modelId }) => modelId === 'demo-model').id;
      await wb.setHarnessDefaults('pi', { model, permission: 'auto' });
    }, models.address);
    await click(rail(page, 'Integrations'));
    await click(active(page).getByRole('button', { name: 'Inbox triage' }));
    await active(page).getByLabel('Read-only JMAP API token').fill(token);
    await click(active(page).getByRole('button', { name: 'Connect', exact: true }));
    await active(page).getByText('Mailbox connected.', { exact: true }).waitFor();
    await active(page).getByText('3 threads', { exact: true }).waitFor();
    assert.equal((await active(page).getByRole('heading', { level: 2 }).first().textContent()).trim(), 'Action required today');
    await click(active(page).getByRole('button', { name: 'Run triage' }));
    await active(page).getByText('1 likely urgent · 1 other unread', { exact: true }).waitFor();
    await click(active(page).getByRole('button', { name: 'Open original' }).first());
    const requested = await until(() => fs.readFile(path.join(profile, 'original-navigation'), 'utf8'), 'Expected browser native navigation');
    assert.equal(requested, 'https://app.fastmail.com/mail/search:msgid:urgent%40example.test');
    await click(inboxTab(page));
    const draft = active(page).getByRole('button', { name: 'Review draft' }).first();
    await click(draft);
    await active(page).getByLabel('Reply draft').fill(draftBody);
    await click(active(page).getByRole('button', { name: 'Save local draft' }));
    await active(page).getByText('Draft saved in Workbench.', { exact: true }).waitFor();
    await click(active(page).getByRole('button', { name: 'Schedule a briefing' }));
    const automation = active(page);
    assert.equal(await automation.getByRole('checkbox', { name: 'Include Fastmail inbox' }).isChecked(), true);
    await click(automation.getByRole('button', { name: 'Create', exact: true }));
    await click(active(page).getByRole('button', { name: 'Run now' }));
    await active(page).getByText('Workbench fixture response.', { exact: true }).waitFor();
    assert.ok(models.requests[0].user.includes('urgent%40example.test'));
    await click(rail(page, 'Activity'));
    await click(active(page).getByRole('button', { name: /Inbox briefing Workbench fixture response/ }));
    await active(page).getByText('66 tokens', { exact: true }).waitFor();
    await active(page).getByText('Fastmail Inbox', { exact: true }).waitFor();
    assert.deepEqual(instance.errors, []);
    await instance.stop();
    instance = null;

    const workspace = path.join(profile, 'Workbench/workspace.json');
    const state = JSON.parse(await fs.readFile(workspace, 'utf8'));
    const scheduledAt = Date.now() - 100;
    state.automations.find(({ name }) => name === 'Inbox briefing').nextRunAt = scheduledAt;
    await fs.writeFile(workspace, JSON.stringify(state));
    instance = await launch(profile);
    page = instance.page;
    const runRecord = await until(() => page.evaluate(() => window.workbench.snapshot()).then((snapshot) =>
      snapshot.runs.find((item) => item.trigger === 'scheduled' && item.status === 'done')), 'Expected due briefing after restart');
    assert.equal(runRecord.scheduledAt, scheduledAt);
    assert.equal(models.requests.filter(({ user }) => user.includes('Summarize the latest Inbox threads')).length, 2);
    const saved = await page.evaluate(async () => (await window.workbench.inboxList()).drafts.find(({ threadId }) => threadId === 'T2').text);
    assert.equal(saved, draftBody);
    await fs.writeFile(path.join(profile, 'revoked'), '');
    await click(rail(page, 'Automations'));
    await click(active(page).getByRole('button', { name: 'Run now' }));
    await click(rail(page, 'Activity'));
    await click(active(page).getByRole('button', { name: 'Needs attention' }));
    await click(active(page).getByRole('button', { name: /Inbox briefing Fastmail access expired/ }));
    await active(page).getByText(/Fastmail access expired or was revoked/).waitFor();
    await click(active(page).getByRole('button', { name: 'Review mailbox connection' }));
    await active(page).getByText('Reconnect required', { exact: true }).waitFor();
    await active(page).getByLabel('Read-only JMAP API token').fill(renewed);
    await click(active(page).getByRole('button', { name: 'Connect', exact: true }));
    await active(page).getByText('Mailbox connected.', { exact: true }).waitFor();
    await click(active(page).getByRole('button', { name: 'Review draft' }).first());
    assert.equal(await active(page).getByLabel('Reply draft').inputValue(), draftBody);
    assert.equal(models.requests.length, 2);
    assert.deepEqual(models.failures, []);
    assert.deepEqual(instance.errors, []);
    passed = true;
    console.log('PASS packaged renderer inbox triage, native original URL, draft, Pi briefing receipts, due run on restart, revoked Needs attention, reconnect');
  } finally {
    await instance?.stop();
    models?.server.closeAllConnections();
    models?.server.close();
    if (passed && !process.env.WORKBENCH_KEEP_FIXTURE) await fs.rm(profile, { recursive: true, force: true });
    else console.log('Fixture profile: ' + profile);
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
