/**
 * seismic-ipc.js — IPC bridge for the Seismic (DocCenter) content integration.
 * Exposes status / sign-in / sign-out / search to the renderer.
 */
const { ipcMain } = require('electron');
const seismic = require('./services/seismic-service');

// Only allow calls from the app's own renderer (file:// or localhost dev origins).
function isAllowedSender(event) {
  const url = event?.senderFrame?.url || '';
  return url.startsWith('file://') || url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:');
}

function registerSeismicIpc() {
  ipcMain.handle('seismic-status', async (event) => {
    if (!isAllowedSender(event)) return { signedIn: false };
    try { return await seismic.getStatus(); } catch (err) { return { signedIn: false, error: err.message }; }
  });

  ipcMain.handle('seismic-sign-in', async (event) => {
    if (!isAllowedSender(event)) return { signedIn: false, error: 'Unauthorized.' };
    try { return await seismic.signIn(); } catch (err) { return { signedIn: false, error: err.message }; }
  });

  ipcMain.handle('seismic-sign-out', async (event) => {
    if (!isAllowedSender(event)) return { signedIn: false, error: 'Unauthorized.' };
    try { return await seismic.signOut(); } catch (err) { return { signedIn: false, error: err.message }; }
  });

  ipcMain.handle('seismic-search', async (event, payload = {}) => {
    if (!isAllowedSender(event)) return { ok: false, error: 'Unauthorized.' };
    const term = String(payload.term || '').trim();
    const pageSize = Math.max(1, Math.min(Number(payload.pageSize) || 20, 50));
    try {
      return await seismic.search(term, { pageSize, interactive: Boolean(payload.interactive) });
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  console.log('[seismic-ipc] IPC handlers registered');
}

module.exports = { registerSeismicIpc };
