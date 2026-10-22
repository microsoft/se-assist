/**
 * seismic-service.js — pulls Microsoft Seismic (DocCenter) sales-enablement content
 * into SE Assist, using Seismic's own OIDC auth domain federated to Microsoft identity.
 *
 * How it works (the "official auth path"):
 *   Seismic gates its SPA behind OIDC (auth.seismic.com/tenants/microsoft) which federates
 *   to Microsoft Entra via SAML. The resulting access token lives in the page's
 *   sessionStorage under the oidc-client key. Rather than reimplement that flow (and hold
 *   raw tokens), we run a HIDDEN Electron BrowserWindow on a PERSISTENT partition that
 *   loads the real DocCenter app. Microsoft SSO completes silently when the user has a
 *   session; otherwise the window is shown once for interactive sign-in. All API calls are
 *   executed INSIDE that window (executeJavaScript), so they carry the live OIDC token
 *   automatically and the token never leaves the browser context. The persistent partition
 *   keeps the session across app restarts, and the live page auto-renews the token.
 *
 * This is the internal DocCenter API (not Seismic's officially published API), chosen for
 * speed; it may change without notice. Hosts are overridable via env for resilience.
 */
const { BrowserWindow, session } = require('electron');

const CLIENT_ID = process.env.SEISMIC_CLIENT_ID || '0188a34d-cdbd-4208-8ebc-d0567984915e';
const TENANT = process.env.SEISMIC_TENANT || 'microsoft';
const DOCCENTER_URL = process.env.SEISMIC_DOCCENTER_URL || `https://${TENANT}.seismic.com/apps/doccenter`;
const SEARCH_HOST = process.env.SEISMIC_SEARCH_HOST || 'https://search-edge-prod-az-eastus-dracorex.seismic.com';
const PARTITION = 'persist:seismic';
const OIDC_KEY = `oidc.user:https://auth.seismic.com/tenants/${TENANT}/:${CLIENT_ID}`;

const READY_POLL_MS = 1000;
const SILENT_READY_TIMEOUT_MS = 45_000;   // silent SSO round-trip
const INTERACTIVE_READY_TIMEOUT_MS = 5 * 60_000;

let win = null;
let creating = null;

function isDestroyed() {
  return !win || win.isDestroyed() || win.webContents.isDestroyed();
}

function createWindow() {
  if (creating) return creating;
  // Reuse the existing live window — the OIDC token lives in its sessionStorage, so a new
  // window would start unauthenticated and force a full SSO round-trip on every call.
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) return Promise.resolve(win);
  creating = new Promise((resolve) => {
    const w = new BrowserWindow({
      width: 1100,
      height: 800,
      show: false,
      title: 'Seismic sign-in',
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Keep the window out of the taskbar until we deliberately show it for sign-in.
    w.setSkipTaskbar(true);
    w.on('closed', () => { if (win === w) win = null; });
    win = w;
    resolve(w);
  }).finally(() => { creating = null; });
  return creating;
}

// Read the OIDC access token (+ decoded sub/username/expiry) from the page's sessionStorage.
async function readAuthFromWindow() {
  if (isDestroyed()) return { signedIn: false };
  try {
    return await win.webContents.executeJavaScript(`(() => {
      try {
        const raw = sessionStorage.getItem(${JSON.stringify(OIDC_KEY)});
        if (!raw) return { signedIn: false };
        const u = JSON.parse(raw);
        const token = u.access_token;
        if (!token) return { signedIn: false };
        let sub = null, name = null, exp = null;
        try {
          const p = JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
          sub = p.sub || p.id || null; exp = p.exp || null;
        } catch {}
        try {
          const info = JSON.parse(sessionStorage.getItem('seismicUserInfo') || '{}');
          name = info.DisplayName || info.Email || info.UserName || null;
        } catch {}
        const expired = exp ? (Date.now()/1000 > exp) : false;
        return { signedIn: !expired, sub, name, exp, expired };
      } catch (e) { return { signedIn: false, error: String(e && e.message || e) }; }
    })()`, true);
  } catch {
    return { signedIn: false };
  }
}

// Ensure the window exists, DocCenter is loaded, and a valid token is present. When
// interactive, show the window and wait longer so the user can complete sign-in.
async function ensureAuthed({ interactive = false } = {}) {
  await createWindow();

  // If we already have a live token, we're done.
  let auth = await readAuthFromWindow();
  if (auth.signedIn) return auth;

  // (Re)load the DocCenter app to drive the OIDC/SSO flow.
  const url = win.webContents.getURL();
  if (!url || !url.includes('seismic.com')) {
    win.loadURL(DOCCENTER_URL).catch(() => {});
  }

  if (interactive) {
    win.show();
    win.setSkipTaskbar(false);
  }

  const deadline = Date.now() + (interactive ? INTERACTIVE_READY_TIMEOUT_MS : SILENT_READY_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
    if (isDestroyed()) {
      // In interactive mode a destroyed window means the user closed the sign-in
      // dialog — honor that as a cancel instead of silently respawning a hidden window
      // (which could never complete the login and would poll until the 5-min timeout).
      if (interactive) return { signedIn: false, cancelled: true };
      await createWindow();
      win.loadURL(DOCCENTER_URL).catch(() => {});
      continue;
    }
    auth = await readAuthFromWindow();
    if (auth.signedIn) {
      win.hide();
      win.setSkipTaskbar(true);
      return auth;
    }
  }
  if (interactive && !isDestroyed()) { win.hide(); win.setSkipTaskbar(true); }
  return { signedIn: false };
}

function normalizeDoc(d) {
  const loc = Array.isArray(d.Locations) ? d.Locations[0] : null;
  return {
    id: d.ContentId,
    name: d.Name || '(untitled)',
    format: d.Format || d.NativeFormat || '',
    description: (d.Description || '').slice(0, 400),
    url: loc?.UrlLink || null,
    path: loc?.FullPathName || null,
    profile: loc?.ProfileVersionName || null,
    updated: d.LastUpdatedTime || d.PublishTime || null,
    rating: typeof d.Rating === 'number' ? Math.round(d.Rating * 10) / 10 : null,
    pages: d.Pages || null,
  };
}

// Full-text search DocCenter for `term`, returning normalized documents. Runs the fetch
// inside the authenticated window so it carries the live OIDC token.
async function search(term, { pageSize = 20, interactive = false } = {}) {
  const query = String(term || '').trim();
  if (!query) return { ok: true, authed: true, total: 0, docs: [] };

  const auth = await ensureAuthed({ interactive });
  if (!auth.signedIn) {
    return { ok: false, authed: false, error: 'Not signed in to Seismic.' };
  }

  const runSearch = async () => win.webContents.executeJavaScript(`(async () => {
    const raw = sessionStorage.getItem(${JSON.stringify(OIDC_KEY)});
    if (!raw) return { authed: false };
    const u = JSON.parse(raw); const token = u.access_token;
    if (!token) return { authed: false };
    let sub = null;
    try { sub = JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).sub; } catch {}
    const url = ${JSON.stringify(SEARCH_HOST)} + '/api/services/search/v1/results?userId=' + encodeURIComponent(sub || '') + '&languages=en-us&ranking=';
    const body = {
      SearchTerm: ${JSON.stringify(query)},
      Page: { PageIndex: 0, PageSize: ${Number(pageSize) || 20} },
      Sort: 'Relevance',
      Filter: { AppType: 'DocCenter', ExcludedAppTypes: ['ControlCenter'] },
      DynamicFilter: { operator: 'and', conditions: [] },
      HighlightPreTag: '', HighlightPostTag: '',
      IncludeAppTypeFacet: false, DisableDidYouMean: false,
      Options: { TrackQueryEvents: false, IncludeStagingProfiles: true, IncludeLearning: false },
      EnableMultiFacetSearch: true, selectedPropertyValue: []
    };
    const r = await fetch(url, { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body) });
    const status = r.status;
    let data = null; try { data = await r.json(); } catch {}
    const sr = data && data.ServiceResult;
    return { authed: true, status, total: sr && sr.TotalCount, docs: (sr && sr.Documents || []) };
  })()`, true);

  let res;
  try {
    res = await runSearch();
  } catch (err) {
    return { ok: false, authed: true, error: err.message || String(err) };
  }

  // Token may have expired mid-flight — reload once and retry.
  if (res && (res.status === 401 || res.authed === false)) {
    win.loadURL(DOCCENTER_URL).catch(() => {});
    const again = await ensureAuthed({ interactive: false });
    if (again.signedIn) {
      try { res = await runSearch(); } catch (err) { return { ok: false, authed: true, error: err.message }; }
    }
  }

  if (!res || res.authed === false) return { ok: false, authed: false, error: 'Seismic session unavailable.' };
  if (res.status && res.status >= 400) return { ok: false, authed: true, error: `Seismic search failed (HTTP ${res.status}).` };

  const docs = (res.docs || []).map(normalizeDoc).filter((d) => d.url);
  return { ok: true, authed: true, total: res.total || docs.length, docs };
}

async function getStatus() {
  if (isDestroyed()) return { signedIn: false };
  const auth = await readAuthFromWindow();
  return { signedIn: Boolean(auth.signedIn), userName: auth.name || null };
}

async function signIn() {
  const auth = await ensureAuthed({ interactive: true });
  return { signedIn: Boolean(auth.signedIn), userName: auth.name || null, error: auth.signedIn ? null : 'Sign-in did not complete.' };
}

async function signOut() {
  try {
    const ses = session.fromPartition(PARTITION);
    await ses.clearStorageData();
  } catch { /* ignore */ }
  if (!isDestroyed()) { try { win.destroy(); } catch { /* ignore */ } }
  win = null;
  return { signedIn: false };
}

module.exports = { search, getStatus, signIn, signOut, ensureAuthed };
