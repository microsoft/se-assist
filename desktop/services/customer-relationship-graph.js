'use strict';

const INTERNAL_DOMAINS = new Set(['microsoft.com', 'microsoftsupport.com']);

// A relationship map is meant to show focused, person-to-person contact. A single
// broadcast — an all-hands invite, a big distribution-list email, a large Teams
// space — would otherwise fan out combinatorially (every internal attendee ×
// every external attendee), pulling in hundreds of people who have no real
// relationship with the account and blanking the diagram. Any single event with
// more than this many resolved participants on either side is treated as a
// broadcast and skipped.
const BROADCAST_MAX_PER_SIDE = 12;

// Safety cap on how many people are returned per side for rendering, ranked by
// interaction volume. Keeps the SVG a sane height even if a territory genuinely
// has many contacts; the summary still reports the true totals.
const MAX_NODES_PER_SIDE = 50;

// Per-person activity lists (the emails/meetings/chats shown when a contact is
// opened) are capped so a chatty account can't return an unbounded payload. The
// most recent items are kept; `details[id].eventTotal` reports the true count.
const MAX_EVENTS_PER_PERSON = 60;

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

// Shared classification so every surface agrees on who counts as "Microsoft".
function isInternalEmail(email) {
  const domain = emailDomain(email);
  if (!domain) return false;
  return INTERNAL_DOMAINS.has(domain) || domain.endsWith('.microsoft.com');
}

function participantFrom(value, fallbackName = '') {
  if (!value && !fallbackName) return null;
  if (typeof value === 'string') {
    const email = normalizeEmail(value);
    return { name: email ? fallbackName || email.split('@')[0] : value, email };
  }
  const emailAddress = value?.emailAddress || value?.user?.emailAddress || {};
  const email = normalizeEmail(
    value?.address || value?.email || value?.mail || value?.userPrincipalName
      || emailAddress?.address || emailAddress?.email,
  );
  const name = normalizeName(
    value?.name || value?.displayName || value?.user?.displayName
      || emailAddress?.name || fallbackName || (email ? email.split('@')[0] : ''),
  );
  if (!name && !email) return null;
  return { name, email };
}

function participantList(value) {
  const parsed = safeJson(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => participantFrom(item)).filter(Boolean);
}

function collectTeamsMembers(raw) {
  const parsed = safeJson(raw, {});
  const candidates = [
    parsed?.members,
    parsed?.participants,
    parsed?.value?.members,
    parsed?.chat?.members,
  ].find(Array.isArray) || [];
  return candidates.map((item) => participantFrom(item)).filter(Boolean);
}

function buildCustomerRelationshipGraph({
  teamRows = [],
  emailRows = [],
  meetingRows = [],
  teamsRows = [],
  broadcastMaxPerSide = BROADCAST_MAX_PER_SIDE,
  maxNodesPerSide = MAX_NODES_PER_SIDE,
} = {}) {
  const knownByEmail = new Map();
  const knownByName = new Map();
  const nodes = new Map();
  const edges = new Map();

  for (const row of teamRows) {
    const participant = participantFrom({
      name: row.person_name,
      email: row.person_email,
    });
    if (!participant) continue;
    const org = String(row.org || '').toLowerCase();
    const type = org === 'microsoft' || isInternalEmail(participant.email)
      ? 'internal'
      : (org === 'customer' || org === 'partner' ? 'external' : 'unknown');
    const known = { ...participant, type };
    if (participant.email) knownByEmail.set(participant.email, known);
    if (participant.name) knownByName.set(nameKey(participant.name), known);
  }

  function resolveParticipant(value, fallbackName = '') {
    const participant = participantFrom(value, fallbackName);
    if (!participant) return null;
    const known = (participant.email && knownByEmail.get(participant.email))
      || (participant.name && knownByName.get(nameKey(participant.name)));
    const email = participant.email || known?.email || '';
    // Mail headers often carry no display name, in which case participantFrom falls
    // back to the address local-part ("agoffar"). When the account team knows this
    // person's real name, prefer it — the map labels every node, so an alias would
    // make the diagram unreadable.
    const localPart = email ? email.split('@')[0] : '';
    const nameIsAlias = Boolean(participant.name)
      && Boolean(localPart)
      && participant.name.toLowerCase() === localPart.toLowerCase();
    const name = (nameIsAlias ? (known?.name || participant.name) : participant.name)
      || known?.name || localPart || 'Unknown';
    let type = known?.type || 'unknown';
    if (isInternalEmail(email)) type = 'internal';
    if (type === 'unknown' && email) type = 'external';
    if (type === 'unknown') return null;
    const id = email || `name:${nameKey(name)}`;
    if (!nodes.has(id)) {
      nodes.set(id, { id, name, email: email || null, type, interactions: 0 });
    }
    const node = nodes.get(id);
    // A later, better-named sighting of the same person upgrades the label.
    if (node.name !== name && (node.name === localPart || node.name === 'Unknown')) {
      node.name = name;
    }
    return node;
  }

  // ── Event model ─────────────────────────────────────────────────────────────
  // Every email, meeting and chat becomes ONE event carrying its resolved internal
  // and external participants. Both views are then derived from co-participation in
  // that single list: customer↔customer edges (the web diagram) and customer↔Microsoft
  // bridges (each contact's Microsoft count / list). Deriving both from one source
  // keeps them consistent and lets every connection be explained by real items.
  const events = [];

  // Count distinct people of one type; used to spot broadcasts (all-hands
  // invites, big DLs, large Teams spaces) that shouldn't seed relationships.
  function distinctCount(participants, type) {
    const ids = new Set();
    for (const participant of participants) {
      if (participant && participant.type === type) ids.add(participant.id);
    }
    return ids.size;
  }
  function isBroadcast(participants) {
    return distinctCount(participants, 'internal') > broadcastMaxPerSide
      || distinctCount(participants, 'external') > broadcastMaxPerSide;
  }

  // Record one interaction. Participants are de-duplicated by resolved identity, so
  // a person on both the To and Cc line counts once. Broadcasts are dropped, as is
  // anything that carries no cross-company or customer-to-customer signal.
  function addEvent({ id, kind, title, date, url, participants }) {
    const byId = new Map();
    for (const participant of participants) {
      if (participant) byId.set(participant.id, participant);
    }
    const resolved = Array.from(byId.values());
    if (!resolved.length || isBroadcast(resolved)) return;
    const internalIds = resolved.filter((p) => p.type === 'internal').map((p) => p.id);
    const externalIds = resolved.filter((p) => p.type === 'external').map((p) => p.id);
    // The map is about customer people. An item with no customer participant says
    // nothing here; a customer-only item still evidences a customer↔customer tie.
    if (!externalIds.length) return;
    if (!internalIds.length && externalIds.length < 2) return;
    events.push({
      id: id || `${kind}:${events.length}`,
      kind,
      title: title || '',
      date: date || null,
      url: url || null,
      internalIds,
      externalIds,
    });
  }

  for (const row of emailRows) {
    const sender = resolveParticipant({
      name: row.from_name,
      email: row.from_address,
    });
    const recipients = [
      ...participantList(row.to_json),
      ...participantList(row.cc_json),
    ].map((value) => resolveParticipant(value)).filter(Boolean);
    addEvent({
      id: row.message_id ? `email:${row.message_id}` : null,
      kind: 'email',
      title: row.subject,
      date: row.received_at || row.sent_at,
      url: row.web_link,
      participants: [sender, ...recipients],
    });
  }

  for (const row of meetingRows) {
    const participants = [
      participantFrom({
        name: row.organizer_name,
        email: row.organizer_address,
      }),
      ...participantList(row.attendees_json),
    ].filter(Boolean);
    addEvent({
      id: row.event_id ? `meeting:${row.event_id}` : null,
      kind: 'meeting',
      title: row.subject,
      date: row.start_at,
      url: row.web_link,
      participants: participants.map((participant) => resolveParticipant(participant)).filter(Boolean),
    });
  }

  const chats = new Map();
  for (const row of teamsRows) {
    if (!chats.has(row.chat_id)) {
      chats.set(row.chat_id, {
        id: row.chat_id,
        topic: row.topic || null,
        lastActivity: row.last_message_at || null,
        members: collectTeamsMembers(row.chat_raw_json),
        messages: [],
      });
    }
    const chat = chats.get(row.chat_id);
    if (!chat.topic && row.topic) chat.topic = row.topic;
    if (row.sender_name || row.sender_id) {
      chat.messages.push({
        participant: participantFrom(
          safeJson(row.message_raw_json, {})?.from || {
            name: row.sender_name,
            email: row.sender_id,
          },
          row.sender_name,
        ),
        sentAt: row.sent_at,
      });
    }
  }

  for (const chat of chats.values()) {
    const participants = [
      ...chat.members,
      ...chat.messages.map((message) => message.participant),
    ].map((participant) => resolveParticipant(participant)).filter(Boolean);
    const lastMessageAt = chat.messages.reduce(
      (latest, message) => (message.sentAt && (!latest || message.sentAt > latest) ? message.sentAt : latest),
      null,
    );
    addEvent({
      id: chat.id ? `chat:${chat.id}` : null,
      kind: 'teams',
      title: chat.topic || 'Teams chat',
      date: chat.lastActivity || lastMessageAt,
      participants,
    });
  }

  // ── Derive the two views from the event list ────────────────────────────────
  const eventsByPerson = new Map();      // personId -> event[]
  const bridgeCounts = new Map();        // externalId -> Map(internalId -> shared events)
  const internalBridgeCounts = new Map(); // internalId -> Map(externalId -> shared events)

  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  const applyEvent = (edge, event) => {
    if (event.kind === 'email') edge.emailCount += 1;
    if (event.kind === 'meeting') edge.meetingCount += 1;
    if (event.kind === 'teams') edge.teamsCount += 1;
    edge.total += 1;
    if (event.date && (!edge.lastActivity || event.date > edge.lastActivity)) {
      edge.lastActivity = event.date;
    }
  };

  for (const event of events) {
    for (const id of [...event.internalIds, ...event.externalIds]) {
      if (!eventsByPerson.has(id)) eventsByPerson.set(id, []);
      eventsByPerson.get(id).push(event);
      const node = nodes.get(id);
      if (node) node.interactions += 1;
    }

    // Customer ↔ customer: every pair of customer people on the same item.
    for (let i = 0; i < event.externalIds.length; i += 1) {
      for (let j = i + 1; j < event.externalIds.length; j += 1) {
        const [a, b] = [event.externalIds[i], event.externalIds[j]].sort();
        const key = `${a}|${b}`;
        if (!edges.has(key)) {
          edges.set(key, {
            id: key,
            source: a,
            target: b,
            emailCount: 0,
            meetingCount: 0,
            teamsCount: 0,
            total: 0,
            lastActivity: null,
          });
        }
        applyEvent(edges.get(key), event);
      }
    }

    // Customer ↔ Microsoft: the bridge counts behind each contact's badge.
    for (const externalId of event.externalIds) {
      if (!bridgeCounts.has(externalId)) bridgeCounts.set(externalId, new Map());
      for (const internalId of event.internalIds) {
        bump(bridgeCounts.get(externalId), internalId);
        if (!internalBridgeCounts.has(internalId)) internalBridgeCounts.set(internalId, new Map());
        bump(internalBridgeCounts.get(internalId), externalId);
      }
    }
  }

  const projectPerson = (id, sharedEvents) => {
    const node = nodes.get(id);
    if (!node) return null;
    return {
      id: node.id,
      name: node.name,
      email: node.email,
      type: node.type,
      sharedEvents,
    };
  };

  const rankedPeers = (map) => Array.from(map.entries())
    .map(([id, shared]) => projectPerson(id, shared))
    .filter(Boolean)
    .sort((a, b) => b.sharedEvents - a.sharedEvents || a.name.localeCompare(b.name));

  // Everyone who appeared on at least one qualifying item.
  const participatingIds = new Set(eventsByPerson.keys());
  const connectedNodes = Array.from(nodes.values())
    .filter((node) => participatingIds.has(node.id))
    .sort((a, b) => b.interactions - a.interactions || a.name.localeCompare(b.name));
  const internalConnected = connectedNodes.filter((node) => node.type === 'internal');
  const externalConnected = connectedNodes.filter((node) => node.type === 'external');

  // The web diagram renders customer people only; cap it so the layout stays
  // legible. The summary still reports the true totals (with `*Shown` and a
  // `truncated` flag) so the legend can be honest about any capping.
  const keptExternal = externalConnected.slice(0, maxNodesPerSide);
  const keptExternalIds = new Set(keptExternal.map((node) => node.id));

  const keptEdges = Array.from(edges.values())
    .filter((edge) => keptExternalIds.has(edge.source) && keptExternalIds.has(edge.target))
    .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));

  // Customer peers per contact, derived from the rendered customer↔customer edges.
  const peerCounts = new Map();
  for (const edge of keptEdges) {
    if (!peerCounts.has(edge.source)) peerCounts.set(edge.source, new Map());
    if (!peerCounts.has(edge.target)) peerCounts.set(edge.target, new Map());
    peerCounts.get(edge.source).set(edge.target, edge.total);
    peerCounts.get(edge.target).set(edge.source, edge.total);
  }

  const referencedEvents = new Map();
  const details = {};
  for (const node of keptExternal) {
    const personEvents = (eventsByPerson.get(node.id) || [])
      .slice()
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const shownEvents = personEvents.slice(0, MAX_EVENTS_PER_PERSON);
    for (const event of shownEvents) referencedEvents.set(event.id, event);
    const microsoft = rankedPeers(bridgeCounts.get(node.id) || new Map());
    const customers = rankedPeers(peerCounts.get(node.id) || new Map());
    details[node.id] = {
      microsoft,
      customers,
      eventIds: shownEvents.map((event) => event.id),
      eventTotal: personEvents.length,
    };
    // Surfaced on the node so the diagram can badge it without a details lookup.
    node.microsoftCount = microsoft.length;
    node.customerCount = customers.length;
  }

  return {
    nodes: keptExternal,
    edges: keptEdges,
    details,
    events: Array.from(referencedEvents.values()).map((event) => ({
      id: event.id,
      kind: event.kind,
      title: event.title,
      date: event.date,
      url: event.url,
    })),
    summary: {
      internalPeople: internalConnected.length,
      externalPeople: externalConnected.length,
      externalShown: keptExternal.length,
      truncated: keptExternal.length < externalConnected.length,
      customerConnections: keptEdges.length,
      interactions: events.length,
    },
  };
}

module.exports = {
  buildCustomerRelationshipGraph,
  participantFrom,
  participantList,
  collectTeamsMembers,
  isInternalEmail,
};
