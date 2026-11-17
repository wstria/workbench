const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBrowserImports, parseBookmarkHtml, exportBookmarks, chromiumPreferences } = require('../src/main/browser-import');
const { validateBrowserPreferences } = require('../src/main/browser-preferences');

test('bookmark HTML preserves nested paths and treats page markup as data', () => {
  const result = parseBookmarkHtml(`<!DOCTYPE NETSCAPE-Bookmark-file-1>
    <A HREF="https://outside.example">Outside</A><H1>Bookmarks</H1>
    <DL><p><DT><H3>Favorites &amp; friends</H3><DL><p>
      <DT><A HREF="https://example.com/?first=1&amp;second=2">Notes &lt;draft&gt;</A>
      <DT><H3>Reading</H3><DL><p>
        <DT><A HREF="https://読書.example">Book</A>
        <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
        <DT><A HREF="https://alice:password@example.com">URL with credentials</A>
        <SCRIPT>const ignored = '<A HREF="https://script.example">Hidden</A>'</SCRIPT>
      </DL><p>
    </DL><p><DT><A HREF="https://example.org">Top</A></DL><p>`);
  assert.deepEqual(result, { bookmarks: [
    { url: 'https://example.com/?first=1&second=2', name: 'Notes <draft>', folder: ['Favorites & friends'] },
    { url: new URL('https://読書.example').href, name: 'Book', folder: ['Favorites & friends', 'Reading'] },
    { url: 'https://example.org/', name: 'Top', folder: [] },
  ], skipped: 2 });
  assert.throws(() => parseBookmarkHtml('<html><dl><a href="https://example.com">Not an export</a></dl></html>'), /HTML bookmarks export/);
});

test('export round-trips bookmark folders without including local favorites or metadata', () => {
  const items = [
    { type: 'file', name: 'Secret.md', path: '/private/Secret.md' },
    { type: 'web', url: 'https://example.org', name: '<Story>', bookmarkFolder: ['My "links"'], notes: 'Private note' },
  ];
  const html = exportBookmarks(items);
  assert.doesNotMatch(html, /Secret.md|Private note/);
  assert.deepEqual(parseBookmarkHtml(html).bookmarks, [{ url: 'https://example.org/', name: '<Story>', folder: ['My "links"'] }]);
});

test('browser preference import maps known search engines and validates home addresses', () => {
  const imported = chromiumPreferences({
    default_search_provider_data: { template_url_data: { url: 'https://www.google.com.evil.example/?q={searchTerms}' } },
    homepage: 'chrome://new-tab-page',
    bookmark_bar: { show_on_all_tabs: false },
  });
  assert.deepEqual(imported, { showBookmarksBar: false });
  assert.deepEqual(chromiumPreferences({ default_search_provider_data: { template_url_data: { url: '{google:baseURL}search?q={searchTerms}' } } }), { searchEngine: 'google' });
  assert.throws(() => validateBrowserPreferences({ searchEngine: 'bing', homePage: 'file:///etc/passwd', showBookmarksBar: true }), /HTTP or HTTPS/);
  assert.deepEqual(validateBrowserPreferences({ searchEngine: 'brave', homePage: ' https://example.org ', showBookmarksBar: true }),
    { searchEngine: 'brave', homePage: 'https://example.org/', showBookmarksBar: true });
});

test('Chromium profile preview imports account and local bookmarks only after confirmation', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'workbench-browser-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, '.config', 'google-chrome');
  const folder = path.join(root, 'Default');
  await mkdir(folder, { recursive: true });
  const json = (file, value) => writeFile(file, JSON.stringify(value));
  const rootWith = (url, name) => ({ roots: { bookmark_bar: {
    type: 'folder', name: 'Bookmarks bar', children: [{ type: 'url', url, name }],
  } } });
  await Promise.all([
    json(path.join(root, 'Local State'), { profile: { info_cache: { Default: { name: 'My profile', user_name: 'private@example.com' } } } }),
    json(path.join(folder, 'Bookmarks'), rootWith('https://example.org', 'Duplicate title')),
    json(path.join(folder, 'AccountBookmarks'), rootWith('https://example.com', 'Account link')),
    json(path.join(folder, 'Preferences'), { homepage: 'https://example.com', bookmark_bar: { show_on_all_tabs: true } }),
    writeFile(path.join(folder, 'Login Data'), 'Private credentials fixture'),
  ]);
  const existing = { type: 'web', key: 'web:https://example.org/', url: 'https://example.org/', name: 'Saved', tags: ['research'] };
  let writes = 0;
  const store = { data: { favorites: [existing], preferences: { editorWrap: true } }, update() { writes++; } };
  const imports = createBrowserImports({ store, home, env: {}, platform: 'linux' });
  const owner = {};
  const profiles = await imports.list();
  assert.equal(profiles.length, 1);
  assert.deepEqual(Object.keys(profiles[0]).sort(), ['browser', 'id', 'name']);
  assert.equal(profiles[0].name, 'My profile');
  const read = () => imports.profile(owner, profiles[0].id);
  const preview = await read();
  assert.equal(preview.bookmarkCount, 2);
  assert.equal(writes, 0);
  assert.throws(() => imports.apply({}, preview.token, { bookmarks: true }), /Choose a browser import/);
  assert.deepEqual(imports.apply(owner, preview.token, { bookmarks: true }), { added: 1, duplicates: 1, preferences: 0 });
  assert.equal(store.data.favorites[1], existing);
  assert.equal(store.data.favorites[0].name, 'Account link');
  assert.deepEqual(store.data.favorites[0].bookmarkFolder, ['Bookmarks bar']);
  assert.throws(() => imports.apply(owner, preview.token, { preferences: true }), /Choose a browser import/);
  const again = await read();
  assert.deepEqual(imports.apply(owner, again.token, { bookmarks: true, preferences: true }), { added: 0, duplicates: 2, preferences: 2 });
  assert.deepEqual(store.data.preferences, { editorWrap: true, homePage: 'https://example.com/', showBookmarksBar: true });
});
