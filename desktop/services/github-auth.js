/**
 * github-auth.js — in-app GitHub sign-in via OAuth device flow.
 *
 * Uses the "GitHub Copilot" app client ID so the resulting token can be exchanged for
 * a Copilot bearer token (see copilot-provider.js) to call api.githubcopilot.com — the
 * same path the GitHub Copilot CLI/editors use. The token is stored encrypted via
 * safeStorage so the sign-in survives restarts.
 *
 * Flow:
 *   startDeviceLogin()  -> { flowId, user_code, verification_uri, ... } and opens the
 *                          verification page in the browser.
 *   waitForDeviceLogin(flowId) -> polls until the user authorizes, then stores the token.
 */
const { shell } = require('electron');
const secureStore = require('./secure-store');

// Public client ID of the "GitHub Copilot" GitHub App. Tokens minted for this app are
// accepted by the Copilot token-exchange endpoint. Override via SEASSIST_GH_CLIENT_ID.
const DEFAULT_CLIENT_ID = process.env.SEASSIST_GH_CLIENT_ID || 'Iv1.b507a08c87ecfe98';
const DEFAULT_SCOPE = process.env.SEASSIST_GH_SCOPE || 'read:user';
const TOKEN_KEY = 'github-token';

const UA = 'SE-Assist/1.0';

let token = null;
let login = null;
let loaded = false;
const flows = new Map();

function load() {
  if (loaded) return;
  loaded = true;
  const saved = secureStore.readJson(TOKEN_KEY);
  if (saved && saved.access_token) {
    token = saved.access_token;
    login = saved.login || null;
  }
}

async function fetchLogin(accessToken) {
  try {
    const resp = await fetch('https://api.github.com/user', {
      headers: { Authorization: `token ${accessToken}`, 'User-Agent': UA, Accept: 'application/vnd.github+json' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.login || null;
  } catch {
    return null;
  }
}

async function startDeviceLogin() {
  const resp = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: new URLSearchParams({ client_id: DEFAULT_CLIENT_ID, scope: DEFAULT_SCOPE }).toString(),
  });
  const data = await resp.json();
  if (!resp.ok || !data.device_code) {
    throw new Error(`GitHub device login failed: ${data.error_description || resp.status}`);
  }
  const flowId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  flows.set(flowId, {
    deviceCode: data.device_code,
    interval: Number(data.interval) || 5,
    expiresAt: Date.now() + (Number(data.expires_in) || 900) * 1000,
  });
  // Open the verification page for convenience; the renderer also shows the code.
  if (data.verification_uri) shell.openExternal(data.verification_uri).catch(() => {});
  return {
    flowId,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    expires_in: data.expires_in,
    interval: data.interval,
  };
}

async function waitForDeviceLogin(flowId) {
  const flow = flows.get(flowId);
  if (!flow) return { signedIn: false, error: 'Unknown or expired sign-in attempt. Start again.' };
  let interval = flow.interval;

  while (Date.now() < flow.expiresAt) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    let data;
    try {
      const resp = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: new URLSearchParams({
          client_id: DEFAULT_CLIENT_ID,
          device_code: flow.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }).toString(),
      });
      data = await resp.json();
    } catch (e) {
      continue; // transient network error — keep polling
    }

    if (data.access_token) {
      flows.delete(flowId);
      token = data.access_token;
      login = await fetchLogin(token);
      loaded = true;
      secureStore.writeJson(TOKEN_KEY, { access_token: token, login, scope: data.scope || DEFAULT_SCOPE });
      return { signedIn: true, login };
    }
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { interval += Number(data.interval) || 5; continue; }
    flows.delete(flowId);
    return { signedIn: false, error: data.error_description || data.error || 'Authorization failed.' };
  }
  flows.delete(flowId);
  return { signedIn: false, error: 'Sign-in timed out. Please try again.' };
}

function getToken() {
  load();
  return token;
}

function isSignedIn() {
  load();
  return Boolean(token);
}

function getStatus() {
  load();
  return { signedIn: Boolean(token), login };
}

function signOut() {
  token = null;
  login = null;
  secureStore.remove(TOKEN_KEY);
  return { signedIn: false };
}

module.exports = {
  startDeviceLogin,
  waitForDeviceLogin,
  getToken,
  isSignedIn,
  getStatus,
  signOut,
  CLIENT_ID: DEFAULT_CLIENT_ID,
};
