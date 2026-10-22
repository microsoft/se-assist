'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAcrFileLogger } = require('../acr-request-log');

function tmpLogFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acrlog-'));
  return path.join(dir, 'acr-querydata.log');
}

test('requires a filePath', () => {
  assert.throws(() => createAcrFileLogger({}), /filePath is required/);
});

test('appends info and warn lines with an ISO timestamp + level to the file', () => {
  const filePath = tmpLogFile();
  const con = { log() {}, warn() {} };
  const log = createAcrFileLogger({
    filePath,
    console: con,
    now: () => new Date('2026-01-01T00:00:00Z'),
  });
  log.info('fetched 14 rows');
  log.warn('HTTP 429 throttle, retrying in 5s (attempt 1/5)');
  const text = fs.readFileSync(filePath, 'utf8');
  assert.ok(text.includes('2026-01-01T00:00:00.000Z [info] fetched 14 rows'));
  assert.ok(text.includes('2026-01-01T00:00:00.000Z [warn] HTTP 429 throttle, retrying in 5s (attempt 1/5)'));
});

test('mirrors output to the console with the [acr-querydata] prefix', () => {
  const filePath = tmpLogFile();
  const seen = [];
  const con = { log: (m) => seen.push(['log', m]), warn: (m) => seen.push(['warn', m]) };
  const log = createAcrFileLogger({ filePath, console: con });
  log.info('… windowing: 100 rows so far');
  log.warn('transient error (timeout), retrying in 10s (attempt 2/5)');
  assert.deepEqual(seen[0], ['log', '[acr-querydata] … windowing: 100 rows so far']);
  assert.deepEqual(seen[1], ['warn', '[acr-querydata] transient error (timeout), retrying in 10s (attempt 2/5)']);
});

test('rotates to <file>.1 once the file exceeds maxBytes', () => {
  const filePath = tmpLogFile();
  const con = { log() {}, warn() {} };
  const log = createAcrFileLogger({ filePath, maxBytes: 200, console: con });
  for (let i = 0; i < 50; i++) log.info(`${'x'.repeat(30)} line ${i}`);
  assert.ok(fs.existsSync(`${filePath}.1`), 'expected a rotated backup file');
  assert.ok(fs.existsSync(filePath), 'expected the live log file to still exist');
});

test('never throws when the target directory cannot be created', () => {
  // Point the log at a path nested under an existing *file*, so mkdir fails.
  const base = tmpLogFile();
  fs.writeFileSync(base, 'i-am-a-file');
  const con = { log() {}, warn() {} };
  const log = createAcrFileLogger({ filePath: path.join(base, 'nested', 'acr.log'), console: con });
  assert.doesNotThrow(() => { log.info('hello'); log.warn('world'); });
});
