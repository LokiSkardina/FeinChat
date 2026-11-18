const { spawn } = require('node:child_process');
const { copyFileSync, cpSync, mkdtempSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const fixture = mkdtempSync(path.join(root, '.cache', 'tmp', 'desktop-'));
for (const folder of ['assets', 'renderer', 'electron']) {
  cpSync(path.join(root, folder), path.join(fixture, folder), { recursive: true });
}
copyFileSync(path.join(__dirname, 'desktop-harness.cjs'), path.join(fixture, 'harness.cjs'));
writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'feinchat-test', main: 'harness.cjs' }));

function session(phase) {
  return new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [fixture, phase], { stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Desktop check timed out in ${phase}. Fixture: ${fixture}`));
    }, 60_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Desktop check ${phase} exited with ${code}. Fixture: ${fixture}`));
    });
  });
}

async function run() {
  await session('exercise');
  await session('reopen');
  console.log('Desktop checks passed. Test window captures: ' + fixture);
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
