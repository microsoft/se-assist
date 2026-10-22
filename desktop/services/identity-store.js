/**
 * identity-store.js — persists the signed-in Microsoft identity (display name + UPN)
 * to the local SQLite `app_settings` table.
 *
 * Why SQLite (not just the encrypted token cache): the rest of the app's data —
 * customers, milestones, meetings — already lives in the local seassist.db. Storing
 * "who you are" alongside it means that after the first successful M365 sign-in the
 * app knows your name/UPN on every subsequent launch WITHOUT a network round-trip,
 * so features that resolve "you" (e.g. the AI assistant's milestone lookup) keep
 * working offline. The values are refreshed on every successful sign-in.
 *
 * This is identity metadata, not a secret (no tokens) — tokens stay in secure-store.
 * Must be used after app.whenReady() (openDb relies on app.getPath('userData')).
 */
const { openDb } = require('../sqlite-ipc');

const NAME_KEY = 'signed_in_user_name';
const UPN_KEY = 'signed_in_user_upn';

// Upsert a single app_settings key. Empty/blank values are ignored so a partial
// status (e.g. name known but UPN missing) never clobbers a previously saved value.
function upsertSetting(db, key, value) {
  const clean = String(value == null ? '' : value).trim();
  if (!clean) return;
  db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, clean);
}

function readSetting(key) {
  try {
    const row = openDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row && row.value ? String(row.value).trim() : '';
  } catch {
    return '';
  }
}

// Persist the signed-in identity. `displayName` is the human name ("Alex Taylor") used to
// resolve "you"; `userName` is the UPN ("alex@example.com").
function saveIdentity({ displayName, userName } = {}) {
  try {
    const db = openDb();
    upsertSetting(db, NAME_KEY, displayName);
    upsertSetting(db, UPN_KEY, userName);
    return { name: readSetting(NAME_KEY), upn: readSetting(UPN_KEY) };
  } catch (err) {
    console.warn('[identity-store] failed to persist identity:', err.message);
    return null;
  }
}

// Best-effort saved display name for the signed-in user. Empty string when unknown.
function getSavedName() {
  return readSetting(NAME_KEY);
}

// Best-effort saved UPN (email) for the signed-in user. Empty string when unknown.
function getSavedUpn() {
  return readSetting(UPN_KEY);
}

function clearIdentity() {
  try {
    const db = openDb();
    db.prepare('DELETE FROM app_settings WHERE key IN (?, ?)').run(NAME_KEY, UPN_KEY);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  saveIdentity,
  getSavedName,
  getSavedUpn,
  clearIdentity,
};
