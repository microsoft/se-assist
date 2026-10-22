const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { toOutlookWebReaderLink } = require("./services/outlook-link");

// Shared contracts (the curated customer/TPID roster). Resolve from source in dev,
// or from the packaged extraResources copy in production.
let sharedContracts;
try {
  sharedContracts = require("../shared/customerWorkspace");
} catch {
  sharedContracts = require(path.join(process.resourcesPath, "shared", "customerWorkspace"));
}
const { CUSTOMER_PROFILE_TPIDS } = sharedContracts;
const { getEffectiveTpids } = require("./account-roster");

// MSX/Dynamics constants (mirrored from msx-ipc.js) used by the settings bridge.
const DEFAULT_CRM_URL = "https://microsoftsales.crm.dynamics.com";
const DEFAULT_TENANT_ID = "72f988bf-86f1-41af-91ab-2d7cd011db47";

try {
  if (typeof process.loadEnvFile === "function") {
    // Desktop-specific overrides win; the repo-root .env fills in shared config
    // (e.g. AI Foundry credentials). loadEnvFile does not overwrite already-set vars.
    process.loadEnvFile(path.join(__dirname, ".env"));
    try {
      process.loadEnvFile(path.join(__dirname, "..", ".env"));
    } catch {
      // No repo-root .env (e.g. packaged build); ignore.
    }
  }
} catch {
  // No .env present (e.g. packaged build); rely on the process environment.
}

let mainWindow = null;
let tray = null;
let isQuitting = false;

// ── Tray ────────────────────────────────────────────────────────────
function createTray() {
  // Use the real multi-size app icon (Windows Tray picks the 16px entry) instead of an inline
  // placeholder, so the tray matches the taskbar / window / file icon.
  const icon = nativeImage.createFromPath(path.join(__dirname, "icon.ico"));
  tray = new Tray(icon);
  tray.setToolTip("SE Assist");
  const contextMenu = Menu.buildFromTemplate([
    { label: "Open SE Assist", click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: "separator" },
    { label: "Quit", click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => { mainWindow.show(); mainWindow.focus(); });
}

// ── Shell window with tab UI ────────────────────────────────────────
function getSeAssistDistPath() {
  const distPath = path.join(__dirname, "..", "src", "frontend", "dist", "index.html");
  return `file://${distPath.replace(/\\/g, "/")}`;
}

function getSeAssistPreloadPath() {
  return path.join(__dirname, "se-assist-preload.js");
}

function getWindowIconPath() {
  const icoPath = path.join(__dirname, "icon.ico");
  if (fs.existsSync(icoPath)) return icoPath;
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 560,
    autoHideMenuBar: true,
    title: "SE Assist",
    icon: getWindowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "shell-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  // Build shell HTML with correct URLs injected
  const shellHtml = path.join(__dirname, "shell.html");
  let html = fs.readFileSync(shellHtml, "utf8");
  html = html.replace("__SE_ASSIST_URL__", getSeAssistDistPath());
  html = html.replace("__SE_ASSIST_PRELOAD__", `file://${getSeAssistPreloadPath().replace(/\\/g, "/")}`);

  // Write temp file and load it (webview needs file:// or http:// origin)
  const tmpShell = path.join(app.getPath("temp"), "se-assist-shell.html");
  fs.writeFileSync(tmpShell, html, "utf8");
  mainWindow.loadFile(tmpShell);

  mainWindow.on("close", (e) => {
    if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
}

// ── MSX IPC setup ───────────────────────────────────────────────────
let msxIpc;
try {
  msxIpc = require("./msx-ipc");
} catch (err) {
  console.warn("[MSX] msx-ipc not available:", err.message);
}

// ── SQLite IPC setup ────────────────────────────────────────────────
let sqliteIpc;
try {
  sqliteIpc = require("./sqlite-ipc");
} catch (err) {
  console.warn("[SQLite] sqlite-ipc not available:", err.message);
}

let appIpc;
try {
  appIpc = require("./app-ipc");
} catch (err) {
  console.warn("[App IPC] app-ipc not available:", err.message);
}

let seismicIpc;
try {
  seismicIpc = require("./seismic-ipc");
} catch (err) {
  console.warn("[Seismic] seismic-ipc not available:", err.message);
}

let acrIpc;
try {
  acrIpc = require("./acr-ipc");
} catch (err) {
  console.warn("[ACR] acr-ipc not available:", err.message);
}

let capacityIpc;
try {
  capacityIpc = require("./capacity-ipc");
} catch (err) {
  console.warn("[Capacity] capacity-ipc not available:", err.message);
}

let foundryUsageIpc;
try {
  foundryUsageIpc = require("./foundry-usage-ipc");
} catch (err) {
  console.warn("[Foundry usage] foundry-usage-ipc not available:", err.message);
}

// ── MSX Settings bridge IPC ─────────────────────────────────────────
function registerMsxSettingsBridge() {
  // SE Assist reads MSX settings (CRM base URL, tenant, and the account/TPID roster)
  // via this handler. The accounts come from the effective roster — the user's custom
  // list (tpid_config) if set, otherwise the curated CUSTOMER_PROFILE_TPIDS defaults.
  // The CRM URL/tenant are fixed Dynamics constants.
  ipcMain.handle('se-get-msx-settings', async () => {
    const tpids = getEffectiveTpids(sqliteIpc.openDb());
    return {
      accounts: tpids.map((tpid) => ({ tpid, id: tpid })),
      crmUrl: DEFAULT_CRM_URL,
      tenantId: DEFAULT_TENANT_ID,
    };
  });

  // App version (live from package.json via Electron) — surfaced in Settings → About.
  ipcMain.handle('se-app-version', () => app.getVersion());

  ipcMain.handle('se-open-external', (_event, url) => {
    if (typeof url !== 'string' || !URL.canParse(url) || new URL(url).protocol !== 'https:') {
      throw new Error('Cannot open this link: a valid HTTPS URL is required.');
    }
    return shell.openExternal(toOutlookWebReaderLink(url));
  });

  // Open a generated HTML artifact in the default browser. Sandboxed to the app's
  // userData/generated directory so the renderer can't open arbitrary local files.
  ipcMain.handle('se-open-file', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'Invalid path' };
    const generatedDir = path.resolve(path.join(app.getPath('userData'), 'generated'));
    const resolved = path.resolve(filePath);
    if (resolved !== generatedDir && !resolved.startsWith(generatedDir + path.sep)) {
      return { ok: false, error: 'Path not allowed' };
    }
    if (!fs.existsSync(resolved)) return { ok: false, error: 'File not found' };
    const err = await shell.openPath(resolved);
    return err ? { ok: false, error: err } : { ok: true };
  });

  // Fetch external URL for webview (bypasses CSP)
  ipcMain.handle('se-fetch-external', async (_event, url) => {
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      return { ok: false, error: 'Invalid URL' };
    }
    try {
      const resp = await require('electron').net.fetch(url);
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      const text = await resp.text();
      return { ok: true, data: text };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

// ── Single instance lock ────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
console.log('[main] Single instance lock:', gotLock);
if (!gotLock) {
  console.log('[main] Another instance running, quitting');
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    console.log('[main] App ready');
    try {
      // Initialize SQLite database
      if (sqliteIpc) {
        sqliteIpc.registerSqliteIpc();
        console.log('[main] SQLite initialized');
      }

      if (appIpc) {
        appIpc.registerAppIpc();
        console.log('[main] App IPC initialized');

        // Background customer-data ingestion scheduler: every 5 minutes, run an
        // incremental WorkIQ pull when the user has enabled auto-ingest and the
        // configured interval has elapsed. No-op otherwise.
        if (appIpc.maybeRunScheduledIngestion) {
          const ingestTimer = setInterval(() => {
            appIpc.maybeRunScheduledIngestion();
          }, 5 * 60 * 1000);
          if (ingestTimer.unref) ingestTimer.unref();
        }

        // WorkIQ's M365 Copilot token expires on its own, silently starving every
        // customer-data sync. Watch it and re-acquire in the background (only ever
        // when an account is already cached, so this never pops a sign-in window).
        if (appIpc.maybeReconnectWorkIq) {
          const workiqTimer = setInterval(() => {
            appIpc.maybeReconnectWorkIq();
          }, 10 * 60 * 1000);
          if (workiqTimer.unref) workiqTimer.unref();
          // Also heal shortly after launch, so a token that died overnight is back
          // before the user reaches for anything that needs it.
          const warmup = setTimeout(() => appIpc.maybeReconnectWorkIq(), 45 * 1000);
          if (warmup.unref) warmup.unref();
        }
      }

      // Initialize MSX services (must be after app.ready for app.getPath)
      if (msxIpc) {
        msxIpc.initMsxServices();
        msxIpc.registerMsxIpcHandlers();
        console.log('[main] MSX IPC initialized');

        // If a prior M365 sign-in is still cached, refresh the locally-saved name/UPN
        // in SQLite so an already-signed-in user (or one now offline) resolves "you"
        // without needing to sign in again this session.
        if (msxIpc.persistSignedInIdentity) {
          msxIpc.persistSignedInIdentity().catch(() => { /* best-effort */ });
        }
      }

      // Register MSX settings bridge for SE Assist
      registerMsxSettingsBridge();
      console.log('[main] MSX settings bridge registered');

      if (seismicIpc) {
        seismicIpc.registerSeismicIpc();
        console.log('[main] Seismic IPC initialized');
      }

      if (acrIpc) {
        acrIpc.registerAcrIpc();
        console.log('[main] ACR IPC initialized');
      }

      if (capacityIpc) {
        capacityIpc.registerCapacityIpc();
        console.log('[main] AI capacity IPC initialized');
      }

      if (foundryUsageIpc) {
        foundryUsageIpc.registerFoundryUsageIpc();
        console.log('[main] Foundry usage IPC initialized');
      }

      createTray();
      createWindow();

      // Intercept window.open from webviews → open in external browser
      mainWindow.webContents.on('did-attach-webview', (_event, webContents) => {
        webContents.setWindowOpenHandler(({ url }) => {
          if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
            shell.openExternal(url);
          }
          return { action: 'deny' };
        });
      });

      console.log('[main] Window created');
    } catch (err) {
      console.error('[main] Startup error:', err);
      dialog.showErrorBox("SE Assist", `Failed to start: ${err.message}`);
      app.quit();
    }
  });
}

app.on("before-quit", () => {
  isQuitting = true;
  // Stop any in-flight ingest pipeline FIRST, before closing the DB. These are Python
  // child processes with their own connection to seassist.db; if left running they orphan
  // and keep writing after the app exits (and can trip a fast relaunch with a locked DB).
  // SQLite's WAL makes the kill safe — an interrupted write simply rolls back on next open.
  try {
    const stopped = require("./services/m365-ingest").stopActiveIngestChildren();
    if (stopped) console.log(`[main] stopped ${stopped} in-flight ingest process(es)`);
  } catch (err) {
    console.warn('[main] could not stop ingest processes:', err?.message || err);
  }
  if (sqliteIpc) sqliteIpc.closeSqliteDb();
  // Shut the WorkIQ MCP server down with us. It is a long-lived child process, and
  // leaving it behind is not harmless: an orphan from a previous session keeps hold of
  // the auth state, and the next run then reports "not connected" and cannot sign in
  // until the stale process is killed (observed as a workiq.exe alive for ~19 hours,
  // which blocked every reconnect until removed).
  try {
    const { getWorkIqClient } = require("./services/workiq-client");
    getWorkIqClient({ log: () => {} }).stop();
    console.log('[main] WorkIQ MCP process stopped');
  } catch (err) {
    console.warn('[main] could not stop the WorkIQ process:', err?.message || err);
  }
});

app.on("window-all-closed", () => {
  // Don't quit — tray keeps app alive
});
