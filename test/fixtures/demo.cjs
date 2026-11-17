const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const clause = 'Either party can terminate this agreement on sixty days notice.';
const passage = 'The operating manual calls for a thirty-day review before renewal.';
const note = 'The amber compass identifies the original renewal question.';
const broken = "module.exports = function add(a, b) { return a - b; };\n";
const fixed = "module.exports = function add(a, b) { return a + b; };\n";
const check = "const assert = require('node:assert/strict');\nconst add = require('./add.cjs');\nassert.equal(add(6, 7), 13);\n";

async function seed(workspace, { existingDirectory = false } = {}) {
  await fs.mkdir(workspace, { recursive: existingDirectory });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of ['Harbor services agreement. The notice clause is on the next page.', clause]) {
    pdf.addPage().drawText(text, { x: 48, y: 752, font, size: 12 });
  }
  const notePath = path.join(workspace, 'Research.md');
  const pdfPath = path.join(workspace, 'Harbor agreement.pdf');
  const webPath = path.join(workspace, 'browser-fixture.html');
  const repoPath = path.join(workspace, 'calculator');
  await fs.mkdir(repoPath);
  const content = `---\ntags: [renewal, demo]\n---\n# Research\n${note}\nSee [[Harbor agreement.pdf]].\n`;
  const site = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Renewal operating manual</title>' +
    '<main><h1>Renewal operating manual</h1><p>' + passage + '</p>' +
    '<form action="/receipt" method="post"><label>Fixture passphrase <input type="password" name="passphrase" required></label>' +
    '<button type="submit">Sign in</button></form></main></html>';
  await Promise.all([
    fs.writeFile(notePath, content, { flag: 'wx' }), fs.writeFile(pdfPath, await pdf.save(), { flag: 'wx' }),
    fs.writeFile(webPath, site, { flag: 'wx' }), fs.writeFile(path.join(repoPath, 'add.cjs'), broken, { flag: 'wx' }),
    fs.writeFile(path.join(repoPath, 'add.test.cjs'), check, { flag: 'wx' }),
    fs.writeFile(path.join(repoPath, '.gitignore'), 'node_modules/\n.env\n', { flag: 'wx' }),
  ]);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=Workbench Demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Seed failing calculator');
  return { workspace, notePath, pdfPath, webPath, repoPath };
}


module.exports = { seed, clause, passage, note, broken, fixed };
