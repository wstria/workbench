const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { atomicWrite } = require('./store');

const maxFrame = 12 * 1024 * 1024;
const millisecondsBetweenFrames = 450;
const pngHeader = Buffer.from('89504e470d0a1a0a', 'hex');
const mouseButtons = [[1, 'left'], [2, 'middle'], [4, 'right']];
const keyAliases = { Control: 'ctrl', Alt: 'alt', Shift: 'shift', Meta: 'cmd', ArrowLeft: 'left', ArrowRight: 'right',
  ArrowUp: 'up', ArrowDown: 'down', ' ': 'space', Space: 'space' };

function fromSdk(key) {
  const { Daytona } = require('@daytona/sdk');
  return new Daytona({ apiKey: key, apiUrl: 'https://app.daytona.io/api', otelEnabled: false, requestTimeoutMs: 12_000 });
}

function missing(error) {
  return error?.name === 'DaytonaNotFoundError' || error?.statusCode === 404;
}

function providerError(error) {
  const status = error?.statusCode ?? error?.response?.status;
  if (status === 401 || status === 403) return new Error('Daytona denied access. Check the API key and its sandbox permissions.');
  if (status === 429) return new Error('Daytona is rate limiting requests. Try again shortly.');
  if (missing(error)) return new Error('This sandbox is unavailable in the connected Daytona account.');
  return new Error('Daytona did not complete the request. Check your Daytona dashboard and try again.');
}

function decodeFrame(result) {
  const data = result?.screenshot;
  if (typeof data !== 'string' || !data || data.length > maxFrame || !/^[a-z0-9+/]+={0,2}$/i.test(data)) {
    throw new Error('Daytona returned an invalid desktop frame.');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(pngHeader) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Daytona returned an invalid desktop frame.');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || width > 4096 || height < 1 || height > 4096) throw new Error('Daytona returned an unsupported desktop size.');
  return { width, height, data, hash: createHash('sha256').update(data).digest('hex') };
}

function createDaytonaComputers({ store, safeStorage, makeClient = fromSdk }) {
  const secret = path.join(store.root, 'daytona.keychain');
  let client;
  async function connectKey(value) {
    const key = typeof value === 'string' ? value.trim() : '';
    if (!key || key.length > 4096 || /\s/.test(key)) throw new Error('Enter a valid Daytona API key.');
    if (!safeStorage?.isEncryptionAvailable()) throw new Error('System credential storage is unavailable.');
    let next;
    try {
      next = makeClient(key);
      await next.list({ limit: 1 }).next();
      for (const computer of store.data.computers ?? []) {
        if (computer.provider !== 'daytona' || !computer.sandboxId) continue;
        try { await next.get(computer.sandboxId); }
        catch (error) { if (!missing(error)) throw error; }
      }
    } catch (error) { throw providerError(error); }
    atomicWrite(secret, safeStorage.encryptString(key));
    client = next;
  }

  function connection() {
    if (client) return client;
    let key;
    try {
      if (fs.existsSync(secret)) key = safeStorage?.decryptString(fs.readFileSync(secret));
    } catch { throw new Error('Could not open the Daytona key from system credential storage. Reconnect Daytona.'); }
    if (!key) throw new Error('Connect Daytona in Computers first.');
    try { client = makeClient(key); }
    catch (error) { throw providerError(error); }
    return client;
  }

  async function start(record, { onCreated, signal }) {
    const api = connection();
    try {
      let sandbox;
      try { sandbox = await api.get(record.sandboxId ?? record.vmName); }
      catch (error) { if (record.sandboxId || !missing(error)) throw error; }
      signal.throwIfAborted();
      if (!sandbox) {
        try {
          sandbox = await api.create({ name: record.vmName, public: false, autoStopInterval: 15,
            labels: { application: 'workbench' }, envVars: { VNC_RESOLUTION: '1280x800' } }, { timeout: 120 });
        } catch (error) {
          if (typeof error?.sandboxId === 'string') await onCreated(error.sandboxId);
          throw error;
        }
      }
      await onCreated(sandbox.id);
      if (signal.aborted) {
        await sandbox.stop(30);
        signal.throwIfAborted();
      }
      if (sandbox.state !== 'started') await sandbox.start(90);
      signal.throwIfAborted();
      await sandbox.computerUse.start();
      return sandbox;
    } catch (error) {
      if (signal.aborted) throw error;
      throw providerError(error);
    }
  }

  async function change(record, action) {
    const api = connection();
    try {
      const sandbox = await api.get(record.sandboxId ?? record.vmName);
      if (action === 'remove') await api.delete(sandbox, 60);
      else if (sandbox.state !== 'stopped' && sandbox.state !== 'archived') await sandbox.stop(30);
    } catch (error) { if (!missing(error)) throw providerError(error); }
  }

  return {
    configured: () => fs.existsSync(secret),
    connectKey,
    disconnect() { fs.rmSync(secret, { force: true }); client = undefined; },
    start,
    stop: (record) => change(record, 'stop'),
    remove: (record) => change(record, 'remove'),
  };
}

function cloudDisplay(sandbox) {
  const desktop = sandbox.computerUse;
  let connected = true;
  let running;
  let last;
  let sequence = 0;
  let sampledAt = 0;
  let tail = Promise.resolve();
  let pointer = 0;
  let queued = 0;
  const pressed = new Set();

  function enqueue(operation, isMove = false, mustRun = false) {
    if (queued >= 18 && isMove) return Promise.resolve();
    if (queued >= 96 && !mustRun) return Promise.reject(new Error('The cloud desktop is busy. Wait for its input queue to catch up.'));
    queued++;
    const result = tail.then(() => connected && operation()).finally(() => queued--);
    tail = result.catch(() => {});
    return result;
  }

  async function dispatch(operation) {
    try { return await operation(); }
    catch (error) { throw providerError(error); }
  }

  function key(value, down, guard) {
    const key = keyAliases[value] ?? value.toLowerCase();
    return enqueue(async () => {
      guard?.();
      // A printable key without a control modifier uses the same text path as paste.
      const typing = down && [...value].length === 1 && !['ctrl', 'alt', 'cmd'].some((modifier) => pressed.has(modifier));
      if (typing) { await dispatch(() => desktop.keyboard.type(value)); return; }
      if (down) {
        await dispatch(() => desktop.keyboard.down(key));
        pressed.add(key);
      } else if (pressed.has(key)) {
        await dispatch(() => desktop.keyboard.up(key));
        pressed.delete(key);
      }
    });
  }

  function move(x, y, buttons, guard) {
    const horizontal = Math.trunc(Math.max(0, Math.min((last?.width ?? 1280) - 1, x)));
    const vertical = Math.trunc(Math.max(0, Math.min((last?.height ?? 800) - 1, y)));
    return enqueue(async () => {
      guard?.();
      if (buttons & 24) { await dispatch(() => desktop.mouse.scroll(horizontal, vertical, buttons & 8 ? 'up' : 'down', 1)); return; }
      const before = pointer;
      for (const [mask, name] of mouseButtons) {
        if ((pointer & mask) === (buttons & mask)) continue;
        if (buttons & mask) await dispatch(() => desktop.mouse.down(horizontal, vertical, name));
        else await dispatch(() => desktop.mouse.up(horizontal, vertical, name));
        pointer ^= mask;
      }
      if (before === pointer) await dispatch(() => desktop.mouse.move(horizontal, vertical));
    }, buttons === pointer);
  }

  function release() {
    return enqueue(async () => {
      // Reset all inputs even if one release fails.
      await Promise.allSettled([...pressed].map((key) => desktop.keyboard.up(key)));
      pressed.clear();
      await Promise.allSettled(mouseButtons.filter(([mask]) => pointer & mask).map(([, name]) => desktop.mouse.up(undefined, undefined, name)));
      pointer = 0;
    }, false, true);
  }

  return {
    connected: () => connected,
    close() { connected = false; last = undefined; },
    key, pointer: move, release,
    async frame(after, fresh = false) {
      if (!connected) return null;
      if (!running && (fresh || !last || Date.now() - sampledAt >= millisecondsBetweenFrames)) {
        running = desktop.screenshot.takeCompressed({ format: 'png' }).then((result) => {
          if (!connected) return;
          const next = decodeFrame(result);
          sampledAt = Date.now();
          if (last?.hash !== next.hash) last = { ...next, revision: ++sequence };
        }).finally(() => { running = undefined; });
      }
      await running;
      if (!last || last.revision === after) return null;
      const { width, height, data, revision } = last;
      return { width, height, data, revision };
    },
  };
}

module.exports = { createDaytonaComputers, cloudDisplay, providerError };
