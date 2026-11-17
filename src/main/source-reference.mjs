export function sourceLink(source) {
  if (!source || !['file', 'web', 'session'].includes(source.type)) return '';
  const uri = new URL('workbench://source');
  for (const field of ['type', 'name', 'path', 'url', 'id', 'line', 'page', 'messageId', 'fingerprint', 'captureId']) {
    if (source[field] !== undefined) uri.searchParams.set(field, String(source[field]));
  }
  return uri.href;
}

export function sourceFromLink(value) {
  if (typeof value !== 'string' || value.length > 18000) return null;
  const uri = URL.parse(value);
  if (uri?.protocol !== 'workbench:' || uri.host !== 'source' || uri.username || uri.password || uri.pathname || uri.hash) return null;
  const query = uri.searchParams;
  const type = query.get('type');
  const name = query.get('name')?.slice(0, 240);
  const numeric = (key) => {
    const number = +query.get(key);
    return Number.isSafeInteger(number) && number > 0 && number <= 10000000 ? number : undefined;
  };
  const id = (key) => /^[\w-]{1,128}$/.test(query.get(key) ?? '') ? query.get(key) : undefined;
  if (type === 'file') {
    const path = query.get('path');
    if (!path || path.includes('\0') || !/^(?:[\\/]|[a-z]:[\\/])/i.test(path)) return null;
    const fingerprint = /^[a-f\d]{64}$/.test(query.get('fingerprint') ?? '') ? query.get('fingerprint') : undefined;
    return { type, path, name, line: numeric('line'), page: numeric('page'), fingerprint };
  }
  if (type === 'web') {
    const url = URL.parse(query.get('url') ?? '');
    if (!['http:', 'https:'].includes(url?.protocol) || url.username || url.password) return null;
    return { type, url: url.href, name, captureId: id('captureId') };
  }
  if (type === 'session' && id('id')) return { type, id: id('id'), name, messageId: id('messageId') };
  return null;
}
