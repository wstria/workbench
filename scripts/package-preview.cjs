const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const builder = require.resolve('electron-builder/cli.js');
const run = (file, args) => execFileSync(file, args, { stdio: 'inherit' });
if (process.platform !== 'darwin') {
  run(process.execPath, [builder, '--dir']);
} else {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-build-'));
  try {
    const architecture = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
    const output = path.resolve('dist');
    const bundle = path.join(stage, architecture, 'Workbench.app');
    const archive = `Workbench-macOS-${process.arch}-preview.zip`;
    // Build and sign outside synced folders, which can attach Finder metadata to a bundle.
    const buildEnv = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
    delete buildEnv.CSC_LINK;
    delete buildEnv.CSC_NAME;
    execFileSync(process.execPath, [builder, '--dir', '-c.directories.output=' + stage], {
      stdio: 'inherit', env: buildEnv,
    });
    run('/usr/bin/xattr', ['-cr', bundle]);
    run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', bundle]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle, path.join(stage, archive)]);
    fs.mkdirSync(path.join(output, architecture), { recursive: true });
    const packaged = path.join(output, architecture, 'Workbench.app');
    fs.rmSync(packaged, { recursive: true, force: true });
    run('/usr/bin/ditto', ['--norsrc', '--noextattr', bundle, packaged]);
    fs.copyFileSync(path.join(stage, archive), path.join(output, archive));
    console.log('Mac preview: ' + path.join(output, archive));
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
