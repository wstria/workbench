const fs = require('node:fs');

function redact(value) {
  return String(value ?? '').replace(/\bsk-[\w*-]{8,}/g, '[redacted key]');
}

function readSmallText(file) {
  try {
    if (fs.statSync(file).size <= 256 * 1024) return fs.readFileSync(file, 'utf8');
  } catch {
    return fs.existsSync(file) ? undefined : '';
  }
}

function savedEntries(store, id) {
  return store.transcript(id).map((entry) => entry.status === 'running' ? { ...entry, status: 'stopped' } : entry);
}

const noAttachments = { text: [], images: [], names: [] };

module.exports = { redact, readSmallText, savedEntries, noAttachments };
