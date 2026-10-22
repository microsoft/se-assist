// ── Customer intelligence loaders ───────────────────────────────────
// DB-backed readers that normalize Teams / email / meeting / account-team signal
// into stable shapes for the customer profile, comprehensive summary, and assistant
// features. Every loader takes the SQLite database as its first argument (dependency
// injection), so they are exercised directly in unit tests with a fake db. Source
// selection for Teams/email is config-driven via SE_ASSIST_TEAMS_SOURCE /
// SE_ASSIST_EMAIL_SOURCE. Extracted verbatim from app-ipc.js — no behavior changes.

const { safeParseJson } = require('./safe-json');

function emptyTeamsIntel(source = 'none') {
  return {
    source,
    available: false,
    chatCount: 0,
    messageCount: 0,
    lastActivity: null,
    profileMarkdown: '',
    participants: [],
    openQuestions: [],
    actionItems: [],
    links: [],
    recentChats: [],
    recentMessages: [],
  };
}

function resolveTeamsSourceMode(env = process.env) {
  const v = String(env.SE_ASSIST_TEAMS_SOURCE || 'auto').trim().toLowerCase();
  return ['cli', 'graph', 'none', 'auto'].includes(v) ? v : 'auto';
}

function cliTeamsHasData(database, tpid) {
  if (!tpid) return false;
  try {
    return Boolean(
      database.prepare('SELECT 1 FROM active_teams_chat_customer_links WHERE tpid = ? LIMIT 1').get(tpid),
    );
  } catch {
    return false;
  }
}

function graphTeamsHasData(database, profileId) {
  if (!profileId) return false;
  try {
    return Boolean(
      database
        .prepare('SELECT 1 FROM active_cached_customer_teams_refs WHERE profile_id = ? AND deleted_at IS NULL LIMIT 1')
        .get(profileId),
    );
  } catch {
    return false;
  }
}

// Source-aware entry point. Dispatches to the CLI or Graph reader, or returns empty.
function loadTeamsIntelligence(database, tpid, profileId = null) {
  const mode = resolveTeamsSourceMode();
  let useSource = mode;
  if (mode === 'auto') {
    if (cliTeamsHasData(database, tpid)) useSource = 'cli';
    else if (graphTeamsHasData(database, profileId)) useSource = 'graph';
    else useSource = 'none';
  }
  if (useSource === 'cli') return loadTeamsIntelligenceFromCli(database, tpid);
  if (useSource === 'graph') return loadTeamsIntelligenceFromGraph(database, profileId);
  return emptyTeamsIntel('none');
}

// Graph (org) source: normalize cached_customer_teams_refs into the shared shape.
// Graph refs have no body text, so open questions / action items are not extracted.
function loadTeamsIntelligenceFromGraph(database, profileId) {
  if (!profileId) return emptyTeamsIntel('graph');
  let refs = [];
  try {
    refs = database
      .prepare(
        `SELECT chat_id, message_id, created_at, sender_name, mention_summary
         FROM active_cached_customer_teams_refs
         WHERE profile_id = ? AND deleted_at IS NULL
         ORDER BY (created_at IS NULL), created_at DESC
         LIMIT 50`,
      )
      .all(profileId);
  } catch {
    return emptyTeamsIntel('graph');
  }
  if (!refs.length) return emptyTeamsIntel('graph');

  const counts = new Map();
  for (const r of refs) {
    const name = r.sender_name || '';
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  const participants = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  const chatMap = new Map();
  for (const r of refs) {
    if (!r.chat_id) continue;
    const cur = chatMap.get(r.chat_id);
    if (!cur || String(r.created_at || '') > String(cur.last_message_at || '')) {
      chatMap.set(r.chat_id, {
        topic: null,
        chat_type: 'graph',
        has_unread: 0,
        last_message_at: r.created_at,
        last_message_from: r.sender_name,
      });
    }
  }
  const recentChats = [...chatMap.values()]
    .sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')))
    .slice(0, 15);
  const recentMessages = refs.slice(0, 12).map((r) => ({
    sender_name: r.sender_name,
    sent_at: r.created_at,
    excerpt: String(r.mention_summary || '').slice(0, 280),
    topic: null,
  }));

  return {
    source: 'graph',
    available: true,
    chatCount: chatMap.size,
    messageCount: refs.length,
    lastActivity: refs[0]?.created_at || null,
    profileMarkdown: '',
    participants,
    openQuestions: [],
    actionItems: [],
    links: [],
    recentChats,
    recentMessages,
  };
}

// CLI (personal) source: rich teams_* tables populated by the tools/teams Python CLI.
function loadTeamsIntelligenceFromCli(database, tpid, msgLimit = 12) {
  const empty = {
    source: 'cli',
    available: false,
    chatCount: 0,
    messageCount: 0,
    lastActivity: null,
    profileMarkdown: '',
    participants: [],
    openQuestions: [],
    actionItems: [],
    links: [],
    recentChats: [],
    recentMessages: [],
  };
  if (!tpid) return empty;
  let profileRow = null;
  try {
    profileRow = database
      .prepare('SELECT chat_count, message_count, last_activity_at, facts_json, profile_markdown FROM active_teams_customer_profile WHERE tpid = ?')
      .get(tpid);
  } catch {
    return empty;
  }
  const facts = safeParseJson(profileRow?.facts_json, {}) || {};
  let recentChats = [];
  let recentMessages = [];
  try {
    recentChats = database
      .prepare(
        `SELECT c.topic, c.chat_type, c.has_unread, c.last_message_at, c.last_message_from
         FROM active_teams_chat_customer_links l
         JOIN active_teams_chats c ON c.chat_id = l.chat_id
         WHERE l.tpid = ? AND l.match_method <> 'ai-rejected'
         ORDER BY (c.last_message_at IS NULL), c.last_message_at DESC
         LIMIT 15`,
      )
      .all(tpid);
    recentMessages = database
      .prepare(
        `SELECT m.message_id, m.chat_id, m.sender_name, m.sent_at, substr(m.body_text, 1, 280) AS excerpt, c.topic
         FROM active_teams_chat_messages m
         JOIN active_teams_chat_customer_links l ON l.chat_id = m.chat_id
         JOIN active_teams_chats c ON c.chat_id = m.chat_id
         WHERE l.tpid = ? AND l.match_method <> 'ai-rejected'
           AND m.body_text IS NOT NULL AND m.body_text != ''
         ORDER BY (m.sent_at IS NULL), m.sent_at DESC
         LIMIT ${Math.max(1, Math.min(50, Number(msgLimit) || 12))}`,
      )
      .all(tpid);
  } catch {
    /* teams tables may be absent in older databases */
  }
  return {
    source: 'cli',
    available: Boolean(profileRow) || recentChats.length > 0,
    chatCount: profileRow?.chat_count || recentChats.length || 0,
    messageCount: profileRow?.message_count || 0,
    lastActivity: profileRow?.last_activity_at || recentChats[0]?.last_message_at || null,
    profileMarkdown: profileRow?.profile_markdown || '',
    participants: facts.participants || [],
    openQuestions: facts.open_questions || [],
    actionItems: facts.action_items || [],
    links: facts.links || [],
    recentChats,
    recentMessages,
  };
}

// ── Email intelligence provider ──────────────────────────────────────
// Reads the CLI/WorkIQ-sourced email datastore (tools/email -> email_* tables) for a
// TPID. Personal enrichment, gated by SE_ASSIST_EMAIL_SOURCE (auto|workiq|none, default
// auto). Org users without the email pipeline simply get an empty result.

function emptyEmailIntel(source = 'none') {
  return {
    source,
    available: false,
    emailCount: 0,
    threadCount: 0,
    lastActivity: null,
    participants: [],
    openQuestions: [],
    actionItems: [],
    links: [],
    recentEmails: [],
  };
}

function resolveEmailSourceMode(env = process.env) {
  const v = String(env.SE_ASSIST_EMAIL_SOURCE || 'auto').trim().toLowerCase();
  return ['workiq', 'none', 'auto'].includes(v) ? v : 'auto';
}

function loadEmailIntelligence(database, tpid, limit = 12) {
  const mode = resolveEmailSourceMode();
  if (mode === 'none' || !tpid) return emptyEmailIntel(mode === 'none' ? 'none' : 'none');

  let profileRow = null;
  try {
    profileRow = database
      .prepare('SELECT email_count, thread_count, last_activity_at, facts_json FROM active_email_customer_profile WHERE tpid = ?')
      .get(tpid);
  } catch {
    return emptyEmailIntel('none'); // email tables absent (older db / org build)
  }
  let recentEmails = [];
  try {
    // Collapse folder-copy duplicates. The same physical email can be ingested
    // more than once (e.g. it lives in two Outlook folders / mailboxes): each
    // copy gets a distinct Outlook item id (message_id) but shares the RFC-822
    // internet_message_id, body and timestamp. Group by the logical identity
    // (internet_message_id, falling back to message_id when absent) and keep the
    // most-recent copy so the same email never appears — or gets linked — twice.
    recentEmails = database
      .prepare(
        `SELECT e.message_id, e.subject, e.from_name, MAX(e.received_at) AS received_at,
                substr(e.body_text, 1, 280) AS excerpt
         FROM active_emails e
         JOIN active_email_customer_links l ON l.message_id = e.message_id
         WHERE l.tpid = ? AND l.match_method <> 'ai-rejected'
         GROUP BY COALESCE(NULLIF(e.internet_message_id, ''), e.message_id)
         ORDER BY (received_at IS NULL), received_at DESC
         LIMIT ${Math.max(1, Math.min(50, Number(limit) || 12))}`,
      )
      .all(tpid);
  } catch {
    /* ignore */
  }
  if (!profileRow && recentEmails.length === 0) return emptyEmailIntel('workiq');

  const facts = safeParseJson(profileRow?.facts_json, {}) || {};
  return {
    source: 'workiq',
    available: Boolean(profileRow) || recentEmails.length > 0,
    emailCount: profileRow?.email_count || recentEmails.length || 0,
    threadCount: profileRow?.thread_count || 0,
    lastActivity: profileRow?.last_activity_at || recentEmails[0]?.received_at || null,
    participants: facts.participants || [],
    openQuestions: facts.open_questions || [],
    actionItems: facts.action_items || [],
    links: facts.links || [],
    recentEmails,
  };
}

// ── Meeting intelligence provider ────────────────────────────────────
// Reads the CLI/WorkIQ-sourced meeting datastore (tools/meetings -> meeting_* tables)
// for a TPID. Personal enrichment, gated by SE_ASSIST_EMAIL_SOURCE (shared toggle with
// email, since both come from the WorkIQ MCP). Org users without the pipeline get empty.

function emptyMeetingIntel(source = 'none') {
  return {
    source,
    available: false,
    meetingCount: 0,
    lastActivity: null,
    organizers: [],
    attendees: [],
    actionItems: [],
    links: [],
    recentMeetings: [],
  };
}

function loadMeetingIntelligence(database, tpid, limit = 12, opts = {}) {
  const mode = resolveEmailSourceMode();
  if (mode === 'none' || !tpid) return emptyMeetingIntel('none');

  let profileRow = null;
  try {
    profileRow = database
      .prepare('SELECT meeting_count, last_activity_at, facts_json FROM active_meeting_customer_profile WHERE tpid = ?')
      .get(tpid);
  } catch {
    return emptyMeetingIntel('none'); // meeting tables absent (older db / org build)
  }
  let recentMeetings = [];
  try {
    // Candidate window. Default surfaces the newest meetings first (future
    // included) — right for the calendar/top-of-mind views. But for milestone
    // relationship identification, accounts with recurring meetings scheduled
    // months ahead let a plain start_at DESC fill the fixed candidate window with
    // far-future placeholders, burying the substantive recent activity. The
    // signal finder therefore passes window:'past' to consider today's date and
    // backwards only (most-recent past first), so real engagement is what the
    // model reasons over — not meetings that have not happened yet.
    const pastOnly = opts.window === 'past';
    const whereExtra = pastOnly
      ? "AND m.start_at IS NOT NULL AND julianday(m.start_at) <= julianday('now')"
      : '';
    recentMeetings = database
      .prepare(
        `SELECT m.event_id, m.subject, m.organizer_name, m.start_at, m.is_online_meeting,
                substr(m.body_text, 1, 360) AS excerpt
         FROM active_meetings m
         JOIN active_meeting_customer_links l ON l.event_id = m.event_id
         WHERE l.tpid = ? AND l.match_method <> 'ai-rejected'
         ${whereExtra}
         ORDER BY (m.start_at IS NULL), m.start_at DESC
         LIMIT ${Math.max(1, Math.min(50, Number(limit) || 12))}`,
      )
      .all(tpid);
  } catch {
    /* ignore */
  }
  if (!profileRow && recentMeetings.length === 0) return emptyMeetingIntel('workiq');

  const facts = safeParseJson(profileRow?.facts_json, {}) || {};
  return {
    source: 'workiq',
    available: Boolean(profileRow) || recentMeetings.length > 0,
    meetingCount: profileRow?.meeting_count || recentMeetings.length || 0,
    lastActivity: profileRow?.last_activity_at || recentMeetings[0]?.start_at || null,
    organizers: facts.organizers || [],
    attendees: facts.attendees || [],
    actionItems: facts.action_items || [],
    links: facts.links || [],
    recentMeetings,
  };
}

// ── Account team provider ────────────────────────────────────────────
// Internal Microsoft v-team (+ customer contacts) per account, derived from the Teams
// and email datastores by tools/account_team -> customer_account_team. Read-only here.
function loadAccountTeam(database, tpid) {
  const empty = { available: false, microsoft: [], customer: [], counts: { microsoft: 0, customer: 0, partner: 0, unverified: 0 } };
  if (!tpid) return empty;
  let rows = [];
  try {
    rows = database
      .prepare(
        `SELECT person_name, person_email, org, email_sends, email_cc, teams_msgs,
                last_activity, sources, engagement
         FROM active_customer_account_team
         WHERE tpid = ?
         ORDER BY (org='microsoft') DESC, engagement DESC`,
      )
      .all(tpid);
  } catch {
    return empty; // table absent (older db / org build without the tool)
  }
  if (!rows.length) return empty;

  const counts = { microsoft: 0, customer: 0, partner: 0, unverified: 0 };
  const microsoft = [];
  const customer = [];
  for (const r of rows) {
    if (counts[r.org] != null) counts[r.org] += 1;
    const person = {
      name: r.person_name,
      email: r.person_email || null,
      emailSends: r.email_sends,
      emailCc: r.email_cc,
      teamsMsgs: r.teams_msgs,
      lastActivity: r.last_activity || null,
      sources: r.sources || '',
    };
    if (r.org === 'microsoft' && microsoft.length < 15) microsoft.push(person);
    else if (r.org === 'customer' && customer.length < 10) customer.push(person);
  }
  return { available: true, microsoft, customer, counts };
}

module.exports = {
  emptyTeamsIntel,
  resolveTeamsSourceMode,
  cliTeamsHasData,
  graphTeamsHasData,
  loadTeamsIntelligence,
  loadTeamsIntelligenceFromGraph,
  loadTeamsIntelligenceFromCli,
  emptyEmailIntel,
  resolveEmailSourceMode,
  loadEmailIntelligence,
  emptyMeetingIntel,
  loadMeetingIntelligence,
  loadAccountTeam,
};
