'use strict';

const { app, ipcMain } = require('electron');
const path = require('path');
const { fileURLToPath } = require('url');
const { getAccessTokenForResource } = require('./msx-ipc');
const { getEffectiveTpids, assertActiveTpids, withRosterWork } = require('./account-roster');
const { openDb } = require('./sqlite-ipc');
const { createCapacityService, POWERBI_RESOURCE } = require('./services/capacity-query');

let capacity = null;

function getCapacityService() {
  if (capacity) return capacity;
  capacity = createCapacityService({
    getPowerBiToken: async () => {
      const result = await getAccessTokenForResource(POWERBI_RESOURCE);
      return result?.token || null;
    },
  });
  return capacity;
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

function registerCapacityIpc() {
  const register = (channel, handler) => ipcMain.handle(channel, (event, payload) => withRosterWork(channel, () => handler(event, payload)));
  register('capacity-portfolio', async (event, payload = {}) => {
    if (!isAllowedSender(event)) return { ok: false, error: 'Unauthorized.' };
    try {
      const data = await getCapacityService().getPortfolioCapacity({
        tpids: assertActiveTpids(openDb(), getEffectiveTpids(openDb())),
        force: Boolean(payload.force),
      });
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, error: err.message || String(err), code: err.code || null };
    }
  });

  register('capacity-customer', async (event, payload = {}) => {
    if (!isAllowedSender(event)) return { ok: false, error: 'Unauthorized.' };
    try {
      const tpid = String(payload.tpid || '').trim();
      if (!getEffectiveTpids(openDb()).includes(tpid)) {
        return { ok: false, error: 'Customer is not in the configured account roster.' };
      }
      const data = await getCapacityService().getCustomerCapacity({
        tpid,
        force: Boolean(payload.force),
        includeQuotas: payload.includeQuotas !== false,
      });
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, error: err.message || String(err), code: err.code || null };
    }
  });

  register('capacity-customer-subscriptions', async (event, payload = {}) => {
    if (!isAllowedSender(event)) return { ok: false, error: 'Unauthorized.' };
    try {
      const tpid = String(payload.tpid || '').trim();
      if (!getEffectiveTpids(openDb()).includes(tpid)) {
        return { ok: false, error: 'Customer is not in the configured account roster.' };
      }
      const data = await getCapacityService().getCustomerSubscriptions({
        tpid,
        force: Boolean(payload.force),
      });
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, error: err.message || String(err), code: err.code || null };
    }
  });
  console.log('[capacity-ipc] IPC handlers registered');
}

module.exports = { getCapacityService, registerCapacityIpc };
