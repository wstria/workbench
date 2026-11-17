const assert = require('node:assert/strict');

const token = 'test-fixture-secret-token';
const renewed = 'test-fixture-renewed-token';
const apiUrl = 'https://fixture.api.fastmail.com/jmap/api/';
const mail = 'urn:ietf:params:jmap:mail';
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value).reverse(),
  decryptString: (value) => Buffer.from(value).reverse().toString(),
};

function fixture({ revoked = () => false } = {}) {
  const calls = [];
  let activeToken = token;
  let apiAddress = apiUrl;
  let offline = false;
  const now = '2026-11-17T16:20:00Z';
  const messages = [
    { id: 'M1', threadId: 'T1', subject: 'Board packet', preview: 'Can you add the final chart by Friday?',
      from: [{ name: 'Alex' }], messageId: ['board+packet@example.test'], receivedAt: now },
    { id: 'M2', threadId: 'T2', subject: 'Action required today', preview: 'Please confirm the final numbers.',
      from: [{ email: 'schedule@example.test' }], messageId: ['urgent@example.test'], receivedAt: '2026-11-17T13:00:00Z' },
    { id: 'M3', threadId: 'T1', subject: 'Older duplicate', from: [{ name: 'Alex' }], receivedAt: '2026-11-15T18:00:00Z' },
    { id: 'M4', threadId: 'T3', subject: 'Status digest', preview: 'All clear.',
      keywords: { $seen: true }, receivedAt: '2026-11-16T14:00:00Z' },
  ];
  return {
    calls,
    revoke() { activeToken = renewed; },
    setAddress(value) { apiAddress = value; },
    setOffline(value) { offline = value; },
    async request(url, options) {
      calls.push({ url, method: options.method });
      assert.equal(options.redirect, 'error');
      if (offline) throw new Error('Fixture provider unavailable');
      if (options.signal.aborted) throw options.signal.reason;
      if (options.headers.Authorization !== 'Bearer ' + (revoked() ? renewed : activeToken)) return new Response(null, { status: 401 });
      if (options.method === 'GET') {
        assert.equal(url, 'https://api.fastmail.com/jmap/session');
        return Response.json({ username: 'me@example.test', apiUrl: apiAddress, primaryAccounts: { [mail]: 'u1' }, accounts: { u1: {} } });
      }
      assert.equal(url, apiUrl);
      const { using, methodCalls } = JSON.parse(options.body);
      assert.ok(using.includes(mail));
      const methods = methodCalls.map(([method]) => method);
      calls.at(-1).methods = methods;
      if (methods[0] === 'Mailbox/get') {
        assert.deepEqual(methods, ['Mailbox/get']);
        return Response.json({ methodResponses: [['Mailbox/get', { list: [{ id: 'inbox1', role: 'inbox' }] }, 'mailboxes']] });
      }
      assert.deepEqual(methods, ['Email/query', 'Email/get']);
      const [, query] = methodCalls[0];
      assert.deepEqual(query.filter, { inMailbox: 'inbox1' });
      assert.equal(query.collapseThreads, true);
      assert.equal(query.limit, 24);
      assert.equal(methodCalls[1][1]['#ids'].resultOf, 'query');
      return Response.json({ methodResponses: [
        ['Email/query', { ids: messages.map((message) => message.id) }, 'query'],
        ['Email/get', { list: messages }, 'messages'],
      ] });
    },
  };
}

module.exports = { fixture, safeStorage, token, renewed };
