const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { redact } = require('./agent-common');
const { gitSource } = require('./team-sessions');

const execute = promisify(execFile);
const envKeys = ['PATH', 'HOME', 'USERPROFILE', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot'];

function configuration(input) {
  const executable = typeof input?.executable === 'string' ? input.executable.trim() : '';
  const args = input?.args ?? [];
  if ((!path.isAbsolute(executable) && !/^[a-z0-9_@.-]+$/i.test(executable)) || executable.length > 500 ||
    /[\u0000-\u001f]/.test(executable) || !Array.isArray(args) || args.length > 25 ||
    args.some((item) => typeof item !== 'string' || item.length > 1000 || item.includes('\0'))) {
    throw new Error('Enter an executable name or absolute path and up to 25 arguments.');
  }
  return { executable, args, afterEdits: input.afterEdits === true };
}

function createProjectChecks({ store }) {
  async function setup(cwd) {
    const repo = await gitSource(cwd);
    if (!repo) return null;
    return { root: repo.top, config: store.data.projectChecks?.[repo.top] ?? null };
  }

  async function save(cwd, input) {
    const project = await setup(cwd);
    if (!project) throw new Error('Choose a Git folder with an initial commit.');
    const settings = store.data.projectChecks ??= {};
    if (input === null) delete settings[project.root];
    else settings[project.root] = configuration(input);
    store.update();
    return settings[project.root] ?? null;
  }

  async function run(config, cwd, signal) {
    if (!config || signal?.aborted) return null;
    const { executable, args } = configuration(config);
    const command = redact([executable, ...args.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg)].join(' ')).slice(0, 500);
    const env = Object.fromEntries(envKeys.filter((key) => typeof process.env[key] === 'string').map((key) => [key, process.env[key]]));
    const startedAt = Date.now();
    const output = (stdout, stderr) => redact([stdout, stderr].filter(Boolean).join('\n')).slice(0, 3000);
    try {
      const response = await execute(executable, args, {
        cwd: fs.realpathSync(cwd), env, shell: false, signal, timeout: 60_000, maxBuffer: 256 * 1024, windowsHide: true,
      });
      return { command, status: 'done', exitCode: 0, output: output(response.stdout, response.stderr), duration: Date.now() - startedAt };
    } catch (error) {
      if (signal?.aborted) return null;
      return { command, status: 'failed', exitCode: typeof error.code === 'number' ? error.code : null,
        output: output(error.stdout, error.stderr) || redact(error.message).slice(0, 3000), duration: Date.now() - startedAt };
    }
  }

  function afterEdits(root, cwd, options) {
    const config = store.data.projectChecks?.[root];
    if (!config?.afterEdits) return null;
    return run(config, cwd, options?.signal);
  }

  async function manual(cwd) {
    const project = await setup(cwd);
    if (!project?.config) throw new Error('Save a project check first.');
    const result = await run(project.config, cwd);
    store.activity('review', result.status === 'done' ? 'Project check passed' : 'Project check failed', result.command);
    return result;
  }

  return { setup, save, afterEdits, manual };
}

module.exports = { createProjectChecks };
