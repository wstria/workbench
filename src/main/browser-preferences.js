const searchEngines = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
  brave: 'https://search.brave.com/search?q=',
  yahoo: 'https://search.yahoo.com/search?p=',
  ecosia: 'https://www.ecosia.org/search?q=',
  startpage: 'https://www.startpage.com/sp/search?query=',
};

function webUrl(value) {
  if (typeof value !== 'string') throw new Error('Enter an HTTP or HTTPS address.');
  const url = URL.parse(value);
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Enter an HTTP or HTTPS address.');
  }
  return url.href;
}

function validateBrowserPreferences(input) {
  const { searchEngine, homePage, showBookmarksBar } = input ?? {};
  if (!Object.hasOwn(searchEngines, searchEngine) || typeof homePage !== 'string' || homePage.length > 4096 || typeof showBookmarksBar !== 'boolean') {
    throw new Error('Choose valid browser preferences.');
  }
  return { searchEngine, homePage: homePage.trim() ? webUrl(homePage.trim()) : '', showBookmarksBar };
}

module.exports = { searchEngines, webUrl, validateBrowserPreferences };
