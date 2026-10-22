/**
 * secure-store.js — tiny encrypted-at-rest key/value store for SE Assist.
 *
 * Wraps Electron's safeStorage (DPAPI on Windows, Keychain on macOS, libsecret on
 * Linux) so the in-app Microsoft (MSAL) token cache and GitHub OAuth token can be
 * persisted across launches without writing plaintext secrets to disk.
 *
 * If OS-level encryption is unavailable we DO NOT fall back to plaintext — `read`
 * returns null and `write` is a no-op, so callers simply re-authenticate each launch.
 * Must be used after `app.whenReady()` (safeStorage requires the app to be ready).
 */
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

function storeDir() {
  const dir = path.join(app.getPath('userData'), 'secure');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileFor(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(storeDir(), `${safe}.bin`);
}

function isAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

// Persist a string securely. Returns true when written, false when encryption is
// unavailable (caller keeps the value in memory only).
function writeString(name, value) {
  if (!isAvailable()) return false;
  try {
    const encrypted = safeStorage.encryptString(String(value));
    fs.writeFileSync(fileFor(name), encrypted);
    return true;
  } catch {
    return false;
  }
}

function readString(name) {
  if (!isAvailable()) return null;
  try {
    const file = fileFor(name);
    if (!fs.existsSync(file)) return null;
    const buf = fs.readFileSync(file);
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

function writeJson(name, obj) {
  return writeString(name, JSON.stringify(obj));
}

function readJson(name) {
  const raw = readString(name);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function remove(name) {
  try {
    const file = fileFor(name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // best effort
  }
}

module.exports = { isAvailable, writeString, readString, writeJson, readJson, remove };
