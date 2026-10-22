'use strict';

// Stakeholder influence map: deterministic engine.
//
// PRIVACY. Only non-Microsoft people linked to one customer account are profiled, and only
// from data SE Assist already holds locally: pulled email headers and bodies, calendar
// attendance, meeting transcripts, the account team and CRM contacts. Every inference
// carries the evidence it came from. Each profile also lists the Microsoft people seen on
// the same emails and meetings; Microsoft people themselves are never scored.
// Email addresses never leave this process: buildAnalystContext() refers to people by P#
// handles and replaces addresses with "[email]" before any model call.
//
// DETERMINISTIC vs AI. Identity resolution, joins, counts, scores, tags and the
// "hidden influencer" flag are plain code. The model is only asked to judge observable
// stance and adopted suggestions, and every quote it returns is checked verbatim against
// the exact text it was shown (parseInfluenceAssessment).

const crypto = require('node:crypto');
const { participantFrom, participantList, isInternalEmail } = require('./customer-relationship-graph');
const { cleanVtt } = require('./meeting-transcript');
const { compactEmailLinks, isProtectedMessageText } = require('./email-content');

const BROADCAST_MAX = 20;
const EVIDENCE_CAP = 40;
const MICROSOFT_CAP = 30;
const MAX_PEOPLE = 60;
const MAX_NODES = 40;
const MAX_EDGES = 150;
const MIN_EVIDENCE_FOR_TAGS = 3;
const LOOPED_IN_TAG_MIN = 0.75;
const HIDDEN_MIN_INBOUND = 0.6;
const HIDDEN_MAX_OUTBOUND = 0.2;
const QUIET_MIN_MEETINGS = 2;

// A signal reaches full strength only at the account's maximum AND at least this many
// observations, so on a thin account a single email or meeting doesn't read as 100%.
const SIGNAL_FLOORS = Object.freeze({
  reach: 12,
  looped: 6,
  initiative: 4,
  presence: 6,
  invitedBy: 3,
  sent: 6,
  drawn: 10,
  wordShare: 0.25,
});

const ANALYST_VERSION = 1;
const ANALYST_MAX_PEOPLE = 25;
const TRANSCRIPT_BUDGET = 40000;
const TRANSCRIPT_MIN_SHARE = 6000;
const MIN_REMAINING = 2000;
const TRANSCRIPT_LINE_MAX = 2000;
const EMAIL_BUDGET = 30000;
const EMAIL_SNIPPET = 500;
const THREAD_HEAD = 4;
const THREAD_TAIL = 6;
const RECIPIENT_NAMES = 12;

const WEIGHTS = Object.freeze({
  emailReach: 0.25,
  loopedIn: 0.2,
  initiative: 0.15,
  meetingPresence: 0.2,
  conversationPull: 0.2,
});

const STANCES = Object.freeze(['champion', 'blocker', 'neutral', 'unclear']);
const CONFIDENCES = Object.freeze(['high', 'medium', 'low']);
const TAG_LABELS = Object.freeze({
  'frequently-looped-in': 'Frequently looped in',
  'convenes-meetings': 'Convenes meetings',
  'draws-responses': 'Draws responses',
  'quiet-observer': 'Quiet observer',
});

const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'protonmail.com', 'proton.me',
  'gmx.com', 'mail.com', 'yandex.com', 'qq.com', '163.com',
]);

const UNREADABLE_ASSESSMENT = 'The saved AI analysis could not be read. Delete it and analyze again.';
const OUTDATED_ASSESSMENT = 'The saved AI analysis was made by an older analyzer version. Delete it and analyze again.';

function safeJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.includes('@') ? email : '';
}

function normalizeName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameKey(value) {
  return normalizeName(value).toLowerCase();
}

function emailDomain(email) {
  return normalizeEmail(email).split('@')[1] || '';
}

function localPart(email) {
  return normalizeEmail(email).split('@')[0] || '';
}

function clip(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function norm(value, scale) {
  return scale > 0 ? Math.min(1, Math.log1p(Math.max(0, value)) / Math.log1p(scale)) : 0;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function pairKey(a, b) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function eventDate(row) {
  return row?.sent_at || row?.received_at || '';
}

function compareByDateThenId(a, b) {
  const da = eventDate(a);
  const db = eventDate(b);
  if (da !== db) return da < db ? -1 : 1;
  return String(a.message_id).localeCompare(String(b.message_id));
}

// Name keys a person may appear under: "Doe, Jane (Contoso)" also matches "jane doe".
function nameVariants(name) {
  const key = nameKey(name);
  if (!key) return [];
  const variants = new Set([key]);
  const stripped = key.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (stripped) variants.add(stripped);
  for (const base of [key, stripped]) {
    const match = /^([^,]+),\s*([^,]+)$/.exec(base);
    if (match) variants.add(`${match[2].trim()} ${match[1].trim()}`);
  }
  return [...variants].filter(Boolean);
}

function addToIndex(index, key, value) {
  if (!key) return;
  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(value);
}

// Returns { match, ambiguous } for a name looked up across all of its variants.
function lookupByName(index, name, toEntry = (value) => value) {
  const found = new Set();
  for (const variant of nameVariants(name)) {
    for (const value of index.get(variant) || []) {
      const entry = toEntry(value);
      if (entry) found.add(entry);
    }
  }
  if (found.size === 1) return { match: [...found][0], ambiguous: false };
  return { match: null, ambiguous: found.size > 1 };
}

// Identity resolver. Seeds from the account team and CRM contacts, then learns from every
// email and meeting participant. Entry ids are fixed at creation: the email, or name:<key>.
// A name alone merges two sightings only when the name is unique, one side has no email,
// and both sides agree on whether the person is a Microsoft employee.
function createResolver({ team = [], contacts = [] } = {}) {
  const entries = new Map();
  const byEmail = new Map();
  const byName = new Map();
  const sightedNames = new Map();
  const namesById = new Map();
  const customerDomains = new Set();

  function sight(variant, id) {
    addToIndex(sightedNames, variant, id);
    addToIndex(namesById, id, variant);
  }

  function indexEntryName(entry, name) {
    for (const variant of nameVariants(name)) {
      addToIndex(byName, variant, entry);
      sight(variant, entry.id);
    }
  }

  function create({ name, email, title = null, affiliation = null, internal, fallbackName = false }) {
    const id = email || `name:${nameKey(name)}`;
    if (entries.has(id)) return entries.get(id);
    const entry = {
      id,
      name: normalizeName(name) || localPart(email) || id,
      email: email || '',
      title: title || null,
      affiliation,
      internal: Boolean(internal),
      fallbackName,
    };
    entries.set(id, entry);
    if (email) byEmail.set(email, entry);
    indexEntryName(entry, entry.name);
    return entry;
  }

  function attachEmail(entry, email) {
    if (!email || entry.email) return;
    entry.email = email;
    byEmail.set(email, entry);
  }

  function findForMerge(name, email, internal) {
    if (email && byEmail.has(email)) return byEmail.get(email);
    if (!name) return null;
    const { match } = lookupByName(byName, name);
    if (!match) return null;
    if (email && match.email) return null;
    if (match.internal !== internal) return null;
    return match;
  }

  // The account team's customer / partner split is a mailbox heuristic and its 'unverified'
  // rows are usually unconfirmed colleagues, so a team row only contributes an identity when
  // it carries an address or is labelled Microsoft. Customer affiliation comes from CRM.
  for (const row of team || []) {
    const email = normalizeEmail(row?.person_email);
    const name = normalizeName(row?.person_name);
    if (!email && !name) continue;
    const org = String(row?.org || '').trim().toLowerCase();
    const internal = org === 'microsoft' || isInternalEmail(email);
    if (!internal && !email) continue;
    const existing = findForMerge(name, email, internal);
    if (existing) {
      attachEmail(existing, email);
      continue;
    }
    create({ name: name || localPart(email), email, affiliation: internal ? 'microsoft' : null, internal });
  }

  for (const row of contacts || []) {
    const email = normalizeEmail(row?.email);
    const name = normalizeName(row?.full_name);
    if (!email && !name) continue;
    const internal = isInternalEmail(email);
    const title = normalizeName(row?.job_title) || null;
    const existing = findForMerge(name, email, internal);
    if (existing) {
      attachEmail(existing, email);
      if (!existing.title && title) existing.title = title;
      if (!existing.internal) existing.affiliation = 'customer';
      continue;
    }
    create({ name: name || localPart(email), email, title, affiliation: internal ? 'microsoft' : 'customer', internal });
  }

  for (const entry of entries.values()) {
    if (entry.internal || entry.affiliation !== 'customer' || !entry.email) continue;
    const domain = emailDomain(entry.email);
    if (domain && !PUBLIC_MAIL_DOMAINS.has(domain)) customerDomains.add(domain);
  }

  function resolve(participant) {
    if (!participant) return null;
    const email = normalizeEmail(participant.email);
    const rawName = normalizeName(participant.name);
    // participantFrom() falls back to the address local part when there is no display name.
    const realName = rawName && !(email && nameKey(rawName) === localPart(email)) ? rawName : '';
    const internal = isInternalEmail(email);
    let entry = email ? byEmail.get(email) || null : null;
    if (!entry && realName) {
      const { match } = lookupByName(byName, realName);
      if (match && (!email || !match.email) && match.internal === internal) {
        entry = match;
        attachEmail(entry, email);
      }
    }
    if (!entry) {
      if (!email) return null;
      entry = create({
        name: realName || localPart(email),
        email,
        internal,
        affiliation: internal ? 'microsoft' : null,
        fallbackName: !realName,
      });
    } else if (realName && entry.fallbackName) {
      entry.name = realName;
      entry.fallbackName = false;
      indexEntryName(entry, realName);
    }
    if (realName) {
      for (const variant of nameVariants(realName)) sight(variant, entry.id);
    }
    return entry;
  }

  // 'customer' means a CRM contact of this account or someone at a CRM contact's domain;
  // every other non-Microsoft person is 'external' (partner, vendor or unknown).
  function affiliationOf(entry) {
    if (entry.internal) return 'microsoft';
    if (entry.affiliation === 'customer') return 'customer';
    return customerDomains.has(emailDomain(entry.email)) ? 'customer' : 'external';
  }

  // Transcript speakers are bare display names. Try this meeting's participants, then known
  // people, then every name seen anywhere; an ambiguous match at any level stays unresolved.
  function lookupSpeaker(label, meetingNames) {
    if (meetingNames) {
      const local = lookupByName(meetingNames, label);
      if (local.match) return local.match;
      if (local.ambiguous) return null;
    }
    const known = lookupByName(byName, label);
    if (known.match) return known.match;
    if (known.ambiguous) return null;
    return lookupByName(sightedNames, label, (id) => entries.get(id)).match;
  }

  // Every name variant a person has been seen under, including replaced placeholder names.
  function namesOf(id) {
    return namesById.get(id) || new Set();
  }

  return { resolve, affiliationOf, lookupSpeaker, namesOf, entries };
}

function newProfile(entry) {
  return {
    entry,
    sent: 0,
    threadsStarted: 0,
    to: 0,
    cc: 0,
    loopedInBy: new Set(),
    addedMidThread: 0,
    organized: 0,
    invited: 0,
    required: 0,
    optional: 0,
    declined: 0,
    accepted: 0,
    invitedBy: new Set(),
    meetings: new Set(),
    turns: 0,
    words: 0,
    transcriptMeetings: new Set(),
    responsesDrawn: 0,
    respondents: new Set(),
    microsoft: new Map(),
    evidence: [],
  };
}

function createState(resolver) {
  const profiles = new Map();
  const edges = new Map();
  return {
    resolver,
    profiles,
    edges,
    coveredWords: new Map(),
    attributedMeetings: new Map(),
    threads: [],
    meetings: new Map(),
    transcripts: [],
    sources: {
      emails: 0,
      emailThreads: 0,
      duplicateEmails: 0,
      broadcastEmails: 0,
      meetings: 0,
      broadcastMeetings: 0,
      cancelledMeetings: 0,
      transcripts: 0,
      broadcastTranscripts: 0,
      transcriptTurns: 0,
      unresolvedSpeakers: 0,
    },
    profile(entry) {
      if (!profiles.has(entry.id)) profiles.set(entry.id, newProfile(entry));
      return profiles.get(entry.id);
    },
    edge(a, b) {
      const key = pairKey(a.id, b.id);
      if (!edges.has(key)) {
        const [source, target] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
        edges.set(key, { source, target, email: 0, meeting: 0, transcript: 0 });
      }
      return edges.get(key);
    },
  };
}

function addEvidence(profile, item) {
  profile.evidence.push({
    kind: item.kind,
    id: item.id,
    threadId: item.threadId || null,
    title: normalizeName(item.title) || '(no subject)',
    date: item.date || null,
    role: item.role,
    note: item.note || '',
    webLink: item.webLink || null,
  });
}

// Counts each pair of non-Microsoft participants once per thread or meeting.
function linkPairs(state, entries, seenPairs, field) {
  const external = entries.filter((entry) => entry && !entry.internal);
  for (let i = 0; i < external.length; i += 1) {
    for (let j = i + 1; j < external.length; j += 1) {
      if (external[i].id === external[j].id) continue;
      const key = pairKey(external[i].id, external[j].id);
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      state.edge(external[i], external[j])[field] += 1;
    }
  }
}

// Records the Microsoft people on the same email thread or meeting as each non-Microsoft
// participant. Keyed by thread or meeting id, so each one counts once however often it recurs.
function linkMicrosoft(state, entries, kind, itemId) {
  const people = new Map();
  for (const entry of entries) {
    if (entry) people.set(entry.id, entry);
  }
  const colleagues = [...people.values()].filter((entry) => entry.internal);
  if (!colleagues.length) return;
  for (const entry of people.values()) {
    if (entry.internal) continue;
    const contacts = state.profile(entry).microsoft;
    for (const colleague of colleagues) {
      if (!contacts.has(colleague.id)) {
        contacts.set(colleague.id, { entry: colleague, threads: new Set(), meetings: new Set() });
      }
      contacts.get(colleague.id)[kind === 'email' ? 'threads' : 'meetings'].add(itemId);
    }
  }
}

function rawParticipantKey(participant) {
  if (!participant) return '';
  return normalizeEmail(participant.email) || `name:${nameKey(participant.name)}`;
}

function preferredCopy(a, b) {
  const linkA = a.web_link ? 1 : 0;
  const linkB = b.web_link ? 1 : 0;
  if (linkA !== linkB) return linkA > linkB ? a : b;
  const lengthA = String(a.body_text || '').length;
  const lengthB = String(b.body_text || '').length;
  if (lengthA !== lengthB) return lengthA > lengthB ? a : b;
  return String(a.message_id) <= String(b.message_id) ? a : b;
}

// The same message can be stored more than once (folder or mailbox copies). Each copy has its
// own message_id but shares the internet_message_id, so it is counted once.
function uniqueEmails(state, emails) {
  const byIdentity = new Map();
  for (const row of emails || []) {
    if (!row?.message_id) continue;
    const internetId = typeof row.internet_message_id === 'string' ? row.internet_message_id.trim() : '';
    const key = internetId ? `internet:${internetId}` : `id:${row.message_id}`;
    const current = byIdentity.get(key);
    if (current) state.sources.duplicateEmails += 1;
    byIdentity.set(key, current ? preferredCopy(current, row) : row);
  }
  return [...byIdentity.values()];
}

function processEmails(state, emails) {
  const threads = new Map();
  for (const row of uniqueEmails(state, emails)) {
    const threadId = String(row.conversation_id || row.message_id);
    if (!threads.has(threadId)) threads.set(threadId, []);
    threads.get(threadId).push(row);
  }
  for (const [threadId, rows] of threads) {
    rows.sort(compareByDateThenId);
    state.sources.emailThreads += 1;
    const seenInThread = new Set();
    const seenPairs = new Set();
    const messages = [];
    rows.forEach((row, index) => {
      state.sources.emails += 1;
      const senderRaw = participantFrom({ name: row.from_name, address: row.from_address });
      const sender = state.resolver.resolve(senderRaw);
      const rawKeys = new Set();
      const recipientIds = new Set();
      const recipients = [];
      for (const [role, list] of [['To', participantList(row.to_json)], ['Cc', participantList(row.cc_json)]]) {
        for (const participant of list) {
          const rawKey = rawParticipantKey(participant);
          if (rawKeys.has(rawKey)) continue;
          rawKeys.add(rawKey);
          const entry = state.resolver.resolve(participant);
          if (entry && sender && entry.id === sender.id) continue;
          if (entry && recipientIds.has(entry.id)) continue;
          if (entry) recipientIds.add(entry.id);
          recipients.push({ entry, name: normalizeName(participant.name), role });
        }
      }
      const broadcast = rawKeys.size > BROADCAST_MAX;
      const date = eventDate(row) || null;
      messages.push({ row, date, sender, senderName: normalizeName(senderRaw?.name), recipients, broadcast });
      if (broadcast) {
        state.sources.broadcastEmails += 1;
      } else {
        const base = { kind: 'email', id: row.message_id, threadId, title: row.subject, date, webLink: row.web_link };
        if (sender && !sender.internal) {
          const profile = state.profile(sender);
          profile.sent += 1;
          if (index === 0) profile.threadsStarted += 1;
          addEvidence(profile, { ...base, role: 'Sent', note: index === 0 ? 'First pulled message in the thread' : '' });
        }
        for (const { entry, role } of recipients) {
          if (!entry || entry.internal) continue;
          const profile = state.profile(entry);
          if (role === 'To') profile.to += 1;
          else profile.cc += 1;
          if (sender) profile.loopedInBy.add(sender.id);
          const addedMidThread = index > 0 && !seenInThread.has(entry.id);
          if (addedMidThread) profile.addedMidThread += 1;
          addEvidence(profile, { ...base, role, note: addedMidThread ? 'Added mid-thread' : '' });
        }
        const participants = [sender, ...recipients.map((recipient) => recipient.entry)];
        linkPairs(state, participants, seenPairs, 'email');
        linkMicrosoft(state, participants, 'email', threadId);
      }
      if (sender) seenInThread.add(sender.id);
      // Broadcast participants still count as already on the thread, so a later normal reply
      // doesn't flag them as added mid-thread.
      for (const recipient of recipients) {
        if (recipient.entry) seenInThread.add(recipient.entry.id);
      }
    });
    state.threads.push({ threadId, messages });
  }
}

function processMeetings(state, meetings) {
  for (const row of meetings || []) {
    if (!row?.event_id) continue;
    if (row.is_cancelled === true || Number(row.is_cancelled) === 1) {
      state.sources.cancelledMeetings += 1;
      continue;
    }
    state.sources.meetings += 1;
    const organizerRaw = participantFrom({ name: row.organizer_name, address: row.organizer_address });
    const organizer = state.resolver.resolve(organizerRaw);
    const organizerKey = rawParticipantKey(organizerRaw);
    const names = new Map();
    const remember = (name, entry) => {
      if (!entry) return;
      for (const variant of nameVariants(name)) addToIndex(names, variant, entry);
    };
    remember(organizerRaw?.name, organizer);
    if (organizer) remember(organizer.name, organizer);
    const rawKeys = new Set();
    const attendeeIds = new Set();
    const attendees = [];
    const parsed = safeJson(row.attendees_json, []);
    for (const raw of Array.isArray(parsed) ? parsed : []) {
      if (!raw || typeof raw !== 'object') continue;
      const type = String(raw.type || '').trim().toLowerCase();
      if (type === 'resource') continue;
      const participant = participantFrom(raw);
      if (!participant) continue;
      const rawKey = rawParticipantKey(participant);
      if (rawKey === organizerKey || rawKeys.has(rawKey)) continue;
      const entry = state.resolver.resolve(participant);
      if (entry && organizer && entry.id === organizer.id) continue;
      rawKeys.add(rawKey);
      remember(participant.name, entry);
      if (!entry || attendeeIds.has(entry.id)) continue;
      remember(entry.name, entry);
      attendeeIds.add(entry.id);
      const response = String(raw.response || raw.status?.response || '').trim().toLowerCase();
      attendees.push({ entry, type: type === 'optional' ? 'optional' : 'required', response });
    }
    const broadcast = rawKeys.size > BROADCAST_MAX;
    state.meetings.set(row.event_id, { row, organizer, attendees, names, broadcast });
    if (broadcast) {
      state.sources.broadcastMeetings += 1;
      continue;
    }
    const base = { kind: 'meeting', id: row.event_id, title: row.subject, date: row.start_at || null, webLink: row.web_link };
    if (organizer && !organizer.internal) {
      const profile = state.profile(organizer);
      profile.organized += 1;
      profile.meetings.add(row.event_id);
      addEvidence(profile, { ...base, role: 'Organized' });
    }
    for (const { entry, type, response } of attendees) {
      if (entry.internal) continue;
      const profile = state.profile(entry);
      const declined = response === 'declined';
      profile.invited += 1;
      if (type === 'optional') profile.optional += 1;
      else profile.required += 1;
      if (organizer) profile.invitedBy.add(organizer.id);
      if (declined) profile.declined += 1;
      else profile.meetings.add(row.event_id);
      if (response === 'accepted') profile.accepted += 1;
      addEvidence(profile, { ...base, role: declined ? 'Declined' : (type === 'optional' ? 'Optional' : 'Required') });
    }
    const present = attendees.filter((attendee) => attendee.response !== 'declined').map((attendee) => attendee.entry);
    linkPairs(state, [organizer, ...present], new Set(), 'meeting');
    linkMicrosoft(state, [organizer, ...present], 'meeting', row.event_id);
  }
}

function countWords(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

// "Speaker: text" turns. Continuation lines join the previous turn and consecutive turns by
// the same speaker merge, so each turn boundary is a real change of speaker.
function parseTurns(transcript) {
  const clean = cleanVtt(String(transcript || ''));
  const turns = [];
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([^:]{1,60}):(?:\s+(.*))?$/.exec(line);
    const label = match ? normalizeName(match[1]) : '';
    const previous = turns[turns.length - 1];
    if (label) {
      const text = String(match[2] || '').trim();
      if (previous && nameKey(previous.label) === nameKey(label)) {
        previous.text = [previous.text, text].filter(Boolean).join(' ');
      } else {
        turns.push({ label, text });
      }
    } else if (previous) {
      previous.text = [previous.text, line].filter(Boolean).join(' ');
    }
  }
  return turns;
}

function processTranscripts(state, transcripts) {
  for (const item of transcripts || []) {
    const meeting = state.meetings.get(item?.event_id);
    if (!meeting) continue;
    const parsed = parseTurns(item.transcript);
    if (!parsed.length) continue;
    // A broadcast meeting is ignored, and so is its transcript: its speakers are not scored
    // and its text never reaches the AI.
    if (meeting.broadcast) {
      state.sources.broadcastTranscripts += 1;
      continue;
    }
    const turns = parsed.map((turn) => ({
      ...turn,
      key: nameKey(turn.label),
      entry: state.resolver.lookupSpeaker(turn.label, meeting.names),
      words: countWords(turn.text),
    }));
    const eventId = meeting.row.event_id;
    state.sources.transcripts += 1;
    state.sources.transcriptTurns += turns.length;
    state.transcripts.push({ meeting, turns });
    const totalWords = turns.reduce((sum, turn) => sum + turn.words, 0);
    const unresolved = new Set();
    const spoke = new Map();
    for (const turn of turns) {
      if (!turn.entry) {
        unresolved.add(turn.key);
        continue;
      }
      if (turn.entry.internal) continue;
      const profile = state.profile(turn.entry);
      profile.turns += 1;
      profile.words += turn.words;
      profile.transcriptMeetings.add(eventId);
      spoke.set(turn.entry.id, (spoke.get(turn.entry.id) || 0) + 1);
    }
    state.sources.unresolvedSpeakers += unresolved.size;
    // Whoever spoke was in the meeting, even when the invite doesn't list them.
    const present = meeting.attendees.filter((attendee) => attendee.response !== 'declined').map((attendee) => attendee.entry);
    linkMicrosoft(state, [meeting.organizer, ...present, ...turns.map((turn) => turn.entry)], 'meeting', eventId);
    const seenPairs = new Set();
    for (let index = 1; index < turns.length; index += 1) {
      const from = turns[index - 1];
      const to = turns[index];
      const fromKey = from.entry ? from.entry.id : `label:${from.key}`;
      const toKey = to.entry ? to.entry.id : `label:${to.key}`;
      if (fromKey === toKey || !from.entry || from.entry.internal) continue;
      const profile = state.profile(from.entry);
      profile.responsesDrawn += 1;
      profile.respondents.add(toKey);
      if (to.entry && !to.entry.internal) {
        const key = pairKey(from.entry.id, to.entry.id);
        if (!seenPairs.has(key)) {
          seenPairs.add(key);
          state.edge(from.entry, to.entry).transcript += 1;
        }
      }
    }
    // Word share is measured only against meetings a person could have spoken in: the
    // speakers, the organizer and every invitee who didn't decline.
    const covered = new Set(spoke.keys());
    if (meeting.organizer && !meeting.organizer.internal) covered.add(meeting.organizer.id);
    for (const attendee of meeting.attendees) {
      if (!attendee.entry.internal && attendee.response !== 'declined') covered.add(attendee.entry.id);
    }
    for (const id of covered) state.coveredWords.set(id, (state.coveredWords.get(id) || 0) + totalWords);
    // Silence is observable only where every speaker was identified; a shared room device
    // or an unmatched label could be anyone in the room.
    if (!unresolved.size) {
      for (const id of covered) state.attributedMeetings.set(id, (state.attributedMeetings.get(id) || 0) + 1);
    }
    for (const [id, count] of spoke) {
      addEvidence(state.profiles.get(id), {
        kind: 'transcript',
        id: eventId,
        title: meeting.row.subject,
        date: meeting.row.start_at || null,
        role: 'Spoke',
        note: `${count} ${count === 1 ? 'turn' : 'turns'}`,
        webLink: meeting.row.web_link,
      });
    }
  }
}

function scaleOf(rows, pick, floor) {
  return rows.reduce((max, row) => Math.max(max, pick(row)), floor);
}

function tagsFor(row) {
  if (row.evidenceTotal < MIN_EVIDENCE_FOR_TAGS) return [];
  const { profile, components } = row;
  const ids = [];
  if (components.loopedIn >= LOOPED_IN_TAG_MIN) ids.push('frequently-looped-in');
  if (profile.organized >= 2 && components.initiative >= 0.5) ids.push('convenes-meetings');
  if (row.covered && components.conversationPull >= 0.6) ids.push('draws-responses');
  if (row.attributedMeetings >= QUIET_MIN_MEETINGS && profile.sent === 0 && profile.words === 0) {
    ids.push('quiet-observer');
  }
  return ids.map((id) => ({ id, label: TAG_LABELS[id] }));
}

// Scores are relative to the other non-Microsoft people on the same account, including
// people the user excluded, so excluding someone never changes anyone else's score.
function scoreProfiles(state) {
  const rows = [];
  for (const profile of state.profiles.values()) {
    if (profile.entry.internal) continue;
    const coveredWords = state.coveredWords.get(profile.entry.id) || 0;
    const covered = coveredWords > 0;
    rows.push({
      profile,
      reach: profile.sent + profile.to + profile.cc,
      looped: profile.loopedInBy.size + profile.addedMidThread,
      initiative: profile.threadsStarted + profile.organized,
      presence: profile.meetings.size,
      invitedBy: profile.invitedBy.size,
      covered,
      attributedMeetings: state.attributedMeetings.get(profile.entry.id) || 0,
      wordShare: covered ? profile.words / coveredWords : 0,
    });
  }
  const coveredRows = rows.filter((row) => row.covered);
  const scales = {
    reach: scaleOf(rows, (row) => row.reach, SIGNAL_FLOORS.reach),
    looped: scaleOf(rows, (row) => row.looped, SIGNAL_FLOORS.looped),
    initiative: scaleOf(rows, (row) => row.initiative, SIGNAL_FLOORS.initiative),
    presence: scaleOf(rows, (row) => row.presence, SIGNAL_FLOORS.presence),
    invitedBy: scaleOf(rows, (row) => row.invitedBy, SIGNAL_FLOORS.invitedBy),
    sent: scaleOf(rows, (row) => row.profile.sent, SIGNAL_FLOORS.sent),
    drawn: scaleOf(coveredRows, (row) => row.profile.responsesDrawn, SIGNAL_FLOORS.drawn),
    wordShare: scaleOf(coveredRows, (row) => row.wordShare, SIGNAL_FLOORS.wordShare),
  };
  for (const row of rows) {
    const { profile } = row;
    const components = {
      emailReach: norm(row.reach, scales.reach),
      loopedIn: norm(row.looped, scales.looped),
      initiative: norm(row.initiative, scales.initiative),
      meetingPresence: norm(row.presence, scales.presence),
      conversationPull: row.covered
        ? 0.5 * norm(profile.responsesDrawn, scales.drawn) + 0.5 * norm(row.wordShare, scales.wordShare)
        : null,
    };
    let weighted = 0;
    let weight = 0;
    for (const [key, value] of Object.entries(WEIGHTS)) {
      if (components[key] == null) continue;
      weighted += value * components[key];
      weight += value;
    }
    row.components = components;
    row.score = weight > 0 ? Math.round((100 * weighted) / weight) : 0;
    row.inbound = mean([components.loopedIn, norm(row.invitedBy, scales.invitedBy)]);
    const outbound = [norm(profile.sent, scales.sent), components.initiative];
    if (row.covered) outbound.push(norm(row.wordShare, scales.wordShare));
    row.outbound = mean(outbound);
    row.evidenceTotal = profile.evidence.length;
    // Being on the same distribution list as everyone else is not influence: a hidden
    // influencer must also have been deliberately pulled in — added to a running thread or
    // invited by more than one organizer.
    row.hiddenInfluencer = row.inbound >= HIDDEN_MIN_INBOUND
      && row.outbound <= HIDDEN_MAX_OUTBOUND
      && (profile.addedMidThread > 0 || profile.invitedBy.size >= 2)
      && row.evidenceTotal >= MIN_EVIDENCE_FOR_TAGS;
    row.tags = tagsFor(row);
  }
  return rows.sort((a, b) => b.score - a.score
    || a.profile.entry.name.localeCompare(b.profile.entry.name, 'en', { sensitivity: 'base' })
    || a.profile.entry.id.localeCompare(b.profile.entry.id));
}

function signalsOf(row) {
  const { profile } = row;
  return {
    sent: profile.sent,
    threadsStarted: profile.threadsStarted,
    to: profile.to,
    cc: profile.cc,
    loopedInBy: profile.loopedInBy.size,
    addedMidThread: profile.addedMidThread,
    organized: profile.organized,
    invited: profile.invited,
    required: profile.required,
    optional: profile.optional,
    declined: profile.declined,
    accepted: profile.accepted,
    invitedBy: profile.invitedBy.size,
    meetings: profile.meetings.size,
    turns: profile.turns,
    words: profile.words,
    transcripts: profile.transcriptMeetings.size,
    responsesDrawn: profile.responsesDrawn,
    respondents: profile.respondents.size,
    wordShare: round3(row.wordShare),
    covered: row.covered,
    attributedMeetings: row.attributedMeetings,
  };
}

function analyze(inputs = {}) {
  const resolver = createResolver({ team: inputs.team, contacts: inputs.contacts });
  const state = createState(resolver);
  processEmails(state, inputs.emails);
  processMeetings(state, inputs.meetings);
  processTranscripts(state, inputs.transcripts);
  return { resolver, state, rows: scoreProfiles(state) };
}

function overrideMap(overrides) {
  const map = new Map();
  for (const item of overrides || []) {
    const personId = String(item?.personId || '').trim();
    if (!personId) continue;
    map.set(personId, {
      stance: STANCES.includes(item.stance) ? item.stance : null,
      note: String(item.note || ''),
      hidden: Boolean(item.hidden),
    });
  }
  return map;
}

function visibleRows(analysis, overrides) {
  return analysis.rows.filter((row) => !overrides.get(row.profile.entry.id)?.hidden);
}

const EMAIL_ADDRESS = /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;

const QUOTED_HISTORY_MARKERS = [
  /-{2,}\s*Original Message\s*-{2,}/i,
  /_{10,}/,
  /\bFrom:\s[\s\S]{1,300}?\bSent:\s/i,
  /\bFrom:\s[\s\S]{1,300}?\bDate:\s/i,
  /\bOn\s[\s\S]{1,200}?\bwrote:/i,
];

function redactEmails(text) {
  return String(text || '').replace(EMAIL_ADDRESS, '[email]');
}

// Keep only the new text of a reply so the model judges what this sender wrote.
function stripQuotedHistory(text) {
  const value = String(text || '');
  let cut = value.length;
  for (const pattern of QUOTED_HISTORY_MARKERS) {
    const match = pattern.exec(value);
    if (match && match.index < cut) cut = match.index;
  }
  return value.slice(0, cut).trim();
}

function cleanExcerpt(text, max = Infinity) {
  return clip(normalizeName(redactEmails(compactEmailLinks(String(text || '')))), max);
}

function cleanTitle(subject) {
  return normalizeName(redactEmails(subject)) || '(no subject)';
}

function compareDesc(a, b) {
  const left = a || '';
  const right = b || '';
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function signalSentence(signals) {
  const parts = [];
  if (signals.sent) {
    parts.push(`sent ${plural(signals.sent, 'email')}${signals.threadsStarted ? `, starting ${plural(signals.threadsStarted, 'thread')}` : ''}`);
  }
  if (signals.to || signals.cc) {
    parts.push(`addressed on ${plural(signals.to + signals.cc, 'email')} (To ${signals.to}, Cc ${signals.cc})`);
  }
  if (signals.loopedInBy) parts.push(`looped in by ${plural(signals.loopedInBy, 'person', 'people')}`);
  if (signals.addedMidThread) parts.push(`added mid-thread ${plural(signals.addedMidThread, 'time')}`);
  if (signals.organized) parts.push(`organized ${plural(signals.organized, 'meeting')}`);
  if (signals.invited) {
    parts.push(`invited to ${plural(signals.invited, 'meeting')}${signals.declined ? `, declined ${signals.declined}` : ''}`);
  }
  if (signals.turns) {
    const share = signals.covered ? ` (${Math.round(signals.wordShare * 100)}% of words in transcribed meetings they attended)` : '';
    parts.push(`spoke ${plural(signals.turns, 'turn')} in ${plural(signals.transcripts, 'transcript')}${share}`);
  }
  if (signals.responsesDrawn) parts.push(`was followed by another speaker ${plural(signals.responsesDrawn, 'time')}`);
  if (!parts.length) return 'No direct activity recorded.';
  const text = parts.join('; ');
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

// Keeps the start and end of a long transcript and says how much of the middle was cut.
function middleClip(lines, max) {
  const lineMax = Math.min(TRANSCRIPT_LINE_MAX, Math.floor(max / 2));
  const clipped = lines.map((line) => clip(line, lineMax));
  const full = clipped.join('\n');
  if (full.length <= max) return full;
  const head = [];
  const tail = [];
  const reserve = 32;
  let used = 0;
  let start = 0;
  let end = clipped.length - 1;
  while (start <= end) {
    const fromHead = head.length <= tail.length;
    const line = fromHead ? clipped[start] : clipped[end];
    if (used + line.length + 1 + reserve > max) break;
    used += line.length + 1;
    if (fromHead) {
      head.push(line);
      start += 1;
    } else {
      tail.unshift(line);
      end -= 1;
    }
  }
  return [...head, `[${end - start + 1} lines omitted]`, ...tail].join('\n');
}

// A resolved person is hidden by their own exclusion. A sighting the resolver couldn't place
// (no email, or a name several people share) is hidden when it carries any name an excluded
// person was seen under, so an exclusion fails closed. A resolved person who isn't excluded
// is never masked just for sharing a name.
function makeLabeler(overrides, refById, hiddenNames = new Set()) {
  const hidden = (entry, rawName) => {
    if (entry) return Boolean(overrides.get(entry.id)?.hidden);
    return nameVariants(rawName).some((variant) => hiddenNames.has(variant));
  };
  const label = (entry, rawName) => {
    if (hidden(entry, rawName)) return 'Hidden participant';
    if (!entry) {
      const name = normalizeName(redactEmails(rawName));
      return name ? `${clip(name, 60)} [unmatched]` : 'Unknown sender';
    }
    const name = normalizeName(redactEmails(entry.name)) || 'Unnamed person';
    const ref = refById.get(entry.id);
    if (ref) return `${name} [${ref}]`;
    if (entry.internal) return `${name} [Microsoft]`;
    return `${name} [not listed]`;
  };
  return { hidden, label };
}

function transcriptContext(analysis, refById, labeler, sources) {
  const candidates = analysis.state.transcripts
    .filter(({ turns }) => turns.some((turn) => turn.entry && refById.has(turn.entry.id)))
    .sort((a, b) => compareDesc(a.meeting.row.start_at, b.meeting.row.start_at)
      || String(a.meeting.row.event_id).localeCompare(String(b.meeting.row.event_id)));
  const share = Math.max(TRANSCRIPT_MIN_SHARE, Math.floor(TRANSCRIPT_BUDGET / Math.max(1, candidates.length)));
  const out = [];
  let remaining = TRANSCRIPT_BUDGET;
  for (const { meeting, turns } of candidates) {
    if (remaining < MIN_REMAINING) break;
    const lines = turns.map((turn) => (labeler.hidden(turn.entry, turn.label)
      ? 'Hidden participant: [omitted]'
      : `${labeler.label(turn.entry, turn.label)}: ${cleanExcerpt(turn.text)}`));
    const text = middleClip(lines, Math.min(remaining, share));
    remaining -= text.length;
    const ref = `M${out.length + 1}`;
    const date = meeting.row.start_at || null;
    out.push({ ref, title: cleanTitle(meeting.row.subject), date, text });
    sources.set(ref, {
      kind: 'transcript',
      id: meeting.row.event_id,
      title: normalizeName(meeting.row.subject) || '(no subject)',
      date,
      webLink: meeting.row.web_link || null,
      text,
    });
  }
  return out;
}

function renderMessage(message, labeler) {
  const from = labeler.label(message.sender, message.senderName);
  const names = message.recipients.map((recipient) => labeler.label(recipient.entry, recipient.name));
  const shown = names.slice(0, RECIPIENT_NAMES);
  const more = names.length - shown.length;
  let body;
  if (labeler.hidden(message.sender, message.senderName)) body = '[omitted]';
  else if (isProtectedMessageText(message.row.body_text)) body = '[Protected message — body not available]';
  else body = cleanExcerpt(stripQuotedHistory(message.row.body_text), EMAIL_SNIPPET) || '(no new text)';
  return [
    `From: ${from}${message.date ? ` (${message.date})` : ''}`,
    `To/Cc: ${shown.join(', ') || '(none)'}${more > 0 ? `, +${more} more` : ''}`,
    body,
  ].join('\n');
}

function emailContext(analysis, refById, labeler, sources) {
  // Broadcast messages are ignored for scoring, so their text never reaches the AI either.
  const candidates = analysis.state.threads
    .map((thread) => ({ thread, messages: thread.messages.filter((message) => !message.broadcast) }))
    .filter(({ messages }) => messages.some((message) => message.sender && refById.has(message.sender.id)))
    .map((item) => ({ ...item, last: item.messages[item.messages.length - 1] }))
    .sort((a, b) => compareDesc(a.last.date, b.last.date) || a.thread.threadId.localeCompare(b.thread.threadId));
  const out = [];
  let remaining = EMAIL_BUDGET;
  for (const { thread, messages, last } of candidates) {
    if (remaining < MIN_REMAINING) break;
    const omitted = messages.length - THREAD_HEAD - THREAD_TAIL;
    const shown = omitted > 0
      ? [...messages.slice(0, THREAD_HEAD), null, ...messages.slice(-THREAD_TAIL)]
      : messages;
    const blocks = shown.map((message) => (message ? renderMessage(message, labeler) : `[${omitted} messages omitted]`));
    const text = clip(blocks.join('\n\n'), remaining);
    remaining -= text.length;
    const ref = `E${out.length + 1}`;
    const first = messages[0];
    out.push({ ref, title: cleanTitle(first.row.subject), date: last.date, text });
    sources.set(ref, {
      kind: 'email',
      id: thread.threadId,
      title: normalizeName(first.row.subject) || '(no subject)',
      date: last.date,
      webLink: [...messages].reverse().find((message) => message.row.web_link)?.row.web_link || null,
      text,
    });
  }
  return out;
}

// Every name an excluded person was seen under: their resolved names, placeholder names they
// were seen under before a real one, and the raw names they were invited to meetings under.
function hiddenNamesOf(analysis, overrides) {
  const hiddenIds = new Set([...overrides].filter(([, value]) => value.hidden).map(([id]) => id));
  const names = new Set();
  if (!hiddenIds.size) return names;
  const add = (name) => {
    for (const variant of nameVariants(name)) names.add(variant);
  };
  for (const id of hiddenIds) {
    const entry = analysis.resolver.entries.get(id);
    if (entry) add(entry.name);
    for (const variant of analysis.resolver.namesOf(id)) names.add(variant);
    if (id.startsWith('name:')) add(id.slice('name:'.length));
  }
  for (const meeting of analysis.state.meetings.values()) {
    for (const [variant, entries] of meeting.names) {
      for (const entry of entries) {
        if (hiddenIds.has(entry.id)) names.add(variant);
      }
    }
  }
  return names;
}

function contextFromAnalysis(analysis, overrides, accountName) {
  const listed = visibleRows(analysis, overrides).slice(0, ANALYST_MAX_PEOPLE);
  const refById = new Map();
  const refToId = new Map();
  listed.forEach((row, index) => {
    const ref = `P${index + 1}`;
    refById.set(row.profile.entry.id, ref);
    refToId.set(ref, row.profile.entry.id);
  });
  const labeler = makeLabeler(overrides, refById, hiddenNamesOf(analysis, overrides));
  const people = listed.map((row) => ({
    ref: refById.get(row.profile.entry.id),
    name: normalizeName(redactEmails(row.profile.entry.name)) || 'Unnamed person',
    title: row.profile.entry.title ? normalizeName(redactEmails(row.profile.entry.title)) : null,
    affiliation: analysis.resolver.affiliationOf(row.profile.entry),
    score: row.score,
    signals: signalSentence(signalsOf(row)),
    tags: row.tags.map((tag) => tag.label),
  }));
  const sources = new Map();
  const transcripts = transcriptContext(analysis, refById, labeler, sources);
  const emailThreads = emailContext(analysis, refById, labeler, sources);
  return {
    context: { account: normalizeName(accountName) || null, people, transcripts, emailThreads },
    refToId,
    sources,
  };
}

// The exact, email-free input for the stakeholder-influence-analyst agent.
function buildAnalystContext(inputs = {}) {
  return contextFromAnalysis(analyze(inputs), overrideMap(inputs.overrides), inputs.accountName);
}

function hashAnalystContext(context) {
  return crypto.createHash('sha256').update(`v${ANALYST_VERSION}\n${JSON.stringify(context)}`).digest('hex');
}

function normalizeForQuote(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// A quote counts as verified only when every part of it (split on an ellipsis) appears
// word for word in the text the model was given.
function verifyQuote(quote, text) {
  const normalized = normalizeForQuote(quote).replace(/^["']+|["']+$/g, '').trim();
  if (!normalized) return false;
  const parts = normalized.split(/\.\.\.|…/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.reduce((sum, part) => sum + part.length, 0) < 8) return false;
  const haystack = normalizeForQuote(text);
  return parts.every((part) => haystack.includes(part));
}

function publicSource(source) {
  return { kind: source.kind, id: source.id, title: source.title, date: source.date || null, webLink: source.webLink || null };
}

function parseInfluenceAssessment(content, { refToId, sources } = {}) {
  const fail = (why) => {
    throw new Error(`The AI returned an invalid stakeholder assessment (${why}). Nothing was saved. Try Analyze again.`);
  };
  if (!(refToId instanceof Map) || !(sources instanceof Map)) {
    throw new Error('parseInfluenceAssessment requires the refToId and sources maps from buildAnalystContext.');
  }
  let data;
  try {
    data = JSON.parse(String(content ?? '').trim());
  } catch {
    fail('not valid JSON');
  }
  // Every field is type-checked before use: a value of the wrong shape fails the whole
  // response instead of being coerced into something the model didn't say.
  const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const optionalText = (value, what, max) => {
    if (value == null) return '';
    if (typeof value !== 'string') fail(`${what} is not text`);
    return clip(normalizeName(value), max);
  };
  const requiredText = (value, what, max) => {
    const text = optionalText(value, what, max);
    if (!text) fail(`missing ${what}`);
    return text;
  };
  const list = (value, what) => {
    if (value == null) return [];
    if (!Array.isArray(value)) fail(`${what} is not a list`);
    return value;
  };
  const choice = (value, allowed) => {
    const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return allowed.includes(key) ? key : null;
  };
  if (!isObject(data)) fail('not a JSON object');
  if (!Array.isArray(data.people)) fail('"people" is not a list');
  const sourceFor = (value, ref) => {
    if (typeof value !== 'string') fail(`a source reference for ${ref} is not text`);
    const key = value.trim();
    const source = sources.get(key);
    if (!source) fail(`unknown source "${clip(key, 20)}" for ${ref}`);
    return source;
  };
  const seen = new Set();
  const people = [];
  for (const item of data.people) {
    if (!isObject(item)) fail('a person entry is not an object');
    if (typeof item.personRef !== 'string') fail('a person reference is not text');
    const ref = item.personRef.trim();
    if (!refToId.has(ref)) fail(`unknown person "${clip(ref, 20)}"`);
    if (seen.has(ref)) fail(`duplicate person ${ref}`);
    seen.add(ref);
    const stance = choice(item.stance, STANCES);
    if (!stance) fail(`invalid stance for ${ref}`);
    const confidence = choice(item.confidence, CONFIDENCES);
    if (!confidence) fail(`invalid confidence for ${ref}`);
    const decisionRole = optionalText(item.decisionRole, `decisionRole for ${ref}`, 120) || null;
    const reason = requiredText(item.reason, `reason for ${ref}`, 600);
    // Every entry is validated before the first five of each are kept.
    const evidence = list(item.evidence, `evidence for ${ref}`).map((entry) => {
      if (!isObject(entry)) fail(`an evidence entry for ${ref} is not an object`);
      const source = sourceFor(entry.sourceRef, ref);
      const quote = optionalText(entry.quote, `an evidence quote for ${ref}`, 400);
      return { source: publicSource(source), quote, verified: verifyQuote(quote, source.text) };
    }).slice(0, 5);
    const adoptedSuggestions = list(item.adoptedSuggestions, `adoptedSuggestions for ${ref}`).map((entry) => {
      if (!isObject(entry)) fail(`an adopted suggestion for ${ref} is not an object`);
      const suggestion = requiredText(entry.suggestion, `adopted suggestion text for ${ref}`, 300);
      const refs = list(entry.sourceRefs, `sourceRefs for ${ref}`);
      if (!refs.length) fail(`adopted suggestion without sources for ${ref}`);
      const matched = [...new Set(refs.map((value) => sourceFor(value, ref)))];
      const quote = optionalText(entry.quote, `an adopted suggestion quote for ${ref}`, 400);
      return {
        suggestion,
        adoptedAs: optionalText(entry.adoptedAs, `adoptedAs for ${ref}`, 300),
        sources: matched.map(publicSource),
        quote,
        verified: matched.some((source) => verifyQuote(quote, source.text)),
      };
    }).slice(0, 5);
    people.push({
      personId: refToId.get(ref),
      stance,
      confidence,
      decisionRole,
      reason,
      evidence,
      adoptedSuggestions,
    });
  }
  const caveats = list(data.caveats, '"caveats"')
    .map((caveat) => {
      if (typeof caveat !== 'string') fail('a caveat is not text');
      return clip(normalizeName(caveat), 300);
    })
    .filter(Boolean)
    .slice(0, 10);
  return { version: ANALYST_VERSION, people, caveats };
}

function storedAiPerson(item) {
  if (!item || typeof item !== 'object' || typeof item.personId !== 'string') return null;
  if (!STANCES.includes(item.stance) || !CONFIDENCES.includes(item.confidence)) return null;
  const objects = (value) => (Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object') : []);
  return {
    stance: item.stance,
    confidence: item.confidence,
    decisionRole: typeof item.decisionRole === 'string' && item.decisionRole ? item.decisionRole : null,
    reason: String(item.reason || ''),
    evidence: objects(item.evidence).filter((entry) => entry.source && typeof entry.source === 'object'),
    adoptedSuggestions: objects(item.adoptedSuggestions).map((entry) => ({ ...entry, sources: objects(entry.sources) })),
  };
}

function readAssessment(stored, analysis, overrides, accountName) {
  if (!stored) return null;
  const base = { provider: stored.provider || null, model: stored.model || null, analyzedAt: stored.analyzedAt || null };
  const result = stored.result;
  if (!result || typeof result !== 'object' || !Array.isArray(result.people)) {
    return { public: { ...base, stale: false, caveats: [], error: UNREADABLE_ASSESSMENT }, byId: new Map() };
  }
  if (result.version !== ANALYST_VERSION) {
    return { public: { ...base, stale: false, caveats: [], error: OUTDATED_ASSESSMENT }, byId: new Map() };
  }
  const { context } = contextFromAnalysis(analysis, overrides, accountName);
  const byId = new Map();
  for (const item of result.people) {
    const person = storedAiPerson(item);
    if (!person || overrides.get(item.personId)?.hidden) continue;
    byId.set(item.personId, person);
  }
  const caveats = Array.isArray(result.caveats) ? result.caveats.filter((caveat) => typeof caveat === 'string') : [];
  return { public: { ...base, stale: hashAnalystContext(context) !== stored.inputHash, caveats }, byId };
}

function compareEvidence(a, b) {
  return compareDesc(a.date, b.date) || `${a.kind}:${a.id}:${a.role}`.localeCompare(`${b.kind}:${b.id}:${b.role}`);
}

// Most shared first. Read at output time so late name and address upgrades are shown.
function microsoftContacts(profile) {
  return [...profile.microsoft.values()]
    .map(({ entry, threads, meetings }) => ({
      id: entry.id,
      name: entry.name,
      email: entry.email || null,
      emailThreads: threads.size,
      meetings: meetings.size,
      shared: threads.size + meetings.size,
    }))
    .sort((a, b) => b.shared - a.shared
      || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
      || a.id.localeCompare(b.id));
}

function personOut(row, analysis, overrides, aiById) {
  const { entry } = row.profile;
  const override = overrides.get(entry.id) || null;
  const ai = aiById.get(entry.id) || null;
  const evidence = [...row.profile.evidence].sort(compareEvidence);
  const microsoft = microsoftContacts(row.profile);
  const components = {};
  for (const [key, value] of Object.entries(row.components)) components[key] = value == null ? null : round3(value);
  return {
    id: entry.id,
    name: entry.name,
    title: entry.title,
    affiliation: analysis.resolver.affiliationOf(entry),
    email: entry.email || null,
    score: row.score,
    components,
    signals: signalsOf(row),
    tags: row.tags,
    hiddenInfluencer: row.hiddenInfluencer,
    inbound: round3(row.inbound),
    outbound: round3(row.outbound),
    scoreBasis: row.covered ? 'with-transcripts' : 'no-transcripts',
    stance: override?.stance || ai?.stance || null,
    stanceSource: override?.stance ? 'you' : (ai ? 'ai' : null),
    override: override ? { stance: override.stance, note: override.note } : null,
    ai,
    evidence: evidence.slice(0, EVIDENCE_CAP),
    evidenceTotal: evidence.length,
    microsoft: microsoft.slice(0, MICROSOFT_CAP),
    microsoftTotal: microsoft.length,
  };
}

function buildInfluenceMap(inputs = {}) {
  const analysis = analyze(inputs);
  const overrides = overrideMap(inputs.overrides);
  const assessment = readAssessment(inputs.assessment, analysis, overrides, inputs.accountName);
  const aiById = assessment?.byId || new Map();
  const visible = visibleRows(analysis, overrides);
  const people = visible.slice(0, MAX_PEOPLE).map((row) => personOut(row, analysis, overrides, aiById));
  const nodes = people.slice(0, MAX_NODES);
  const nodeIds = new Set(nodes.map((person) => person.id));
  const edges = [...analysis.state.edges.values()]
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => ({ ...edge, total: edge.email + edge.meeting + 2 * edge.transcript }))
    .sort((a, b) => b.total - a.total || a.source.localeCompare(b.source) || a.target.localeCompare(b.target))
    .slice(0, MAX_EDGES);
  const hiddenPeople = [];
  for (const [id, override] of overrides) {
    if (!override.hidden) continue;
    const profile = analysis.state.profiles.get(id);
    hiddenPeople.push(profile
      ? { id, name: profile.entry.name, affiliation: analysis.resolver.affiliationOf(profile.entry) }
      : { id, name: id, affiliation: null });
  }
  hiddenPeople.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id));
  return {
    account: normalizeName(inputs.accountName) || null,
    people,
    totalPeople: visible.length,
    hiddenPeople,
    map: {
      nodes: nodes.map((person) => ({
        id: person.id,
        name: person.name,
        affiliation: person.affiliation,
        score: person.score,
        stance: person.stance,
        hiddenInfluencer: person.hiddenInfluencer,
      })),
      edges,
    },
    sources: { ...analysis.state.sources },
    weights: { ...WEIGHTS },
    assessment: assessment ? assessment.public : null,
  };
}

// Ids a stance/note/exclude override may target: everyone profiled, plus existing overrides.
function profiledPersonIds(inputs = {}) {
  const ids = new Set();
  for (const [id, profile] of analyze(inputs).state.profiles) {
    if (!profile.entry.internal) ids.add(id);
  }
  for (const item of inputs.overrides || []) {
    if (item?.personId) ids.add(String(item.personId));
  }
  return ids;
}

module.exports = {
  ANALYST_VERSION,
  CONFIDENCES,
  STANCES,
  TAG_LABELS,
  WEIGHTS,
  buildAnalystContext,
  buildInfluenceMap,
  hashAnalystContext,
  nameVariants,
  parseInfluenceAssessment,
  parseTurns,
  profiledPersonIds,
  stripQuotedHistory,
  verifyQuote,
};
