/**
 * app-prefs.js — tiny plaintext JSON store for non-secret desktop preferences
 * (e.g. the selected GitHub Copilot model). Lives in userData/app-prefs.json.
 *
 * Secrets (tokens, auth caches) must NOT go here — use secure-store.js instead.
 * Must be used after app.whenReady() (relies on app.getPath('userData')).
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function prefsFile() {
  return path.join(app.getPath('userData'), 'app-prefs.json');
}

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function get(key, fallback = null) {
  const value = readAll()[key];
  return value === undefined ? fallback : value;
}

function set(key, value) {
  const all = readAll();
  if (value === null || value === undefined) {
    delete all[key];
  } else {
    all[key] = value;
  }
  try {
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
    fs.writeFileSync(prefsFile(), JSON.stringify(all, null, 2));
    return true;
  } catch {
    return false;
  }
}

module.exports = { get, set };
