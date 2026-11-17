const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once, EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createEditorLanguages } = require('../src/main/editor-languages');

test('language server frames return diagnostics and authorized definition locations', async (t) => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-language-')));
  const root = path.join(folder, 'project');
  fs.mkdirSync(root);
  const source = path.join(root, 'main.ts');
  const outside = path.join(folder, 'other.ts');
  fs.writeFileSync(source, 'const amount: number = "é";\n');
  fs.writeFileSync(outside, 'const outside = 2;\n');
  const transport = `
    function write(message) {
      const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
      process.stdout.write('Content-Length: ' + bytes.length + '\\r\\n');
      process.stdout.write('\\r\\n');
      process.stdout.write(bytes);
    }
    let input = Buffer.alloc(0);
    process.stdin.on('data', (chunk) => {
      input = Buffer.concat([input, chunk]);
      for (let split = input.indexOf('\\r\\n\\r\\n'); split >= 0; split = input.indexOf('\\r\\n\\r\\n')) {
        const length = Number(input.toString('utf8', 0, split).split(':')[1]);
        const end = split + 4 + length;
        if (input.length < end) return;
        const { id, method, params } = JSON.parse(input.toString('utf8', split + 4, end));
        input = input.subarray(end);
        if (method === 'initialize') write({ id, result: { capabilities: { definitionProvider: true, textDocumentSync: 2 } } });
        if (method === 'textDocument/didOpen') write({ method: 'textDocument/publishDiagnostics', params: {
          uri: params.textDocument.uri, version: params.textDocument.version,
          diagnostics: [{ range: { start: { line: 0, character: 23 } }, severity: 1, message: 'Type mismatch at é' }],
        } });
        if (method === 'textDocument/didChange') write({ method: 'textDocument/publishDiagnostics', params: {
          uri: params.textDocument.uri, version: params.textDocument.version,
          diagnostics: params.contentChanges[0].range.end.line === 1 ? [] : [{
            range: { start: { line: 0, character: 0 } }, severity: 1, message: 'Incorrect incremental range',
          }],
        } });
        if (method === 'textDocument/definition') write({ id, result: [
          { uri: ${JSON.stringify(pathToFileURL(source).href)}, range: { start: { line: 1, character: 0 } } },
          { uri: ${JSON.stringify(pathToFileURL(outside).href)}, range: { start: { line: 0, character: 0 } } },
        ] });
      }
    });
  `;
  const events = new EventEmitter();
  const editor = createEditorLanguages({ home: os.homedir(), authorize: fs.realpathSync, publish: (value) => events.emit('problems', value),
    commands: { 'typescript-language-server': [process.execPath, '-e', transport, '--'] } });
  t.after(() => { editor.dispose(); fs.rmSync(folder, { recursive: true, force: true }); });

  const first = once(events, 'problems', { signal: AbortSignal.timeout(5_000) });
  const definition = await editor.definition(root, source, fs.readFileSync(source, 'utf8'), { line: 1, character: 4 });
  assert.deepEqual(definition, [{ path: source, line: 2 }]);
  const [{ diagnostics }] = await first;
  assert.equal(diagnostics[0].message, 'Type mismatch at é');
  assert.equal(diagnostics[0].column, 24);

  const second = once(events, 'problems', { signal: AbortSignal.timeout(5_000) });
  await editor.sync(root, source, 'const amount: number = 5;\n');
  const [cleared] = await second;
  assert.deepEqual(cleared.diagnostics, []);
  await assert.rejects(editor.sync(root, outside, 'const outside = 2;'), /Choose the file’s folder/);
});
