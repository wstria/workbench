const fs = require('node:fs/promises');
const { accessSync, constants } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { Duplex } = require('node:stream');
const { BrowserWindow, dialog, nativeImage } = require('electron');
const { redact } = require('./agent-common');
const { connectComputerDisplay, keySymbol } = require('./computer-display');
const { createDaytonaComputers, cloudDisplay, providerError } = require('./daytona-computers');

const isCloud = (record) => record.provider === 'daytona';
const isRunning = (state) => Boolean(state?.process || state?.sandbox);
const artifactLimit = 1024 * 1024;
const artifactExtensions = new Set(['.txt', '.md', '.json', '.csv', '.tsv', '.png', '.jpg', '.jpeg', '.webp', '.pdf', '.xlsx', '.log']);


const tartRelease = 'https://github.com/openai/tart/releases/download/2.41.1/tart.tar.gz';
const tartChecksum = 'e680a734febccfce7d4e910c1f7f13fc3b00f19a181c945e2d746de3214c32c2';
const ubuntuImage = 'ghcr.io/cirruslabs/ubuntu:24.04';
const maximumOutput = 200 * 1024;
const retryDelay = 3000;
const desktopReady = ['socat', 'tigervncserver', 'startxfce4'].map((command) => 'command -v ' + command + ' >/dev/null').join(' && ');
const desktopInstall = [
  'set -eu',
  'sudo -n apt-get -o DPkg::Lock::Timeout=180 -q update',
  'sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=180 -q -y --no-install-recommends install dbus-x11 fonts-dejavu-core socat tigervnc-standalone-server xfce4 xfce4-terminal libgtk-3-0t64 libasound2t64',
].join('\n');
const desktopStart = [
  'set -eu',
  'mkdir -p "$HOME/.local/share/workbench-desktop"',
  'starter="$HOME/.local/share/workbench-desktop/xstartup"',
  'printf "%s\\n" "#!/bin/sh" "exec dbus-launch --exit-with-session startxfce4" > "$starter"',
  'chmod 700 "$starter"',
  'if ! socat -u OPEN:/dev/null TCP:127.0.0.1:5901,connect-timeout=1 2>/dev/null; then',
  '  tigervncserver :1 -localhost yes -SecurityTypes None -geometry 1280x800 -depth 24 -xstartup "$starter"',
  'fi',
].join('\n');
const browserInstall = [
  'set -eu',
  'app_dir="$HOME/.local/share/workbench-apps"',
  'firefox="$app_dir/firefox/firefox"',
  'mkdir -p "$app_dir" "$HOME/.local/bin" "$HOME/.local/share/applications"',
  'if [ ! -x "$firefox" ]; then',
  '  staging="$(mktemp -d "$app_dir/.firefox-XXXXXX")"',
  '  trap \'rm -rf -- "$staging"\' EXIT',
  '  curl -fsSL --max-time 480 \'https://download.mozilla.org/?product=firefox-latest-ssl&os=linux64-aarch64&lang=en-US\' -o "$staging/archive.tar.xz"',
  '  tar -xJf "$staging/archive.tar.xz" -C "$staging"',
  '  "$staging/firefox/firefox" --version',
  '  mv "$staging/firefox" "$app_dir/firefox"',
  'fi',
  'ln -sfn "$firefox" "$HOME/.local/bin/firefox"',
  'printf "%s\\n" "[Desktop Entry]" "Type=Application" "Name=Firefox" "Exec=$firefox %u" "Terminal=false" "Icon=$app_dir/firefox/browser/chrome/icons/default/default64.png" "Categories=Network;WebBrowser;" > "$HOME/.local/share/applications/workbench-firefox.desktop"',
].join('\n');

function canExecute(file) {
  if (!file) return false;
  try { accessSync(file, constants.X_OK); return true; }
  catch { return false; }
}

function safeError(error) {
  return redact(error?.message ?? String(error)).replace(/vnc:\/\/[^\s]+/g, 'desktop session').trim().slice(0, 280);
}

function createComputers({ store, changed, safeStorage, files, daytonaClient }) {
  const cloud = createDaytonaComputers({ store, safeStorage, makeClient: daytonaClient });
  const supported = process.platform === 'darwin' && process.arch === 'arm64';
  const root = path.join(store.root, 'Computers');
  const tartHome = path.join(root, 'Tart');
  const managedRuntime = path.join(root, 'runtime', 'tart.app', 'Contents', 'MacOS', 'tart');
  const environment = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: os.homedir(),
    TMPDIR: os.tmpdir(),
    LANG: 'en_US.UTF-8',
    TART_HOME: tartHome,
    DO_NOT_TRACK: '1',
  };
  const states = new Map();
  const children = new Set();
  const agentLeases = new Map();
  let setup = null;
  let shuttingDown = false;
  store.data.computers ??= [];

  function runtime() {
    if (!supported) return null;
    return [store.data.computerRuntime, managedRuntime, '/opt/homebrew/bin/tart', '/usr/local/bin/tart',
      '/Applications/tart.app/Contents/MacOS/tart'].find(canExecute) ?? null;
  }

  function machine(id) {
    const found = store.data.computers.find((item) => item.id === id);
    if (!found || !/^workbench-[0-9a-f-]{36}$/.test(found.vmName)) throw new Error('Computer not found.');
    return found;
  }

  function snapshot(senderId) {
    return {
      supported,
      runtime: Boolean(runtime()),
      installing: Boolean(setup),
      daytona: cloud.configured(),
      computers: store.data.computers.map(({ id, name, image, createdAt, browserInstalled, provider, handoff, cloudMayBeRunning }) => {
        const state = states.get(id);
        return { id, name, image, createdAt, provider: provider ?? 'local', handoff, cloudMayBeRunning, status: state?.status ?? (cloudMayBeRunning ? 'detached' : 'stopped'),
          detail: state?.detail ?? '', progress: state?.progress,
          controlled: state?.owner != null, owned: state?.owner === senderId, guestRunning: isRunning(state), browserInstalled: Boolean(browserInstalled),
          installingBrowser: Boolean(state?.browserJob) };
      }),
    };
  }

  function publish() { if (!shuttingDown) changed('wb:computer-change'); }

  function update(state, status, detail = '', progress) {
    Object.assign(state, { status, detail, progress });
    publish();
  }

  function runCommand(executable, args, options = {}) {
    const { timeout = 60_000, output, signal, outputLimit = maximumOutput } = options;
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      // Running inside the guest stays distinct from the Electron process and its provider environment.
      const child = spawn(executable, args, { env: environment, cwd: root, stdio: ['ignore', 'pipe', 'pipe'], signal });
      children.add(child);
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('The computer command timed out.'));
      }, timeout);
      timer.unref();
      child.stdout.on('data', (value) => {
        const data = value.toString();
        stdout = (stdout + data).slice(-outputLimit);
        output?.(data);
      });
      child.stderr.on('data', (value) => { stderr = (stderr + value.toString()).slice(-outputLimit); });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        children.delete(child);
        resolve({ code, stdout, stderr });
      });
    });
  }

  async function tart(args, options) {
    const executable = runtime();
    if (!executable) throw new Error('Set up the Tart runtime before launching a computer.');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return runCommand(executable, args, options);
  }

  async function requireSuccess(promise, fallback) {
    const result = await promise;
    if (result.code !== 0) throw new Error(safeError(result.stderr || fallback));
    return result.stdout;
  }

  async function guestShell(record, command, options = {}) {
    const state = states.get(record.id);
    if (state?.sandbox) {
      options.signal?.throwIfAborted();
      try {
        const response = await state.sandbox.process.executeCommand(command, undefined, undefined, Math.ceil((options.timeout ?? 60_000) / 1000));
        options.signal?.throwIfAborted();
        return { code: response.exitCode, stdout: String(response.result ?? '').slice(-(options.outputLimit ?? maximumOutput)), stderr: '' };
      } catch (error) {
        options.signal?.throwIfAborted();
        throw providerError(error);
      }
    }
    if (!state?.process) throw new Error('Start the computer before running a command.');
    return tart(['exec', record.vmName, '/bin/sh', '-c', command], options);
  }

  async function install() {
    if (!supported) throw new Error('Local computers require Apple Silicon.');
    if (runtime()) return;
    if (setup) return setup;
    setup = (async () => {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      // Cloud-synced workspace folders can add Finder metadata to freshly extracted bundles.
      // Verify the signed bundle in the system temp directory before moving it to app storage.
      const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-tart-'));
      try {
        const response = await fetch(tartRelease, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error('The Tart release could not be downloaded.');
        const content = Buffer.from(await response.arrayBuffer());
        if (content.length > 32 * 1024 * 1024 || createHash('sha256').update(content).digest('hex') !== tartChecksum) {
          throw new Error('The Tart release did not match its published checksum.');
        }
        const archive = path.join(staging, 'tart.tar.gz');
        await fs.writeFile(archive, content, { mode: 0o600 });
        await requireSuccess(runCommand('/usr/bin/tar', ['--no-xattrs', '--no-mac-metadata', '-xzf', archive, '-C', staging]), 'Could not unpack the Tart release.');
        const bundle = path.join(staging, 'tart.app');
        await requireSuccess(runCommand('/usr/bin/codesign', ['--verify', '--strict', bundle]), 'Could not verify the Tart signature.');
        const runtimeFolder = path.join(root, 'runtime');
        await fs.mkdir(runtimeFolder, { recursive: true, mode: 0o700 });
        const destination = path.join(runtimeFolder, 'tart.app');
        try { await fs.rename(bundle, destination); }
        catch (error) {
          if (error.code !== 'EXDEV') throw error;
          const transfer = await fs.mkdtemp(path.join(runtimeFolder, '.install-'));
          try {
            const verified = path.join(transfer, 'tart.app');
            await fs.cp(bundle, verified, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
            await fs.rename(verified, destination);
          } finally { await fs.rm(transfer, { recursive: true, force: true }); }
        }
        await requireSuccess(tart(['--version']), 'Could not initialize the Tart runtime.');
      } finally { await fs.rm(staging, { recursive: true, force: true }); }
    })();
    publish();
    try { await setup; }
    finally { setup = null; publish(); }
  }

  async function pickRuntime(event) {
    if (!supported) throw new Error('Local computers require Apple Silicon.');
    if (setup || [...states.values()].some(({ process, pending }) => process || pending)) {
      throw new Error('Stop the existing computers before changing the runtime.');
    }
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Choose the Tart executable or app',
      properties: ['openFile'],
    });
    if (result.canceled) return;
    const chosen = await fs.realpath(result.filePaths[0]);
    const executable = chosen.endsWith('.app') ? path.join(chosen, 'Contents', 'MacOS', 'tart') : chosen;
    if (!canExecute(executable)) throw new Error('A Tart executable was not found in that location.');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const version = await requireSuccess(runCommand(executable, ['--version'], { timeout: 5000 }), 'This executable is not a compatible Tart runtime.');
    if (!/^2\.(?:[4-9]\d|\d{3,})\.\d+/u.test(version.trim())) throw new Error('Choose Tart 2.40 or newer.');
    store.data.computerRuntime = executable;
    store.update();
    publish();
  }

  async function create(name, provider = 'local') {
    if (!['local', 'daytona'].includes(provider)) throw new Error('Choose a supported computer provider.');
    if (provider === 'local' && !runtime()) throw new Error('Set up the Tart runtime before creating a computer.');
    if (provider === 'daytona' && !cloud.configured()) throw new Error('Connect Daytona in Computers first.');
    const label = typeof name === 'string' ? name.trim() : '';
    if (!label || label.length > 80) throw new Error('Enter a computer name up to 80 characters.');
    if (store.data.computers.length >= 12) throw new Error('Remove a stopped computer before creating another one.');
    const id = randomUUID();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    store.data.computers.push({ id, name: label, vmName: 'workbench-' + id, image: provider === 'daytona' ? 'Daytona Linux' : 'Ubuntu 24.04', provider, createdAt: Date.now(), cloned: false });
    store.update();
    publish();
    return id;
  }

  function stopDesktop(state) {
    state.display?.close();
    state.display = undefined;
    state.latest = undefined;
    state.displayRevision = undefined;
    state.bridge?.kill('SIGTERM');
    state.bridge = undefined;
  }

  function connectDesktop(record, state) {
    stopDesktop(state);
    const bridge = spawn(runtime(), ['exec', '-i', record.vmName, '/usr/bin/socat', 'STDIO', 'TCP:127.0.0.1:5901'], {
      env: environment, cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    });
    state.bridge = bridge;
    bridge.stderr.resume();
    bridge.on('error', () => {});
    bridge.on('close', () => {
      if (state.bridge !== bridge) return;
      state.bridge = undefined;
    });
    const duplex = Duplex.from({ writable: bridge.stdin, readable: bridge.stdout });
    state.display = connectComputerDisplay(duplex, (error) => {
      if (state.bridge !== bridge || state.signal.aborted) return;
      stopDesktop(state);
      state.retryAt = Date.now() + retryDelay;
      update(state, 'running', 'The desktop connection is reconnecting. ' + safeError(error));
    });
  }

  function launch(record, state) {
    if (state.signal.aborted) return;
    const proc = spawn(runtime(), ['run', record.vmName, '--no-graphics', '--no-audio', '--no-clipboard'], {
      env: environment, cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.process = proc;
    let errors = '';
    proc.stdout.resume();
    proc.stderr.on('data', (data) => { errors = (errors + data.toString()).slice(-8000); });
    proc.on('error', (error) => { errors = safeError(error); });
    proc.on('close', (code) => {
      if (state.process !== proc) return;
      state.process = undefined;
      state.removeOwnerListener?.();
      state.removeOwnerListener = undefined;
      state.owner = undefined;
      state.controller.abort();
      finishHandoff(state, new Error('The computer stopped before the handoff completed.'));
      stopDesktop(state);
      if (state.status === 'stopping' || code === 0) update(state, 'stopped');
      else update(state, 'error', safeError(errors || 'The virtual machine stopped unexpectedly.'));
    });
  }

  async function waitForGuest(record, signal) {
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let attempt = 0; attempt < 45; attempt += 1) {
      signal.throwIfAborted();
      try {
        const result = await guestShell(record, 'true', { timeout: 4000, signal });
        if (result.code === 0) return;
      } catch (error) { if (signal.aborted) throw error; }
      await pause(1200);
    }
    throw new Error('The Ubuntu guest did not finish starting. Stop it and try again.');
  }

  async function start(id) {
    const record = machine(id);
    if (isCloud(record)) return startCloud(record);
    if (!runtime()) throw new Error('Set up the Tart runtime before starting a computer.');
    const old = states.get(id);
    if (old?.process && old.desktopConfigured && !old.display) {
      connectDesktop(record, old);
      return;
    }
    if (old?.process || old?.pending) throw new Error('The computer is already running.');
    if ([...states.values()].filter(({ process, pending, provider }) => provider !== 'daytona' && (process || pending)).length >= 2) {
      throw new Error('Stop another computer before starting this one.');
    }
    const controller = new AbortController();
    const state = { controller, signal: controller.signal, pending: true, status: 'starting' };
    states.set(id, state);
    update(state, 'starting', record.cloned ? 'Starting Ubuntu' : 'Preparing the Ubuntu image');
    void (async () => {
      try {
        if (!record.cloned) {
          let lastProgress;
          const progress = (data) => {
            const percentages = [...data.matchAll(/(\d{1,3})%/g)];
            const value = Number(percentages.at(-1)?.[1]);
            if (Number.isFinite(value) && value >= 0 && value <= 100 && value !== lastProgress) {
              lastProgress = value;
              update(state, 'starting', 'Downloading the Ubuntu image', value);
            }
          };
          const existing = await tart(['get', record.vmName], { signal: state.signal });
          if (existing.code !== 0) {
            await requireSuccess(tart(['clone', ubuntuImage, record.vmName], { timeout: 45 * 60_000, output: progress, signal: state.signal }),
              'Could not prepare the Ubuntu image.');
          }
          record.cloned = true;
          store.update();
          update(state, 'starting', 'Starting Ubuntu');
        }
        state.signal.throwIfAborted();
        launch(record, state);
        await waitForGuest(record, state.signal);
        const desktop = await guestShell(record, desktopReady, { signal: state.signal });
        if (desktop.code !== 0) {
          update(state, 'starting', 'Installing the desktop on the guest');
          await requireSuccess(guestShell(record, desktopInstall, { timeout: 20 * 60_000, signal: state.signal }),
            'Could not install the guest desktop.');
        }
        await requireSuccess(guestShell(record, desktopStart, { signal: state.signal }), 'Could not open the guest desktop.');
        state.desktopConfigured = true;
        update(state, 'running');
        connectDesktop(record, state);
      } catch (error) {
        if (!state.signal.aborted) update(state, 'error', safeError(error));
        else if (!state.process && state.status === 'stopping') update(state, 'stopped');
      } finally {
        state.pending = false;
      }
    })();
  }

  async function startCloud(record) {
    const old = states.get(record.id);
    if (isRunning(old) || old?.pending || old?.status === 'stopping') throw new Error('This cloud computer is already running or changing state.');
    if (!cloud.configured()) throw new Error('Connect Daytona in Computers first.');
    record.cloudProvisionAttempt = true;
    record.cloudMayBeRunning = true;
    store.update();
    const controller = new AbortController();
    const state = { controller, signal: controller.signal, pending: true, status: 'starting', provider: 'daytona' };
    states.set(record.id, state);
    update(state, 'starting', 'Starting the Daytona sandbox');
    state.startJob = (async () => {
      try {
        state.sandbox = await cloud.start(record, { signal: state.signal, onCreated(id) {
          if (record.sandboxId === id) return;
          record.sandboxId = id;
          store.update();
        } });
        if (state.signal.aborted) return;
        state.display = cloudDisplay(state.sandbox);
        update(state, 'running', 'Daytona desktop');
      } catch (error) {
        if (!state.signal.aborted) update(state, 'error', safeError(error));
      } finally {
        state.pending = false;
        publish();
      }
    })();
  }

  function finishHandoff(state, error) {
    const waiter = state.handoffWaiter;
    state.handoffWaiter = undefined;
    if (!waiter) return;
    waiter.cleanup();
    if (error) waiter.reject(error);
    else waiter.resolve();
  }

  async function stopCloud(record, state) {
    if (state?.status === 'stopping') return;
    if (!state) {
      const controller = new AbortController();
      state = { controller, signal: controller.signal, provider: 'daytona' };
      states.set(record.id, state);
    }
    state.controller.abort();
    finishHandoff(state, new Error('The computer stopped before the handoff completed.'));
    state.removeOwnerListener?.();
    state.owner = undefined;
    stopDesktop(state);
    update(state, 'stopping', 'Stopping the Daytona sandbox');
    await state.startJob;
    try {
      await cloud.stop(record);
      record.cloudMayBeRunning = false;
      store.update();
      state.sandbox = undefined;
      update(state, 'stopped');
    } catch (error) {
      update(state, 'error', safeError(error));
      throw error;
    }
  }

  async function stop(id) {
    const record = machine(id);
    const state = states.get(id);
    if (isCloud(record)) return stopCloud(record, state);
    if (!state) return;
    finishHandoff(state, new Error('The computer stopped before the handoff completed.'));
    state.removeOwnerListener?.();
    state.removeOwnerListener = undefined;
    state.owner = undefined;
    state.controller.abort();
    stopDesktop(state);
    if (state.process) {
      update(state, 'stopping');
      state.process.kill('SIGINT');
    } else if (state.pending) update(state, 'stopping');
    else update(state, 'stopped');
  }

  async function remove(id) {
    const record = machine(id);
    const state = states.get(id);
    if (isRunning(state) || state?.pending || state?.status === 'stopping') throw new Error('Stop the computer before removing it.');
    if (isCloud(record) && (record.sandboxId || record.cloudProvisionAttempt)) await cloud.remove(record);
    if (record.cloned) await requireSuccess(tart(['delete', record.vmName]), 'Could not remove the virtual machine.');
    states.delete(id);
    store.data.computers = store.data.computers.filter((item) => item !== record);
    store.update();
    publish();
  }

  function activeState(id, agent = false) {
    const record = machine(id);
    const state = states.get(id);
    if (!isRunning(state) || state.signal.aborted) throw new Error('Start the computer in Computers first.');
    if (agent && (state.owner != null || record.handoff)) throw new Error('The desktop is reserved for the user. Wait for them to release it.');
    return state;
  }

  function lease(computerId, sessionId) {
    activeState(computerId, true);
    if (agentLeases.has(computerId)) throw new Error('Another agent is using this computer. Wait for its current turn to finish.');
    const claim = { sessionId };
    agentLeases.set(computerId, claim);
    return () => {
      if (agentLeases.get(computerId) === claim) agentLeases.delete(computerId);
    };
  }

  async function frame(sessionId, after, agent = false, senderId) {
    const state = activeState(sessionId, agent);
    const controlRevision = state.controlRevision;
    if (!agent && state.owner != null && state.owner !== senderId) return null;
    if (state.sandbox) {
      let result;
      try {
        result = await state.display?.frame(after, agent);
        if (state.status === 'error' && !state.signal.aborted) update(state, 'running', 'Daytona desktop');
      } catch (error) {
        if (state.status !== 'error' && !state.signal.aborted) update(state, 'error', safeError(providerError(error)));
        throw providerError(error);
      }
      if (controlRevision !== state.controlRevision || state.signal.aborted) return null;
      return result ?? null;
    }
    if (!state.display && state.desktopConfigured && state.retryAt && Date.now() >= state.retryAt) {
      connectDesktop(machine(sessionId), state);
    }
    const raw = state.display?.frame();
    if (!raw) return null;
    if (state.displayRevision !== raw.revision) {
      const bitmap = nativeImage.createFromBitmap(raw.pixels, { width: raw.width, height: raw.height });
      state.displayRevision = raw.revision;
      state.frameSequence = (state.frameSequence ?? 0) + 1;
      state.latest = { width: raw.width, height: raw.height, revision: state.frameSequence, data: bitmap.toPNG().toString('base64') };
    }
    return state.latest.revision === after ? null : state.latest;
  }

  async function takeControl(event, id, enabled) {
    const state = activeState(id);
    const record = machine(id);
    const owner = event.sender.id;
    if (state.owner != null && state.owner !== owner) throw new Error('This computer is under control in another Workbench window.');
    if (enabled) {
      if (!state.display?.connected()) throw new Error('Wait for the guest desktop to connect.');
      if (state.owner === owner) return;
      if (state.agentOperation) throw new Error('Wait for the current guest action to finish before taking control.');
      state.controlRevision = (state.controlRevision ?? 0) + 1;
      state.owner = owner;
      const abandon = () => {
        if (state.owner !== owner) return;
        void Promise.resolve(state.display?.release()).catch(() => {}).finally(() => {
          if (state.owner !== owner) return;
          if (!record.handoff && agentLeases.has(id)) {
            const reason = 'The takeover window closed. Review the desktop before handing it back to the agent.';
            record.handoff = { reason, at: Date.now(), sessionId: agentLeases.get(id).sessionId };
            store.activity('computer', 'Desktop handoff needs attention', reason, { type: 'computer', id });
          }
          state.owner = undefined;
          state.removeOwnerListener = undefined;
          state.controlRevision++;
          publish();
        });
      };
      state.removeOwnerListener = () => event.sender.off('destroyed', abandon);
      event.sender.once('destroyed', abandon);
    } else {
      if (state.owner !== owner) return;
      await state.display?.release();
      state.removeOwnerListener?.();
      state.removeOwnerListener = undefined;
      state.owner = undefined;
      state.controlRevision++;
      if (record.handoff) {
        delete record.handoff;
        store.activity('computer', 'Desktop handed back', record.name, { type: 'computer', id });
      }
      finishHandoff(state);
    }
    publish();
  }

  async function withAgentOperation(id, operation) {
    const state = activeState(id, true);
    state.agentOperation = (state.agentOperation ?? 0) + 1;
    try { return await operation(state); }
    finally { state.agentOperation--; }
  }

  async function desktopInput(display, input, guard) {
    if (!display?.connected()) throw new Error('The guest desktop is still connecting.');
    if (input?.type === 'release') { guard(); await display.release(); return; }
    if (input?.type === 'key' && keySymbol(input.key) && typeof input.down === 'boolean') {
      await display.key(input.key, input.down, guard);
      return;
    }
    if (input?.type === 'pointer' && Number.isFinite(input.x) && Number.isFinite(input.y) &&
      Number.isInteger(input.buttons) && input.buttons >= 0 && input.buttons <= 31) {
      await display.pointer(input.x, input.y, input.buttons, guard);
      return;
    }
    throw new Error('That guest input is unsupported.');
  }

  async function enableBrowser(id) {
    const record = machine(id);
    const state = activeState(id);
    if (isCloud(record)) throw new Error('Use the browser included in the Daytona sandbox.');
    if (state.browserJob) throw new Error('Firefox is already being installed.');
    state.browserJob = true;
    update(state, 'running', 'Installing Firefox in Ubuntu');
    try {
      await requireSuccess(guestShell(record, browserInstall, { timeout: 15 * 60_000, signal: state.signal }), 'Could not install Firefox.');
      record.browserInstalled = true;
      store.update();
      update(state, 'running', 'Firefox is ready.');
    } catch (error) {
      if (!state.signal.aborted) update(state, 'running', safeError(error));
      throw error;
    } finally { state.browserJob = false; publish(); }
  }

  function close() {
    shuttingDown = true;
    for (const state of states.values()) {
      state.controller.abort();
      finishHandoff(state, new Error('Workbench is closing.'));
      stopDesktop(state);
      state.process?.kill('SIGINT');
    }
    for (const child of children) child.kill('SIGTERM');
  }

  return {
    handlers: {
      computerList: (event) => snapshot(event.sender.id),
      computerInstallRuntime: () => install(),
      computerPickRuntime: (event) => pickRuntime(event),
      computerConnectDaytona: async (_, key) => {
        if ([...states.values()].some((state) => state.provider === 'daytona' && (state.pending || isRunning(state)))) {
          throw new Error('Stop the running Daytona computers before replacing their API key.');
        }
        await cloud.connectKey(key);
        publish();
      },
      computerDisconnectDaytona: () => {
        if (store.data.computers.some(isCloud)) throw new Error('Remove the Daytona computers before disconnecting the account.');
        cloud.disconnect();
        publish();
      },
      computerCreate: (_, name, provider) => create(name, provider),
      computerStart: (_, id) => start(id),
      computerStop: (_, id) => stop(id),
      computerRemove: (_, id) => remove(id),
      computerFrame: (event, id, after) => frame(id, after, false, event.sender.id),
      computerTakeover: (event, id, enabled) => takeControl(event, id, enabled),
      computerInput: (event, id, input) => {
        const state = activeState(id);
        if (state.owner !== event.sender.id) throw new Error('Take control before sending guest input.');
        const guard = () => {
          if (state.signal.aborted || state.owner !== event.sender.id) throw new Error('The desktop was released.');
        };
        return desktopInput(state.display, input, guard);
      },
      computerInstallBrowser: (_, id) => enableBrowser(id),
    },
    name: (id) => machine(id).name,
    frame,
    lease,
    close,
    tools(computerId) {
      return computerTools(computerId);
    },
  };

  async function shell(id, command, timeoutSeconds, signal) {
    const state = activeState(id, true);
    if (typeof command !== 'string' || !command.trim() || command.length > 32_000) throw new Error('Enter a guest shell command up to 32,000 characters.');
    const timeout = Math.max(5, Math.min(600, Number(timeoutSeconds) || 60)) * 1000;
    const display = state.sandbox ? '${DISPLAY:-:0}' : ':1';
    const result = await guestShell(machine(id), 'export DISPLAY="' + display + '" PATH="$HOME/.local/bin:$PATH"; \n' + command, { timeout, signal: signal ? AbortSignal.any([signal, state.signal]) : state.signal });
    return { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) };
  }

  async function exportArtifact(id, input, signal) {
    if (!files || typeof input !== 'string' || !input.trim() || input.length > 1600 || /[\0\r\n]/.test(input)) {
      throw new Error('Enter a guest file path.');
    }
    const name = path.posix.basename(input);
    if (!artifactExtensions.has(path.extname(name).toLowerCase())) throw new Error('Choose a document, image, spreadsheet or log.');
    const state = activeState(id, true);
    const guestPath = "'" + input.replaceAll("'", "'\"'\"'") + "'";
    const command = 'set -eu; file=' + guestPath + '\n' +
      'test -f "$file"; size=$(wc -c < "$file"); test "$size" -gt 0; test "$size" -le ' + artifactLimit + '\n' +
      'base64 -w 0 -- "$file"';
    const outputLimit = Math.ceil(artifactLimit / 3) * 4 + 100;
    const result = await guestShell(machine(id), command, { outputLimit, signal: signal ? AbortSignal.any([signal, state.signal]) : state.signal });
    const encoded = result.stdout.trim();
    if (result.code || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('The guest file could not be read or exceeds 1 MiB.');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > artifactLimit) throw new Error('The guest file exceeds 1 MiB.');
    const filename = path.join(store.folders.artifacts, randomUUID().slice(0, 8) + '-' + name.replace(/[^.\w-]+/g, '-').slice(-180));
    await fs.writeFile(filename, bytes, { mode: 0o600, flag: 'wx' });
    const file = files.register(filename, true, false);
    store.activity('computer', 'Computer artifact exported', file.name, { type: 'file', path: file.path });
    return file;
  }

  function computerTools(id) {
    machine(id);
    const text = (value) => ({ type: 'text', text: value });
    const number = { type: 'number' };
    const string = { type: 'string' };
    const params = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
    return [
      {
        name: 'computer_shell',
        label: 'Guest shell',
        description: 'Run a command in this chat’s isolated Linux guest. Files and programs live in the guest. Use this tool for code, filesystem operations, and installing software. The command receives the guest DISPLAY. Run GUI applications detached.',
        parameters: params({ command: string, timeoutSeconds: number }, ['command']),
        executionMode: 'sequential',
        async execute(_, { command, timeoutSeconds }, signal) {
          const result = await withAgentOperation(id, () => shell(id, command, timeoutSeconds, signal));
          const output = [result.stdout, result.stderr, 'Exit code ' + result.code].filter(Boolean).join('\n');
          return { content: [text(output)], details: { exitCode: result.code } };
        },
      },
      {
        name: 'computer_screen',
        label: 'Guest screenshot',
        description: 'Get a screenshot of the isolated guest desktop. Call again after GUI interactions to confirm what changed.',
        parameters: params({}),
        executionMode: 'sequential',
        async execute(_, __, signal) {
          for (let attempt = 0; attempt < 10; attempt += 1) {
            signal?.throwIfAborted();
            const current = await withAgentOperation(id, () => frame(id, undefined, true));
            if (current) return { content: [
              text('Guest desktop ' + current.width + ' × ' + current.height + '. Coordinates are measured from the top left.'),
              { type: 'image', mimeType: 'image/png', data: current.data },
            ], details: { width: current.width, height: current.height } };
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          throw new Error('The guest desktop is still starting.');
        },
      },
      {
        name: 'computer_input',
        label: 'Guest input',
        description: 'Interact with the guest display. Use an x/y position for click, move, or scroll. Key accepts names such as Enter, Tab or Control+L. Type enters up to 512 characters. Use takeover for passwords, MFA and other actions that require the human.',
        parameters: params({
          action: { enum: ['click', 'move', 'key', 'type', 'scroll'] },
          x: number, y: number, button: { enum: ['left', 'middle', 'right'] },
          key: string, text: { ...string, maxLength: 512 }, direction: { enum: ['up', 'down'] },
        }, ['action']),
        executionMode: 'sequential',
        async execute(_, input) {
          return withAgentOperation(id, async (state) => {
            const display = state.display;
            if (!display?.connected()) throw new Error('The guest desktop is still connecting.');
            if (input.action === 'key') {
              const keys = (input.key ?? '').split('+');
              if (keys.length > 4 || keys.some((value) => !keySymbol(value))) throw new Error('Enter a supported key such as Enter or Control+l.');
              for (const value of keys) await display.key(value, true);
              for (const value of keys.reverse()) await display.key(value, false);
            } else if (input.action === 'type') {
              if (!input.text || input.text.length > 512) throw new Error('Enter up to 512 characters.');
              const keys = [...input.text.replaceAll('\r', '')].map((value) => value === '\n' ? 'Enter' : value === '\t' ? 'Tab' : value);
              if (keys.some((value) => !keySymbol(value))) throw new Error('The text contains unsupported guest input.');
              for (const value of keys) { await display.key(value, true); await display.key(value, false); }
            } else {
              if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) throw new Error('Provide guest x and y coordinates.');
              const button = { left: 1, middle: 2, right: 4 }[input.button] ?? 1;
              const mask = input.action === 'click' ? button : input.action === 'scroll' ? (input.direction === 'up' ? 8 : 16) : 0;
              if (mask) await display.pointer(input.x, input.y, mask);
              await display.pointer(input.x, input.y, 0);
            }
            return { content: [text('Input sent to the guest.')], details: {} };
          });
        },
      },
      {
        name: 'computer_handoff',
        label: 'Request desktop takeover',
        description: 'Pause this turn and request a human takeover for sign-in, MFA, payment or another user-only action. The turn continues after the user releases the desktop.',
        parameters: params({ reason: { ...string, maxLength: 240 } }, ['reason']),
        executionMode: 'sequential',
        async execute(_, { reason }, signal) {
          const state = activeState(id, true);
          const record = machine(id);
          const message = safeError(reason) || 'Help requested on the desktop.';
          const activeSignal = signal ? AbortSignal.any([signal, state.signal]) : state.signal;
          activeSignal.throwIfAborted();
          await new Promise((resolve, reject) => {
            const abort = () => finishHandoff(state, activeSignal.reason);
            state.handoffWaiter = { resolve, reject, cleanup: () => activeSignal.removeEventListener('abort', abort) };
            activeSignal.addEventListener('abort', abort, { once: true });
            record.handoff = { reason: message, at: Date.now(), sessionId: agentLeases.get(id)?.sessionId };
            store.activity('computer', 'Desktop handoff requested', message, { type: 'computer', id });
            update(state, 'running', message);
          });
          return { content: [text('The user released the desktop. Continue the task.')], details: {} };
        },
      },
      {
        name: 'computer_export',
        label: 'Save guest artifact',
        description: 'Copy a document, image, spreadsheet or log from the guest to Workbench Artifacts. Provide a guest path for a regular file under 1 MiB.',
        parameters: params({ path: string }, ['path']),
        executionMode: 'sequential',
        async execute(_, input, signal) {
          const file = await withAgentOperation(id, () => exportArtifact(id, input.path, signal));
          return { content: [text('Saved ' + file.name + ' to Workbench Artifacts.')], details: { artifact: file.path } };
        },
      },
    ];
  }
}

module.exports = { createComputers };
