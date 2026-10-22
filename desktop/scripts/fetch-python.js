'use strict';

/**
 * fetch-python.js — download & vendor the Windows embeddable Python runtime that
 * ships with the packaged app so ingestion (tools/*.py) never depends on a
 * system Python being present on the user's PATH.
 *
 * Runs as a build prestep (see package.json "build"). Idempotent: if the pinned
 * runtime is already vendored it does nothing.
 *
 * The vendored runtime is copied into the installer via electron-builder
 * `extraResources` (vendor/python -> resources/python). At runtime m365-ingest.js
 * prefers resources/python/python.exe over PATH.
 *
 * The pipeline is stdlib-only (verified: argparse/json/sqlite3/pathlib/re/…), so
 * the embeddable distribution needs no pip install. The one required tweak is the
 * `._pth` file: embeddable Python ignores PYTHONPATH and cwd, so we add a `..`
 * entry that makes the runtime's parent dir (resources/, which holds tools/)
 * importable — letting `python -m tools.<medium>.cli` resolve the `tools`
 * namespace package.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

// Pinned to match the dev interpreter (3.11.x). Windows amd64 embeddable build.
const PY_VERSION = '3.11.9';
const ARCH = 'amd64';
const ZIP_NAME = `python-${PY_VERSION}-embed-${ARCH}.zip`;
const URL = `https://www.python.org/ftp/python/${PY_VERSION}/${ZIP_NAME}`;

const VENDOR_DIR = path.resolve(__dirname, '..', 'vendor', 'python');
const PY_EXE = path.join(VENDOR_DIR, 'python.exe');

function log(msg) {
  console.log(`[fetch-python] ${msg}`);
}

function alreadyVendored() {
  if (!fs.existsSync(PY_EXE)) return false;
  const res = spawnSync(PY_EXE, ['--version'], { encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (res.status === 0 && out.includes(PY_VERSION)) {
    log(`already vendored: ${out} at ${VENDOR_DIR}`);
    return true;
  }
  return false;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.rmSync(dest, { force: true });
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.rmSync(dest, { force: true });
        return reject(new Error(`download failed (${res.statusCode}) for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      return undefined;
    });
    req.on('error', (err) => {
      file.close();
      fs.rmSync(dest, { force: true });
      reject(err);
    });
  });
}

// Extract via PowerShell Expand-Archive (Windows build host; no external deps).
function extractZip(zipPath, destDir) {
  const res = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`,
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) {
    throw new Error(`Expand-Archive failed: ${(res.stderr || res.stdout || '').trim()}`);
  }
}

// Make the runtime's parent dir importable so `python -m tools.*` resolves the
// `tools` namespace package (embeddable Python ignores PYTHONPATH and cwd).
function patchPthFile(dir) {
  const pth = fs.readdirSync(dir).find((f) => /^python\d+\._pth$/i.test(f));
  if (!pth) throw new Error('no ._pth file found in embeddable distribution');
  const full = path.join(dir, pth);
  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
  const kept = [];
  let hasParent = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '..') hasParent = true;
    // Drop empty trailing lines; keep meaningful entries and comments.
    if (line.length) kept.push(line);
  }
  if (!hasParent) {
    // Insert `..` right after the `.` (interpreter dir) entry, else append.
    const dotIdx = kept.indexOf('.');
    if (dotIdx >= 0) kept.splice(dotIdx + 1, 0, '..');
    else kept.push('..');
  }
  fs.writeFileSync(full, `${kept.join('\n')}\n`, 'utf8');
  log(`patched ${pth}: ${kept.join(' | ')}`);
}

async function main() {
  if (process.platform !== 'win32') {
    log(`skipping: host is ${process.platform}, embeddable runtime is Windows-only (build target is --win).`);
    return;
  }
  if (alreadyVendored()) return;

  fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  const zipPath = path.join(os.tmpdir(), ZIP_NAME);
  log(`downloading ${URL}`);
  await download(URL, zipPath);
  log(`extracting to ${VENDOR_DIR}`);
  extractZip(zipPath, VENDOR_DIR);
  fs.rmSync(zipPath, { force: true });

  patchPthFile(VENDOR_DIR);

  const res = spawnSync(PY_EXE, ['--version'], { encoding: 'utf8' });
  const ver = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (res.status !== 0 || !ver.includes(PY_VERSION)) {
    throw new Error(`vendored runtime failed sanity check: ${ver || res.status}`);
  }
  log(`vendored ${ver}`);
}

main().catch((err) => {
  console.error(`[fetch-python] ERROR: ${err.message}`);
  process.exit(1);
});
