const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const { clause, passage, fixed } = require('./demo.cjs');

const testPassphrase = 'fixture-passphrase';

function tile(name, args) { return { index: 0, id: 'call_' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }; }

async function serveFixture(data) {
  const requests = [];
  const failures = [];
  let signIns = 0;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/research') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(await fs.readFile(data.webPath));
        return;
      }
      if (req.method === 'POST' && req.url === '/receipt') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const values = new URLSearchParams(Buffer.concat(chunks).toString());
        if (values.get('passphrase') !== testPassphrase) { res.writeHead(403).end('Try again'); return; }
        signIns += 1;
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Fixture sign-in finished</h1>');
        return;
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'demo-model', object: 'model' }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      const user = JSON.stringify(body.messages.findLast(({ role }) => role === 'user')?.content);
      const returns = body.messages.filter(({ role }) => role === 'tool');
      const last = returns.at(-1);
      requests.push({ user, tools: body.tools?.map((tool) => tool.function.name), last: last?.content });
      assert.ok(!JSON.stringify(body).includes(testPassphrase), 'A controlled sign-in value reached the model');
      let text = 'Workbench fixture response.';
      let call;
      if (user.includes('Compare the two renewal sources')) {
        assert.ok(user.includes(clause), 'Expected PDF excerpt');
        assert.ok(user.includes(passage), 'Expected captured webpage');
        text = 'The agreement needs sixty days of notice. The manual calls for a review thirty days before renewal.';
      } else if (user.includes('Fix the calculator A') || user.includes('Fix the calculator B')) {
        const isB = user.includes('calculator B');
        const replacement = isB ? fixed + '// Change from the second review.\n' : fixed;
        if (!returns.length) call = tile('write', { path: 'calculator/add.cjs', content: replacement });
        else if (returns.length === 1) call = tile('bash', { command: 'node calculator/add.test.cjs' });
        else text = 'Calculator check completed.';
      } else if (user.includes('Computer takeover fixture')) {
        if (!returns.length) call = tile('computer_handoff', { reason: 'Finish the test sign-in.' });
        else if (returns.length === 1) call = tile('computer_shell', { command: 'printf "%s\\n" "Fixture receipt" > /tmp/workbench-test-receipt.txt' });
        else if (returns.length === 2) call = tile('computer_export', { path: '/tmp/workbench-test-receipt.txt' });
        else text = 'The desktop fixture is complete.';
      } else if (user.includes('Workbench billing fixture')) {
        res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'The fixture provider is unavailable' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [delta, finish_reason] of [[{ role: 'assistant' }, null], [call ? { tool_calls: [call] } : { content: text }, null], [{}, call ? 'tool_calls' : 'stop']]) {
        res.write('data: ' + JSON.stringify({ id: 'chatcmpl-demo', object: 'chat.completion.chunk', created: 1, model: body.model,
          choices: [{ index: 0, delta, finish_reason }], ...(finish_reason && { usage: { prompt_tokens: 54, completion_tokens: 12, total_tokens: 66 } }) }) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      failures.push(error.message);
      if (!res.headersSent) res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, address: `http://127.0.0.1:${server.address().port}`, requests, failures, signIns: () => signIns };
}

module.exports = { serveFixture, testPassphrase };
