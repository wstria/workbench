const { randomUUID } = require('node:crypto');

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Wlp0AAAAASUVORK5CYII=';
const key = 'fixture-daytona-key';

function fakeDaytona() {
  const calls = [];
  const sandboxes = new Map();
  const authError = () => Object.assign(new Error('Private provider error'), { statusCode: 403 });
  function log(name, value) { calls.push({ name, value }); }
  function client(received) {
    return {
      async *list() { if (received !== key) throw authError(); },
      async get(id) {
        if (received !== key) throw authError();
        const sandbox = sandboxes.get(id) ?? [...sandboxes.values()].find((item) => item.name === id);
        if (!sandbox) throw Object.assign(new Error('Sandbox absent'), { statusCode: 404 });
        return sandbox;
      },
      async create(options) {
        if (received !== key) throw authError();
        log('create', options);
        const sandbox = {
          id: randomUUID(), name: options.name, state: 'started',
          async start() { this.state = 'started'; log('start', this.id); },
          async stop() { this.state = 'stopped'; log('stop', this.id); },
          computerUse: {
            async start() { log('desktop'); },
            screenshot: { async takeCompressed() { log('screenshot'); return { screenshot: pixel }; } },
            keyboard: {
              async type(value) { log('type', value); },
              async down(value) { log('key down', value); },
              async up(value) { log('key up', value); },
            },
            mouse: Object.fromEntries(['down', 'up', 'scroll', 'move'].map((name) => [name, async (...args) => log(name, args)])),
          },
          process: {
            async executeCommand(command) {
              log('shell', command);
              return { exitCode: 0, result: command.includes('base64 -w 0') ? Buffer.from('Fixture receipt\n').toString('base64') : 'Hello from the fixture guest' };
            },
          },
        };
        sandboxes.set(sandbox.id, sandbox);
        return sandbox;
      },
      async delete(sandbox) { sandboxes.delete(sandbox.id); log('delete', sandbox.id); },
    };
  }
  return { client, calls, sandboxes };
}

module.exports = { fakeDaytona, pixel, key };
