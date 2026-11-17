const fs = require('node:fs/promises');
const path = require('node:path');

const pdfPackage = path.dirname(require.resolve('pdfjs-dist/package.json'));
const resourceDirs = {
  cMapUrl: 'cmaps',
  standardFontDataUrl: 'standard_fonts',
  wasmUrl: 'wasm',
  iccUrl: 'iccs',
};
const resourceOptions = Object.fromEntries(Object.entries(resourceDirs)
  .map(([kind, directory]) => [kind, path.join(pdfPackage, directory) + path.sep]));

async function readPdfResource(kind, filename) {
  if (!Object.hasOwn(resourceDirs, kind) || typeof filename !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(filename)) {
    throw new Error('Invalid PDF resource request.');
  }
  return new Uint8Array(await fs.readFile(path.join(resourceOptions[kind], filename)));
}

async function openPdf(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return getDocument({ ...resourceOptions, data: new Uint8Array(bytes), isEvalSupported: false });
}

module.exports = { openPdf, readPdfResource };
