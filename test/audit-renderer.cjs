const { spawn } = require('node:child_process');
const { cpSync, mkdirSync, mkdtempSync, writeFileSync, copyFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temporary = path.join(root, '.cache', 'tmp');
mkdirSync(temporary, { recursive: true });
const fixture = mkdtempSync(path.join(temporary, 'audit-renderer-'));
for (const name of ['electron', 'renderer', 'assets']) {
  cpSync(path.join(root, name), path.join(fixture, name), { recursive: true });
}
copyFileSync(path.join(__dirname, 'audit-renderer-harness.cjs'), path.join(fixture, 'harness.cjs'));
writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'feinchat-audit-renderer', main: 'harness.cjs' }));
const child = spawn(require('electron'), [fixture, '--lang=ru'], {
  stdio: 'inherit', env: { ...process.env, TEMP: temporary, TMP: temporary },
});
const timer = setTimeout(() => { child.kill(); console.error('Renderer audit timed out: ' + fixture); process.exitCode = 1; }, 180_000);
child.once('error', (error) => { clearTimeout(timer); throw error; });
child.once('exit', (code) => {
  clearTimeout(timer);
  console.log('Renderer audit fixture: ' + fixture);
  process.exitCode = code === 0 ? 0 : 1;
});
