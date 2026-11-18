const { spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
process.chdir(root);
for (const [name, folder] of Object.entries({
  NPM_CONFIG_CACHE: 'npm',
  ELECTRON_CACHE: 'electron',
  electron_config_cache: 'electron',
  ELECTRON_BUILDER_CACHE: 'builder',
  TEMP: 'tmp',
  TMP: 'tmp',
})) {
  const directory = path.join(root, '.cache', folder);
  mkdirSync(directory, { recursive: true });
  process.env[name] = directory;
}

function run(bin, args) {
  const result = spawnSync(bin, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function node(file, ...args) {
  run(process.execPath, [file, ...args]);
}

function build() {
  node('node_modules/vite/bin/vite.js', 'build');
}

switch (process.argv[2]) {
  case 'setup':
    node(process.env.npm_execpath, 'ci', '--no-audit', '--no-fund');
    node('node_modules/electron/install.js');
    break;
  case 'build':
    build();
    break;
  case 'dev':
    build();
    run(require('electron'), [root]);
    break;
  case 'check':
    node('--test', 'test/core.test.cjs', 'test/audit-main.test.cjs',
      'test/audit-store.test.cjs', 'test/audit-stream.test.cjs');
    build();
    node('test/desktop.cjs');
    node('test/audit-renderer.cjs');
    break;
  case 'portable': {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      throw new Error('Windows portable packaging requires x64 Node.js on Windows.');
    }
    build();
    const electronDir = path.dirname(require('electron'));
    const releaseDir = path.join(root, 'release');
    mkdirSync(releaseDir, { recursive: true });
    const output = mkdtempSync(path.join(releaseDir, 'build-'));
    node('node_modules/electron-builder/out/cli/cli.js', '--win', 'dir', '--x64', '--publish', 'never',
      '--config.directories.output=' + output, '--config.electronDist=' + electronDir);
    console.log(path.join(output, 'win-unpacked', 'FeinChat.exe'));
    break;
  }
  default:
    throw new Error('Unknown FeinChat command.');
}
