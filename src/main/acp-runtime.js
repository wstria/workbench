const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { redact } = require('./agent-common');

function openAcp(executable, args, options, onUpdate = () => {}, onRequest = () => null) {
  const child = spawn(executable, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  // A process can exit while a permission response is waiting to be written.
  child.stdin.on('error', () => {});
  function close(error, kill = true) {
    if (closed) return;
    closed = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
    child.stdin.end();
    if (kill && child.exitCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 4000);
      timer.unref();
    }
  }
  function write(message) {
    if (!closed && child.stdin.writable) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method) {
      if (message.id == null) {
        if (message.method === 'session/update') onUpdate(message.params);
        return;
      }
      Promise.resolve().then(() => onRequest(message.method, message.params)).then((result) => {
        if (result === null) write({ id: message.id, error: { code: -32601, message: 'Workbench does not provide this ACP capability.' } });
        else write({ id: message.id, result });
      }).catch(() => write({ id: message.id, error: { code: -32603, message: 'Workbench could not complete the request.' } }));
      return;
    }
    const callback = pending.get(message.id);
    if (!callback) return;
    clearTimeout(callback.timer);
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(redact(message.error.message || 'ACP request failed.')));
    else callback.resolve(message.result);
  });
  child.once('error', (error) => close(new Error('Could not launch the harness: ' + error.code), false));
  child.once('close', (code) => {
    const detail = redact(stderr).trim().split('\n').filter(Boolean).at(-1);
    close(new Error(code && detail ? detail.slice(0, 600) : 'The ACP harness stopped.'), false);
  });
  return {
    request(method, params, timeout = 20000) {
      if (closed) return Promise.reject(new Error('The ACP harness is closed.'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = timeout > 0 ? setTimeout(() => {
          const error = new Error('The harness did not respond to ' + method + '.');
          close(error);
        }, timeout) : null;
        pending.set(id, { resolve, reject, timer });
        write({ id, method, params });
      });
    },
    notify(method, params) { write({ method, params }); },
    close() { close(new Error('The Workbench ACP connection closed.')); },
  };
}

const initializeAcp = (client) => client.request('initialize', {
  protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'workbench', title: 'Workbench', version: '1.0.0' },
});

module.exports = { openAcp, initializeAcp };
