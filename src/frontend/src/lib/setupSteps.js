// Guided-setup step definitions + live status checks. Shared by SetupTutorial (the checklist
// UI) and App (the sidebar Resume/Review button, which needs the done/total count). Kept UI-free
// (no icons) so it can be imported anywhere; the component maps an icon per step key.
//
// Each check returns { done: boolean, detail: string } — `detail` is a short live-status line
// shown under the step (e.g. "Ni Yao — Connected", "Model selected: gpt-5.6-sol", "3 of 8
// accounts"). Every check is defensive: any failure resolves to { done:false, detail:'…' } so a
// missing table / signed-out provider never throws.

import {
  entraStatus, modelProviderStatus, workiqStatus, getAccountRoster, dbQuery, m365IngestStatus,
} from '../electronBridge';
import { getMsxAutoSyncLog } from './msxAutoSync';

async function countRows(sql, params) {
  try { const r = await dbQuery(sql, params); return Number(r?.[0]?.n) || 0; } catch { return 0; }
}

function fmtWhen(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleString();
}

// Latest ISO timestamp among the inputs (nulls ignored), or null.
function latestIso(...isos) {
  let best = null;
  for (const iso of isos) {
    if (!iso) continue;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) continue;
    if (!best || t > new Date(best).getTime()) best = iso;
  }
  return best;
}

// Each step: key, title, desc, target (section = User Home deep-link, or path = page nav),
// and check() → { done, detail }.
export const SETUP_STEPS = [
  {
    key: 'auth', section: 'auth',
    title: 'Sign in with Microsoft',
    desc: 'Connects SE Assist to MSX (Dynamics) and Microsoft Graph so it can read your opportunities, milestones and org.',
    check: async () => {
      try {
        const s = await entraStatus();
        const who = s?.displayName || s?.userName || '';
        if (s?.signedIn) return { done: true, detail: who ? `${who} — Connected` : 'Connected' };
        return { done: false, detail: who ? `${who} — Not connected` : 'Not connected' };
      } catch { return { done: false, detail: 'Not connected' }; }
    },
  },
  {
    key: 'model', section: 'model',
    title: 'Connect an AI model',
    desc: 'Sign in with GitHub Copilot (or configure Foundry) to power meeting briefs, transcript summaries and workload suggestions.',
    check: async () => {
      try {
        const m = await modelProviderStatus();
        const model = m?.copilot?.model || m?.deployment || m?.model || '';
        // `active` is the provider id (e.g. 'github-copilot') when a model provider is live —
        // mirror Settings' own badge, which keys off exactly this rather than GitHub sign-in.
        if (m?.active) return { done: true, detail: model ? `Model selected: ${model}` : 'Model connected' };
        return { done: false, detail: 'No model connected' };
      } catch { return { done: false, detail: 'No model connected' }; }
    },
  },
  {
    key: 'wiqauth', section: 'wiqauth',
    title: 'Connect Microsoft 365 Copilot',
    desc: 'Grants read access to your Outlook mail, calendar and Teams chats — the activity SE Assist turns into customer insight.',
    check: async () => {
      try {
        const w = await workiqStatus();
        const acct = w?.account || w?.knownAccount || '';
        if (w?.connected) return { done: true, detail: acct ? `WorkIQ Connected (${acct})` : 'WorkIQ Connected' };
        return { done: false, detail: acct ? 'WorkIQ sign-in expired' : 'WorkIQ Not connected' };
      } catch { return { done: false, detail: 'WorkIQ Not connected' }; }
    },
  },
  {
    key: 'accounts', section: 'accounts',
    title: 'Add your sales accounts',
    desc: 'Tell SE Assist which customer accounts (TPIDs) are yours — paste them or use “Detect my accounts”.',
    check: async () => {
      try {
        const n = ((await getAccountRoster()).tpids || []).length;
        return { done: n > 0, detail: `${n} account${n === 1 ? '' : 's'} configured` };
      } catch { return { done: false, detail: '0 accounts configured' }; }
    },
  },
  {
    key: 'sync', section: 'sync',
    title: 'Sync from MSX (CRM)',
    desc: 'Pulls your accounts’ opportunities, milestones and HoK activities from Dynamics into the app.',
    check: async () => {
      const has = (await countRows('SELECT COUNT(*) AS n FROM active_customers')) > 0;
      let manual = null;
      try { manual = localStorage.getItem('se-assist:syncLastRun') || null; } catch { manual = null; }
      const auto = getMsxAutoSyncLog()?.at || null;
      const when = fmtWhen(latestIso(manual, auto));
      return { done: has, detail: when ? `Last run: ${when}` : (has ? 'Synced' : 'Never run') };
    },
  },
  {
    key: 'ingest', section: 'ingest',
    title: 'Pull your Outlook & Teams activity',
    desc: 'Ingests recent emails, meetings and chats so Customer Activity, the Action Center and the meeting tools have data.',
    check: async () => {
      const has = (await countRows(
        'SELECT ((SELECT COUNT(*) FROM active_emails) + (SELECT COUNT(*) FROM active_meetings) + (SELECT COUNT(*) FROM active_teams_chats)) AS n',
      )) > 0;
      let st = null;
      try { st = await m365IngestStatus(); } catch { st = null; }
      const when = fmtWhen(latestIso(st?.lastRunAt, st?.autoIngestLog?.at));
      return { done: has, detail: when ? `Last run: ${when}` : (has ? 'Pulled' : 'Never run') };
    },
  },
  {
    key: 'ssp', section: 'sspConfig',
    title: 'Configure SSPs for your accounts',
    desc: 'Set each account’s Cloud & AI Specialist (SSP) in the SSP Configuration section of User Home. This groups activity and milestones by SSP and powers the “Ask the SSP in Teams” action on meetings.',
    check: async () => {
      let tpids = [];
      try { tpids = (await getAccountRoster()).tpids || []; } catch { tpids = []; }
      const y = tpids.length;
      let x = 0;
      if (y > 0) {
        const ph = tpids.map(() => '?').join(',');
        x = await countRows(
          `SELECT COUNT(DISTINCT tpid) AS n FROM active_customer_account_team_roles
             WHERE role = 'Cloud and AI Specialist' AND person_email IS NOT NULL AND TRIM(person_email) <> ''
               AND tpid IN (${ph})`,
          tpids,
        );
      }
      return { done: x > 0, detail: `SSP configured for ${x} of ${y} account${y === 1 ? '' : 's'}` };
    },
  },
];

// Run every step's check; returns { results: {key: {done, detail}}, done, total }.
export async function runSetupChecks() {
  const entries = await Promise.all(
    SETUP_STEPS.map(async (s) => {
      try { return [s.key, await s.check()]; } catch { return [s.key, { done: false, detail: '' }]; }
    }),
  );
  const results = Object.fromEntries(entries);
  const done = SETUP_STEPS.reduce((n, s) => n + (results[s.key]?.done ? 1 : 0), 0);
  return { results, done, total: SETUP_STEPS.length };
}
