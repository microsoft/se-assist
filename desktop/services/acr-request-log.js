/**
 * acr-request-log.js — persistent, rotating file logger for the ACR Power BI
 * query engine (acr-querydata.js).
 *
 * The engine already emits a rich per-request trail (HTTP 429/503 throttles with
 * their Retry-After / backoff waits, transient-error retries, and per-window row
 * progress) via an injected `logger`. In production that logger defaulted to the
 * console only, and the app persists no main-process log — so when a load was
 * slow there was no durable record of *why* (how many 429s, how the backoff grew,
 * how many windows). This module writes that same trail to a small rotating file
 * under the app's userData dir so a slow load can be diagnosed after the fact.
 *
 * Purely additive observability: it changes no retry/throttle/cache behavior and
 * never throws — a logging failure must never break a data fetch (repo policy:
 * fail loudly on real errors, but logging is best-effort by design).
 */
const fs = require('fs');
const path = require('path');

/**
 * @param {object} opts
 * @param {string} opts.filePath           Absolute path of the log file to append to.
 * @param {number} [opts.maxBytes=1000000] Rotate to `<file>.1` once the file exceeds this size.
 * @param {() => Date} [opts.now]          Clock (injectable for tests).
 * @param {Console} [opts.console]         Console sink (injectable for tests); mirrors the
 *                                         prior `[acr-querydata]` console output so nothing is lost.
 * @returns {{ info: (m: any) => void, warn: (m: any) => void, filePath: string }}
 */
function createAcrFileLogger({
  filePath,
  maxBytes = 1_000_000,
  now = () => new Date(),
  console: con = console,
} = {}) {
  if (!filePath) throw new Error('createAcrFileLogger: filePath is required.');
  let dirReady = false;

  function ensureDir() {
    if (dirReady) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      dirReady = true;
    } catch {
      /* best-effort: fall through, appendFileSync will simply fail silently */
    }
  }

  // Single-backup rotation: when the live file grows past maxBytes, move it to
  // `<file>.1` (replacing any prior backup) so the log can't grow unbounded.
  function rotateIfNeeded() {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > maxBytes) {
        const backup = `${filePath}.1`;
        try { fs.rmSync(backup, { force: true }); } catch { /* ignore */ }
        fs.renameSync(filePath, backup);
      }
    } catch {
      /* file does not exist yet (nothing to rotate) — fine */
    }
  }

  function write(level, message) {
    // Preserve the original console behavior (prefix + stream) so existing
    // terminal diagnostics are unchanged; the file is an addition, not a move.
    const line = `[acr-querydata] ${message}`;
    if (level === 'warn') con.warn(line);
    else con.log(line);

    ensureDir();
    rotateIfNeeded();
    try {
      fs.appendFileSync(filePath, `${now().toISOString()} [${level}] ${message}\n`);
    } catch {
      /* never let logging break a fetch */
    }
  }

  return {
    info: (m) => write('info', String(m)),
    warn: (m) => write('warn', String(m)),
    filePath,
  };
}

module.exports = { createAcrFileLogger };
