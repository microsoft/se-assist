'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const [script, ...extra] = process.argv.slice(2);
if (!/^test-[a-z0-9-]+-electron\.cjs$/.test(script || '') || extra.length) {
  throw new Error('Supply one Electron test filename from desktop\\scripts. The runner owns its isolated user-data directory.');
}
const filename = path.join(__dirname, script);
if (!fs.existsSync(filename)) throw new Error(`Electron test not found: ${filename}`);
const electron = require('electron');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), `se-assist-${path.basename(script, '.cjs')}-`));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [filename, `--user-data-dir=${userData}`], { env, stdio: 'inherit' });
console.log(`Isolated Electron user data: ${userData}`);

child.on('error', error => console.error('Could not start the Electron test:', error));
child.on('close', (code, signal) => {
  process.exitCode = Number.isInteger(code) && code >= 0 ? code : 1;
  if (signal) console.error(`Electron test terminated by ${signal}.`);
  try {
    fs.rmSync(userData, { recursive: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.error(`Could not remove the isolated test directory ${userData}:`, error);
    process.exitCode = 1;
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
