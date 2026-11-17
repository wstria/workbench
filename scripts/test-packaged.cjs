const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { chromium } = require('playwright-core');
const { seed, clause, passage, note, broken, fixed } = require('../test/fixtures/demo.cjs');
const { serveFixture } = require('../test/fixtures/model.cjs');
const { key: daytonaKey } = require('../test/fixtures/daytona.cjs');

const stepTimeout = 20_000;
const app = path.resolve(process.argv[2] || 'dist/mac-arm64/Workbench.app');
const baseline = process.argv[3] && path.resolve(process.argv[3]);
const scenarios = new Set((process.env.WORKBENCH_PACKAGED_SCENARIOS || 'research,review,routing,upgrade,cloud').split(','));
const executable = (bundle) => path.join(bundle, 'Contents', 'MacOS', path.basename(bundle, '.app'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(operation, description, deadline = Date.now() + stepTimeout) {
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) { lastError = error; }
    await wait(150);
  }
  throw Error('Timed out waiting for ' + description + (lastError ? ` (${lastError.message})` : ''));
}

async function start(bundle, profile, { mockDaytona = false } = {}) {
  let binary = executable(bundle);
  let inputs = [];
  if (mockDaytona) {
    binary = require('electron');
    const wrapper = path.join(profile, 'launcher.cjs');
    const resources = path.join(bundle, 'Contents', 'Resources', 'app.asar');
    const fixture = path.resolve(__dirname, '../test/fixtures/daytona.cjs');
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(wrapper, `
const electron = require('electron');
const computers = require(${JSON.stringify(path.join(resources, 'src/main/computers.js'))});
const { client } = require(${JSON.stringify(fixture)}).fakeDaytona();
const create = computers.createComputers;
computers.createComputers = (options) => create({ ...options, daytonaClient: client });
electron.app.on('browser-window-created', (_, win) => win.webContents.setBackgroundThrottling(false));
require(${JSON.stringify(path.join(resources, 'src/main/main.js'))});\n`);
    inputs = [wrapper];
  }
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/(_KEY|_TOKEN|_SECRET)$/.test(name)) delete env[name];
  delete env.ELECTRON_RUN_AS_NODE;
  await fs.rm(path.join(profile, 'DevToolsActivePort'), { force: true });
  const proc = spawn(binary, [...inputs, '--user-data-dir=' + profile, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], {
    env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let logs = '';
  proc.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-5000); });
  proc.on('error', (error) => { logs = error.message; });
  let browser;
  const finish = async () => {
    if (proc.exitCode === null && proc.signalCode === null && proc.pid) {
      const exited = once(proc, 'exit');
      proc.kill('SIGTERM');
      await Promise.race([exited, wait(1800)]);
      if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGKILL'); await exited; }
    }
    await browser?.close().catch(() => {});
  };
  try {
    const port = await eventually(async () => (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0], 'Electron debug port');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await eventually(() => browser.contexts().flatMap((context) => context.pages()).find((window) => window.url().endsWith('/renderer-dist/index.html')), 'packaged renderer');
    page.setDefaultTimeout(stepTimeout);
    await page.getByRole('navigation', { name: 'Workbench' }).waitFor();
    return { page, finish };
  } catch (error) {
    await finish();
    throw Error(error.message + '\n' + logs);
  }
}

const rail = (page, name) => page.getByRole('navigation', { name: 'Workbench' }).getByRole('button', { name, exact: true });
const active = (page) => page.locator('.stage-panel:not([hidden])');
const click = (locator) => locator.click({ force: true });
const readRun = (page, id) => page.evaluate((runId) => window.workbench.runRecord(runId), id);
async function finishedRun(page, id) {
  const run = await eventually(async () => {
    const row = await readRun(page, id);
    return !['queued', 'working', 'needs-attention'].includes(row?.status) && row;
  }, 'workbench run to finish');
  assert.equal(run.status, 'done', JSON.stringify(run));
  return run;
}

async function connect(page, address) {
  return page.evaluate(async (base) => {
    const wb = window.workbench;
    const hasModel = (await wb.listProviders()).providers.some(({ name }) => name === 'Workbench fixture');
    if (!hasModel) await wb.saveProvider({ custom: true, name: 'Workbench fixture', api: 'openai-completions',
      noAuth: true, images: true, baseUrl: base + '/v1', models: ['demo-model'] });
    const { cwd } = await wb.snapshot();
    const model = (await wb.catalog('pi', cwd)).models.find(({ modelId }) => modelId === 'demo-model').id;
    await wb.setHarnessDefaults('pi', { model, permission: 'auto' });
    return { model, cwd };
  }, address);
}

async function search(page, text) {
  await page.keyboard.press('Meta+p');
  const searchbox = page.getByRole('combobox', { name: 'Search sources' });
  await searchbox.fill(text);
  return page.getByRole('listbox', { name: 'Search results' });
}

async function research(page, fixture, data) {
  await click(rail(page, 'Web'));
  const addressBar = active(page).getByRole('textbox', { name: 'Search or enter a URL' });
  await addressBar.fill(fixture.address + '/research');
  await addressBar.press('Enter');
  const favorite = active(page).getByRole('button', { name: 'Bookmark this page', exact: true });
  await active(page).getByRole('button', { name: 'Reload page', exact: true }).waitFor();
  await eventually(async () => await favorite.isEnabled(), 'page to finish loading');
  await click(favorite);
  const anchor = await eventually(async () => {
    const files = await page.evaluate(async (sentence) => (await window.workbench.searchSources({ query: sentence })).items, passage);
    return files?.find(({ source }) => source.type === 'web');
  }, 'saved page to become searchable');
  assert.equal(anchor.source.url, fixture.address + '/research');
  assert.ok(anchor.source.captureId);
  await click(rail(page, 'New chat'));
  const found = await search(page, 'terminate this agreement');
  await found.getByRole('option').filter({ hasText: 'Harbor agreement.pdf' }).waitFor();
  await page.keyboard.press('Enter');
  await active(page).locator('canvas').first().waitFor();
  await active(page).getByLabel('Page 2 of 2', { exact: true }).waitFor();
  await click(rail(page, 'New chat'));
  const box = active(page).getByRole('textbox', { name: 'Message Pi' });
  await box.fill('Compare the two renewal sources. @terminate this agreement');
  await page.getByRole('option').filter({ hasText: 'Harbor agreement.pdf' }).getByRole('button').first().click();
  await active(page).getByRole('button', { name: 'Remove Harbor agreement.pdf', exact: true }).waitFor();
  await box.fill('Compare the two renewal sources. @thirty-day review');
  await page.getByRole('listbox', { name: 'Context sources' }).getByText('Renewal operating manual', { exact: true }).click();
  await active(page).getByRole('button', { name: 'Renewal operating manual', exact: true }).waitFor();
  await box.press('Enter');
  await active(page).getByText('The agreement needs sixty days of notice. The manual calls for a review thirty days before renewal.', { exact: true }).waitFor();
  const runId = await eventually(() => page.evaluate(async () => (await window.workbench.snapshot()).runs.find(({ title }) => title === 'Compare the two renewal sources.')?.id), 'source-backed Pi run');
  const complete = await finishedRun(page, runId);
  assert.equal(complete.excerpts.length, 2);
  assert.ok(complete.excerpts.some((item) => item.source.page === 2 && item.text.includes(clause)));
  assert.ok(complete.excerpts.some((item) => item.source.url === anchor.source.url && item.text.includes(passage)));
  await click(rail(page, 'Activity'));
  await active(page).getByText('Compare the two renewal sources.', { exact: true }).first().waitFor();
  console.log('PASS packaged research, live page capture, PDF page, @ selection, Pi source payload, Activity');
}

async function review(page, data) {
  const work = await page.evaluate(async () => {
    const wb = window.workbench;
    const { cwd } = await wb.snapshot();
    const selected = await wb.reviewWorkspace(cwd);
    const first = await wb.createSession(cwd, 'pi', null, selected);
    const second = await wb.createSession(cwd, 'pi', null, selected);
    const [one, two] = await Promise.all([wb.prompt(first.id, 'Fix the calculator A.', { permission: 'auto' }),
      wb.prompt(second.id, 'Fix the calculator B.', { permission: 'auto' })]);
    return [{ session: first, run: one }, { session: second, run: two }];
  });
  const [first, second] = await Promise.all(work.map(({ run }) => finishedRun(page, run.id)));
  assert.ok(first.reviewId && second.reviewId);
  assert.notEqual(work[0].session.cwd, work[1].session.cwd);
  const main = path.join(data.repoPath, 'add.cjs');
  const a = path.join(work[0].session.cwd, 'calculator/add.cjs');
  const b = path.join(work[1].session.cwd, 'calculator/add.cjs');
  assert.equal(await fs.readFile(main, 'utf8'), broken);
  assert.equal(await fs.readFile(a, 'utf8'), fixed);
  assert.match(await fs.readFile(b, 'utf8'), /second review/);
  await click(rail(page, 'Activity'));
  await active(page).getByRole('button', { name: 'Needs attention', exact: true }).click();
  const request = active(page).getByRole('button', { name: /Fix the calculator A/ });
  await click(request);
  await active(page).getByRole('heading', { name: 'Review changes' }).waitFor();
  const file = active(page).getByRole('checkbox', { name: 'Select calculator/add.cjs' });
  await file.check();
  await click(active(page).getByRole('button', { name: 'Apply selected' }));
  await eventually(async () => await fs.readFile(main, 'utf8') === fixed, 'selected patch to reach the main checkout');
  assert.match(await fs.readFile(b, 'utf8'), /second review/);
  const conflict = await page.evaluate(async (id) => {
    try { return await window.workbench.reviewApply(id, [{ path: 'calculator/add.cjs' }]); }
    catch (error) { return error.message; }
  }, second.reviewId);
  assert.match(JSON.stringify(conflict), /changed|conflict/i);
  assert.equal(await fs.readFile(main, 'utf8'), fixed);
  await page.evaluate((id) => window.workbench.reviewUndo(id), first.reviewId);
  assert.equal(await fs.readFile(main, 'utf8'), broken);
  console.log('PASS packaged parallel Pi worktrees, review navigation, selected apply, conflict, and undo');
}

async function routing(page, model, fixture) {
  const [success, failure] = await page.evaluate(async (model) => {
    const wb = window.workbench;
    await wb.setRoutingRules([{ harness: 'pi', model, match: 'contains', contains: 'billing' }]);
    const session = await wb.createSession();
    return Promise.all([
      wb.prompt(session.id, 'Connect the billing review fixture.', { model: '@workbench/auto', permission: 'auto' }),
      wb.prompt(session.id, 'Workbench billing fixture', { model: '@workbench/auto', permission: 'auto' }),
    ]);
  }, model);
  const selected = await finishedRun(page, success.id);
  assert.equal(selected.actualModel, model);
  assert.equal(selected.routing, 'contains');
  assert.equal(selected.usage?.total ?? (selected.usage?.input + selected.usage?.output), 66);
  const failed = await eventually(async () => {
    const record = await readRun(page, failure.id);
    return record.status === 'failed' && record;
  }, 'an unavailable model to become a failed run');
  assert.equal(failed.actualModel, model);
  assert.equal(fixture.requests.filter(({ user }) => user.includes('Workbench billing fixture')).length, 1);
  await click(rail(page, 'Activity'));
  await click(active(page).getByRole('button', { name: 'Needs attention', exact: true }));
  await active(page).getByRole('button', { name: /fixture provider is unavailable|Workbench billing fixture/ }).first().waitFor();
  console.log('PASS configured model routing, usage receipt, and failed model request without replay');
}

async function cloud(page, fixture) {
  await connect(page, fixture.address);
  await click(rail(page, 'Computers'));
  await click(page.getByRole('button', { name: 'Connect Daytona', exact: true }));
  await page.getByLabel('Daytona API key', { exact: true }).fill(daytonaKey);
  await click(page.getByRole('button', { name: 'Connect', exact: true }));
  await click(page.getByRole('button', { name: 'New computer', exact: true }));
  const provider = page.getByRole('combobox', { name: 'Computer provider' });
  if (await provider.count()) await provider.selectOption('daytona');
  await page.getByLabel('Computer name', { exact: true }).fill('Fixture desktop');
  await click(page.getByRole('button', { name: 'Create computer', exact: true }));
  const id = await eventually(() => page.evaluate(async () => (await window.workbench.computerList()).computers.find(({ name }) => name === 'Fixture desktop')?.id), 'Daytona computer');
  const desktop = page.getByRole('region', { name: 'Fixture desktop' });
  await desktop.getByRole('button', { name: 'Start', exact: true }).click();
  await desktop.getByAltText('Live desktop of Fixture desktop').waitFor();
  const run = await page.evaluate(async (id) => {
    const wb = window.workbench;
    const session = await wb.createSession(undefined, 'pi', id);
    return wb.prompt(session.id, 'Computer takeover fixture', { permission: 'auto' });
  }, id);
  await desktop.getByText('Finish the test sign-in.', { exact: true }).waitFor();
  await desktop.getByRole('button', { name: 'Take control' }).click();
  await desktop.getByText(/You have desktop control/).waitFor();
  await click(rail(page, 'Activity'));
  await click(rail(page, 'Computers'));
  await desktop.getByRole('button', { name: 'Release control' }).click();
  const completed = await finishedRun(page, run.id);
  assert.equal(completed.actualHarness, 'pi');
  const receipt = await page.evaluate(async () => (await window.workbench.snapshot()).activity.find(({ title }) => title === 'Computer artifact exported').target.path);
  assert.equal(await fs.readFile(receipt, 'utf8'), 'Fixture receipt\n');
  await desktop.getByRole('button', { name: 'Stop', exact: true }).click();
  await desktop.getByRole('button', { name: 'Start', exact: true }).waitFor();
  console.log('PASS packaged Daytona UI with SDK fixture, exclusive takeover across tab changes, resume, and artifact');
}

async function populateUpgrade(page, address, data) {
  await connect(page, address);
  await click(rail(page, 'New chat'));
  const box = active(page).getByRole('textbox', { name: 'Message Pi' });
  await box.fill('This was created before the Workbench upgrade.');
  await box.press('Enter');
  await active(page).getByText('Workbench fixture response.', { exact: true }).waitFor();
  await page.evaluate(async ({ target, address }) => {
    const wb = window.workbench;
    const before = await wb.readFile(target);
    await wb.saveFile(target, before.revision, { kind: 'text', text: before.text + '\nUpdated before upgrade.\n' });
    await wb.addFavorite({ type: 'web', name: 'Legacy bookmark', url: address + '/research' });
    await wb.saveAutomation({ name: 'Legacy daily briefing', prompt: 'Give a briefing.', time: '23:59', frequency: 'daily', weekday: 1 });
  }, { target: data.notePath, address });
  await click(rail(page, 'Automations'));
  await active(page).getByText('Legacy daily briefing', { exact: true }).first().waitFor();
  // The old binary debounces Chromium's disk commit. Check it was committed before simulating an upgrade.
  const storage = path.join(path.resolve(data.workspace, '../..'), 'Local Storage', 'leveldb');
  await eventually(async () => {
    for (const file of await fs.readdir(storage)) {
      if (/\.(log|ldb)$/.test(file) && (await fs.readFile(path.join(storage, file))).includes('"key":"automations"')) return true;
    }
    return false;
  }, 'legacy tab state to reach disk');
}

async function verifyUpgrade(page, data) {
  await active(page).getByText('Legacy daily briefing', { exact: true }).first().waitFor();
  const old = await page.evaluate(async (notePath) => {
    const wb = window.workbench;
    const [snapshot, timeline] = await Promise.all([wb.snapshot(), wb.fileTimeline(notePath)]);
    return { session: snapshot.sessions.find(({ title }) => title === 'This was created before the Workbench upgrade.'),
      bookmarked: snapshot.favorites.some(({ name }) => name === 'Legacy bookmark'), timeline };
  }, data.notePath);
  assert.ok(old.session && old.bookmarked && old.timeline.some(({ source }) => source === 'local'), JSON.stringify(old));
  assert.match(await fs.readFile(data.notePath, 'utf8'), /Updated before upgrade/);
  await page.getByRole('tab', { name: 'This was created before the Workbench upgrade.' }).click();
  await active(page).getByText('Workbench fixture response.', { exact: true }).waitFor();
  console.log('PASS older packaged profile upgrade, restored tab, session, bookmark, automation and file history');
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-packaged-'));
  const profile = path.join(root, 'fresh');
  let appProcess;
  let fixture;
  let passed = false;
  try {
    const data = await seed(path.join(profile, 'Workbench', 'workspace'), { existingDirectory: true });
    fixture = await serveFixture(data);
    appProcess = await start(app, profile);
    const { model } = await connect(appProcess.page, fixture.address);
    if (scenarios.has('research')) await research(appProcess.page, fixture, data);
    if (scenarios.has('review')) await review(appProcess.page, data);
    if (scenarios.has('routing')) await routing(appProcess.page, model, fixture);
    await appProcess.finish();
    if (scenarios.has('research')) {
      appProcess = await start(app, profile);
      const saved = await search(appProcess.page, 'thirty-day review');
      await saved.getByText('Renewal operating manual', { exact: true }).waitFor();
      await appProcess.page.keyboard.press('Escape');
      await appProcess.finish();
      console.log('PASS saved webpage survives a real packaged app restart');
    }
    if (baseline && scenarios.has('upgrade')) {
      const legacyProfile = path.join(root, 'upgrade');
      const legacy = await seed(path.join(legacyProfile, 'Workbench', 'workspace'), { existingDirectory: true });
      appProcess = await start(baseline, legacyProfile);
      await populateUpgrade(appProcess.page, fixture.address, legacy);
      await appProcess.finish();
      appProcess = await start(app, legacyProfile);
      await verifyUpgrade(appProcess.page, legacy);
      await appProcess.finish();
    }
    if (scenarios.has('cloud')) {
      appProcess = await start(app, path.join(root, 'cloud'), { mockDaytona: true });
      await cloud(appProcess.page, fixture);
    }
    assert.deepEqual(fixture.failures, []);
    passed = true;
    console.log('Packaged smoke suite passed. All provider and cloud results are fixture-based.');
  } catch (error) {
    if (appProcess?.page && !appProcess.page.isClosed()) {
      await fs.writeFile(path.join(root, 'failure.txt'), await appProcess.page.locator('body').innerText()).catch(() => {});
      await appProcess.page.screenshot({ path: path.join(root, 'failure.png'), timeout: 2000 }).catch(() => {});
    }
    throw error;
  } finally {
    await appProcess?.finish();
    fixture?.server.closeAllConnections();
    fixture?.server.close();
    if (passed && !process.env.WORKBENCH_KEEP_FIXTURE) await fs.rm(root, { force: true, recursive: true });
    else console.log('Fixture profiles: ' + root);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
