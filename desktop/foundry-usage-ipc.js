'use strict';

const { app, ipcMain } = require('electron');
const path = require('path');
const { fileURLToPath } = require('url');
const { getEffectiveTpids, assertActiveTpids, assertActiveTpid, withRosterWork } = require('./account-roster');
const { getAccessTokenForResource } = require('./msx-ipc');
const { openDb } = require('./sqlite-ipc');
const {
  POWERBI_RESOURCE,
  createFoundryUsageService,
} = require('./services/foundry-usage');

let foundryUsage = null;

function getFoundryUsageService() {
  if (foundryUsage) return foundryUsage;
  foundryUsage = createFoundryUsageService({
    getPowerBiToken: async () => {
      const result = await getAccessTokenForResource(POWERBI_RESOURCE);
      if (!result?.token) {
        const error = new Error('Could not acquire a Power BI token. Sign in with Microsoft in User Home and ensure you are on corpnet/VPN.');
        error.code = 'NO_ACCOUNT';
        throw error;
      }
      return result.token;
    },
  });
  return foundryUsage;
}

function isAllowedSender(event) {
  const rawUrl = event?.senderFrame?.url || '';
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol === 'http:') {
    if (app.isPackaged) return false;
    return parsed.origin === 'http://localhost:5173'
      || parsed.origin === 'http://127.0.0.1:5173';
  }
  if (parsed.protocol !== 'file:' || parsed.hostname) return false;

  let senderPath;
  try {
    senderPath = path.resolve(fileURLToPath(parsed));
  } catch {
    return false;
  }
  const expectedPaths = [
    path.resolve(__dirname, '..', 'src', 'frontend', 'dist', 'index.html'),
    path.resolve(process.resourcesPath, 'src', 'frontend', 'dist', 'index.html'),
  ];
  return expectedPaths.some((expected) => (
    process.platform === 'win32'
      ? expected.toLowerCase() === senderPath.toLowerCase()
      : expected === senderPath
  ));
}

function registerFoundryUsageIpc() {
  ipcMain.handle('foundry-usage-portfolio', (event, payload = {}) => withRosterWork('Foundry usage portfolio', async () => {
    if (!isAllowedSender(event)) return { ok: false, error: 'Unauthorized.' };
    try {
      const data = await getFoundryUsageService().getPortfolio({
        tpids: assertActiveTpids(openDb(), getEffectiveTpids(openDb())),
        force: Boolean(payload.force),
      });
      return { ok: true, ...data };
    } catch (error) {
      return { ok: false, error: error.message || String(error), code: error.code || null };
    }
  }));

  ipcMain.handle('foundry-usage-customer', (event, payload = {}) => withRosterWork('Foundry usage customer', async () => {
    if (!isAllowedSender(event)) return { ok: false, error: 'Unauthorized.' };
    try {
      const tpid = assertActiveTpid(openDb(), String(payload.tpid || '').trim());
      const data = await getFoundryUsageService().getCustomer({
        tpid,
        force: Boolean(payload.force),
      });
      return { ok: true, ...data };
    } catch (error) {
      return { ok: false, error: error.message || String(error), code: error.code || null };
    }
  }));

  console.log('[foundry-usage-ipc] IPC handlers registered');
}

module.exports = { getFoundryUsageService, registerFoundryUsageIpc };
