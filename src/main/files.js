const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const ExcelJS = require('exceljs');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { atomicWrite } = require('./store');
const { createVersions } = require('./versions');

const images = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
const media = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };
const sheets = new Set(['.xlsx', '.csv', '.tsv']);
const binaryLimit = 48 * 1024 * 1024;
const templates = {
  note: { extension: '.md', name: 'Untitled note', content: '' },
  doc: { extension: '.md', name: 'Untitled document', content: '# Untitled document\n\n' },
  sheet: { extension: '.xlsx', name: 'Untitled spreadsheet' },
  code: { extension: '.js', name: 'Untitled script', content: '// Write your code here\n' },
  design: { extension: '.html', name: 'Untitled design', content: '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Untitled design</title></head>\n<body>\n</body>\n</html>\n' },
  data: { extension: '.csv', name: 'Untitled data', content: 'Name,Value\n' },
  pdf: { extension: '.pdf', name: 'Untitled PDF' },
};

function isInside(folder, file) {
  try {
    const relative = path.relative(fs.realpathSync(folder), file);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function revision(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readWorkbook(bytes, extension) {
  const workbook = new ExcelJS.Workbook();
  if (extension === '.xlsx') await workbook.xlsx.load(bytes);
  else await workbook.csv.read(Readable.from([bytes]), {
    parserOptions: { delimiter: extension === '.tsv' ? '\t' : ',' },
    map: (value) => value,
    sheetName: 'Sheet 1',
  });
  return workbook;
}

function cellValue(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if ('formula' in value || 'sharedFormula' in value) return '';
  if ('text' in value) return value.text;
  if ('richText' in value) return value.richText.map((run) => run.text).join('');
  return String(value.error ?? '');
}

function createFiles(store, chosenWorkspaces = new Set()) {
  const versions = createVersions(store);
  function authorize(input) {
    const file = fs.realpathSync(input);
    const registered = store.data.artifacts.some((item) => item.path === file);
    const folders = [store.data.cwd, store.folders.artifacts, ...chosenWorkspaces, ...store.data.openFolders, ...(store.data.knowledgeVaults ?? []).map((vault) => vault.path), ...store.data.sessions.map((item) => item.cwd)];
    if (!registered && !folders.some((folder) => isInside(folder, file))) {
      throw new Error('Open this file using the file picker first.');
    }
    return file;
  }

  function register(input, created = false, log = true) {
    const file = fs.realpathSync(input);
    if (!fs.statSync(file).isFile()) throw new Error('Choose a file.');
    let item = store.data.artifacts.find((entry) => entry.path === file);
    if (!item) {
      item = { path: file, name: path.basename(file), extension: path.extname(file).toLowerCase(), created, at: Date.now() };
      store.data.artifacts.unshift(item);
      if (log) store.activity('file', created ? 'Created ' + item.name : 'Opened ' + item.name, file, { type: 'file', path: file });
      else store.update();
    }
    return item;
  }

  function read(input) {
    const file = authorize(input);
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('Choose a file.');
    const extension = path.extname(file).toLowerCase();
    const base = { path: file, name: path.basename(file), extension };
    if (stat.size > binaryLimit) return { ...base, kind: 'external' };
    const bytes = fs.readFileSync(file);
    const metadata = { ...base, revision: revision(bytes) };
    if (media[extension]) return { ...metadata, kind: 'media', mime: media[extension], bytes: new Uint8Array(bytes) };
    if (sheets.has(extension)) return { ...metadata, kind: 'sheet' };
    if (extension === '.pdf') return { ...metadata, kind: 'pdf', bytes: new Uint8Array(bytes) };
    if (images[extension]) return { ...metadata, kind: 'image', mime: images[extension], bytes: new Uint8Array(bytes) };
    if (stat.size <= 4 * 1024 * 1024 && !bytes.includes(0)) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        return { ...metadata, kind: 'text', text };
      } catch {
        return { ...metadata, kind: 'external' };
      }
    }
    return { ...metadata, kind: 'external' };
  }

  async function sheet(input, name, rowStart = 1, columnStart = 1) {
    if (![rowStart, columnStart].every((value) => Number.isSafeInteger(value) && value >= 1) || rowStart > 1048576 || columnStart > 16384) throw new Error('Invalid sheet position.');
    const file = authorize(input);
    const bytes = fs.readFileSync(file);
    if (bytes.length > binaryLimit) throw new Error('This workbook is too large to edit here.');
    const workbook = await readWorkbook(bytes, path.extname(file).toLowerCase());
    const ws = workbook.getWorksheet(name) ?? workbook.worksheets[0];
    if (!ws) throw new Error('This workbook has no worksheets.');
    const rows = Array.from({ length: Math.min(28, 1048577 - rowStart) }, (_, row) => (
      Array.from({ length: Math.min(10, 16385 - columnStart) }, (_, column) => {
        const cell = ws.findRow(row + rowStart)?.findCell(column + columnStart);
        if (!cell) return { value: '', display: '', formula: false };
        return { value: cell.formula ? '=' + cell.formula : cellValue(cell.value), display: cell.text, formula: Boolean(cell.formula) };
      })
    ));
    return { name: ws.name, names: workbook.worksheets.map((ws) => ws.name), rows };
  }

  async function create(kind, directory = store.folders.artifacts) {
    const template = Object.hasOwn(templates, kind) && templates[kind];
    if (!template) throw new Error('Unknown artifact type.');
    let contents = template.content;
    if (kind === 'sheet') {
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet('Sheet 1');
      contents = await workbook.xlsx.writeBuffer();
    }
    if (kind === 'pdf') {
      const document = await PDFDocument.create();
      document.addPage();
      contents = Buffer.from(await document.save());
    }
    let file = path.join(directory, template.name + template.extension);
    for (let suffix = 2; fs.existsSync(file); suffix += 1) {
      file = path.join(directory, template.name + ' ' + suffix + template.extension);
    }
    atomicWrite(file, contents);
    return register(file, true);
  }

  async function save(input, expected, change) {
    const file = authorize(input);
    const bytes = fs.readFileSync(file);
    if (revision(bytes) !== expected) throw new Error('The file changed on disk. Reopen it before saving.');
    const extension = path.extname(file).toLowerCase();
    let output;
    if (change.kind === 'text' && typeof change.text === 'string' && change.text.length <= 4 * 1024 * 1024 && read(file).kind === 'text') {
      output = change.text;
    } else if (change.kind === 'sheet' && sheets.has(extension)) {
      const workbook = await readWorkbook(bytes, extension);
      if (!Array.isArray(change.cells) || change.cells.length > 5000) throw new Error('Invalid spreadsheet edits.');
      for (const { name, row, column, value } of change.cells) {
        const ws = workbook.getWorksheet(name);
        if (!ws) throw new Error('Worksheet no longer exists.');
        if (!Number.isInteger(row) || !Number.isInteger(column) || row < 1 || row > 1048576 || column < 1 || column > 16384 || typeof value !== 'string' || value.length > 32767) {
          throw new Error('Invalid cell value.');
        }
        const cell = ws.getCell(row, column);
        if (extension === '.xlsx' && value.startsWith('=') && value.length > 1) cell.value = { formula: value.slice(1) };
        else if (extension === '.xlsx' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) cell.value = Number(value);
        else cell.value = value || null;
      }
      if (extension === '.xlsx') workbook.calcProperties.fullCalcOnLoad = true;
      output = extension === '.xlsx'
        ? await workbook.xlsx.writeBuffer()
        : await workbook.csv.writeBuffer({ sheetName: workbook.worksheets[0].name, formatterOptions: { delimiter: extension === '.tsv' ? '\t' : ',' } });
    } else if (change.kind === 'pdf' && extension === '.pdf') {
      const { page, x, y, text } = change;
      if (!Number.isInteger(page) || !Number.isFinite(x) || !Number.isFinite(y) || typeof text !== 'string' || !text.trim() || text.length > 500) {
        throw new Error('Invalid PDF note.');
      }
      const document = await PDFDocument.load(bytes);
      const target = document.getPages()[page - 1];
      if (!target) throw new Error('PDF page not found.');
      const font = await document.embedFont(StandardFonts.Helvetica);
      target.drawText(text, { x, y, size: 12, lineHeight: 15, maxWidth: Math.max(36, target.getWidth() - x - 15), font, color: rgb(0.15, 0.3, 0.56) });
      output = Buffer.from(await document.save());
    } else {
      throw new Error('Unsupported edit.');
    }
    if (revision(fs.readFileSync(file)) !== expected) throw new Error('The file changed while saving. Reopen it and retry.');
    versions.checkpoint(file, { bytes, label: 'Before saving' });
    atomicWrite(file, output, fs.statSync(file).mode & 0o777);
    store.activity('file', 'Saved ' + path.basename(file), file, { type: 'file', path: file });
    return read(file);
  }

  return { authorize, register, read, create, save, sheet,
    checkpoint: (input, options) => versions.checkpoint(authorize(input), options),
    timeline: (input) => versions.timeline(authorize(input)),
    versionPreview: (input, source, id) => versions.preview(authorize(input), source, id),
    restoreVersion(input, id, expected) {
      const file = authorize(input);
      versions.restore(file, id, expected);
      return read(file);
    },
    changes: (folder, file) => versions.changes(authorize(folder), file),
  };
}

module.exports = { createFiles, isInside, readWorkbook };
