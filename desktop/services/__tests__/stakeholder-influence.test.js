'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ANALYST_VERSION,
  buildAnalystContext,
  buildInfluenceMap,
  hashAnalystContext,
  nameVariants,
  parseInfluenceAssessment,
  parseTurns,
  profiledPersonIds,
  stripQuotedHistory,
  verifyQuote,
} = require('../stakeholder-influence');

const MINA = { name: 'Mina Internal', address: 'mina@microsoft.com' };
const ADA = { name: 'Ada Customer', address: 'ada@contoso.com' };
const BOB = { name: 'Bob Buyer', address: 'bob@contoso.com' };
const CAROL = { name: 'Carol Contoso', address: 'carol@contoso.com' };
const DANA = { name: 'Dana Partner', address: 'dana@fabrikam.com' };

const TEAM = [{ person_name: MINA.name, person_email: MINA.address, org: 'microsoft' }];
const CONTACTS = [
  { full_name: ADA.name, job_title: 'CIO', email: ADA.address },
  { full_name: BOB.name, job_title: 'Procurement Lead', email: BOB.address },
];

const EMAIL_PATTERN = /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/i;

let sequence = 0;

function day(n) {
  return `2026-01-${String(n).padStart(2, '0')}T10:00:00Z`;
}

function email({
  id, thread, from, to = [], cc = [], at = day(1), subject = 'Fabric migration', body = '', internetId = null, link = null,
}) {
  sequence += 1;
  const messageId = id || `msg-${sequence}`;
  return {
    message_id: messageId,
    conversation_id: thread || `thread-${messageId}`,
    internet_message_id: internetId,
    subject,
    from_name: from.name,
    from_address: from.address,
    to_json: JSON.stringify(to),
    cc_json: JSON.stringify(cc),
    sent_at: at,
    received_at: at,
    body_text: body,
    web_link: link,
  };
}

function attendee(person, { type = 'required', response = 'accepted' } = {}) {
  return { emailAddress: { name: person.name, address: person.address }, type, status: { response } };
}

function meeting({
  id, organizer, attendees = [], at = day(1), subject = 'Architecture review', cancelled = false, link = null,
}) {
  return {
    event_id: id,
    subject,
    organizer_name: organizer?.name || null,
    organizer_address: organizer?.address || null,
    attendees_json: JSON.stringify(attendees.map((item) => (item.emailAddress ? item : attendee(item)))),
    start_at: at,
    is_cancelled: cancelled ? 1 : 0,
    web_link: link,
  };
}

function inputs(extra = {}) {
  return {
    accountName: 'Contoso',
    team: TEAM,
    contacts: CONTACTS,
    emails: [],
    meetings: [],
    transcripts: [],
    overrides: [],
    ...extra,
  };
}

function byName(map, name) {
  return map.people.find((person) => person.name === name);
}

function tagIds(person) {
  return person.tags.map((tag) => tag.id).sort();
}

// An account with an email thread, a meeting and its transcript, used by the AI tests.
function analysisInputs(extra = {}) {
  return inputs({
    emails: [
      email({
        id: 'e1',
        thread: 'budget',
        from: ADA,
        to: [BOB],
        cc: [MINA],
        at: day(1),
        subject: 'Budget for Fabric',
        body: 'We will fund the Fabric pilot from the Q3 budget. Contact me at ada@contoso.com.\n\nFrom: Bob Buyer\nSent: Monday\nOld quoted text about bob@contoso.com',
      }),
      email({
        id: 'e2',
        thread: 'budget',
        from: BOB,
        to: [ADA],
        at: day(2),
        subject: 'RE: Budget for Fabric',
        body: 'Procurement needs the security review before signing.',
      }),
    ],
    meetings: [meeting({ id: 'arch', organizer: ADA, attendees: [BOB, MINA], at: day(3) })],
    transcripts: [{
      event_id: 'arch',
      transcript: [
        'Ada Customer: I want the pilot live before the board meeting',
        'Bob Buyer: I cannot approve spend until security signs off',
        'Mina Internal: I will schedule the security review',
      ].join('\n'),
    }],
    ...extra,
  });
}

function modelReply(context) {
  const ref = (name) => context.people.find((person) => person.name === name).ref;
  const transcript = context.transcripts[0].ref;
  return JSON.stringify({
    people: [
      {
        personRef: ref(ADA.name),
        stance: 'champion',
        confidence: 'high',
        decisionRole: 'Budget owner',
        reason: 'Pushes for the pilot and funds it.',
        evidence: [{ sourceRef: transcript, quote: 'I want the pilot live before the board meeting' }],
        adoptedSuggestions: [],
      },
      {
        personRef: ref(BOB.name),
        stance: 'blocker',
        confidence: 'medium',
        decisionRole: 'Procurement',
        reason: 'Holds spend until security signs off.',
        evidence: [{ sourceRef: transcript, quote: 'I will approve spend immediately' }],
        adoptedSuggestions: [{
          suggestion: 'Run the security review before spending',
          adoptedAs: 'Microsoft scheduled the security review',
          sourceRefs: [transcript],
          quote: 'I will schedule the security review',
        }],
      },
    ],
    caveats: ['Only one meeting transcript.'],
  });
}

test('Microsoft people are never profiled and affiliation comes from CRM contacts and their domains', () => {
  const PAUL = { name: 'Paul Reseller', address: 'paul@contoso.com' };
  const EVE = { name: 'Eve Personal', address: 'eve@gmail.com' };
  const FRANK = { name: 'Frank Freelance', address: 'frank@gmail.com' };
  const map = buildInfluenceMap(inputs({
    team: [
      ...TEAM,
      // The account team's customer / partner split is a heuristic and is not trusted.
      { person_name: PAUL.name, person_email: PAUL.address, org: 'partner' },
      { person_name: DANA.name, person_email: DANA.address, org: 'customer' },
    ],
    contacts: [...CONTACTS, { full_name: EVE.name, job_title: null, email: EVE.address }],
    emails: [email({ from: MINA, to: [ADA, CAROL, PAUL, DANA, EVE, FRANK] })],
  }));
  assert.equal(byName(map, MINA.name), undefined);
  assert.deepEqual(Object.fromEntries(map.people.map((person) => [person.name, person.affiliation])), {
    'Ada Customer': 'customer',
    'Carol Contoso': 'customer',
    'Paul Reseller': 'customer',
    'Dana Partner': 'external',
    'Eve Personal': 'customer',
    'Frank Freelance': 'external',
  });
  assert.equal(byName(map, ADA.name).title, 'CIO');
});

test('a name shared with a Microsoft employee is not merged into a customer contact', () => {
  const map = buildInfluenceMap(inputs({
    contacts: [...CONTACTS, { full_name: 'Alex Kim', job_title: 'Architect', email: null }],
    emails: [email({ from: { name: 'Alex Kim', address: 'alex.kim@microsoft.com' }, to: [ADA] })],
  }));
  assert.deepEqual(map.people.map((person) => person.name), [ADA.name]);
});

test('copies of the same message are counted once and the copy with a link is kept', () => {
  const first = email({ id: 'copy-a', thread: 't-dup', from: ADA, to: [BOB], internetId: '<abc@contoso.com>', body: 'Short' });
  const second = { ...first, message_id: 'copy-b', web_link: 'https://outlook.office.com/mail/copy-b' };
  const map = buildInfluenceMap(inputs({ emails: [first, second] }));
  assert.equal(map.sources.emails, 1);
  assert.equal(map.sources.duplicateEmails, 1);
  const ada = byName(map, ADA.name);
  assert.equal(ada.signals.sent, 1);
  assert.equal(ada.evidenceTotal, 1);
  assert.equal(ada.evidence[0].webLink, 'https://outlook.office.com/mail/copy-b');
});

test('broadcast email, broadcast meetings and cancelled meetings do not count as influence', () => {
  const crowd = Array.from({ length: 21 }, (_, index) => ({
    name: `Crowd ${index + 1}`,
    address: `crowd${index + 1}@contoso.com`,
  }));
  const map = buildInfluenceMap(inputs({
    emails: [email({ from: ADA, to: crowd })],
    meetings: [
      meeting({ id: 'town-hall', organizer: ADA, attendees: crowd }),
      meeting({ id: 'called-off', organizer: ADA, attendees: [BOB], cancelled: true }),
    ],
  }));
  assert.equal(map.sources.broadcastEmails, 1);
  assert.equal(map.sources.broadcastMeetings, 1);
  assert.equal(map.sources.cancelledMeetings, 1);
  assert.equal(map.sources.meetings, 1);
  assert.deepEqual(map.people, []);
});

test('each person lists the Microsoft people on the same emails and meetings, once per thread or meeting', () => {
  const OMAR = { name: 'Omar Specialist', address: 'omar@microsoft.com' };
  const PIA = { name: 'Pia Architect', address: 'pia@microsoft.com' };
  const map = buildInfluenceMap(inputs({
    emails: [
      email({ id: 'b1', thread: 'budget', from: ADA, to: [MINA], cc: [BOB], at: day(1) }),
      email({ id: 'b2', thread: 'budget', from: MINA, to: [ADA], at: day(2) }),
      email({ id: 'o1', thread: 'sizing', from: OMAR, to: [ADA], at: day(3) }),
      email({ id: 'c1', thread: 'customers-only', from: ADA, to: [BOB], at: day(4) }),
    ],
    meetings: [
      meeting({ id: 'review', organizer: MINA, attendees: [ADA, BOB], at: day(5) }),
      meeting({ id: 'ada-declined', organizer: PIA, attendees: [attendee(ADA, { response: 'declined' })], at: day(6) }),
      meeting({ id: 'pia-declined', organizer: ADA, attendees: [attendee(PIA, { response: 'declined' })], at: day(7) }),
    ],
  }));
  assert.deepEqual(byName(map, ADA.name).microsoft, [
    { id: MINA.address, name: MINA.name, email: MINA.address, emailThreads: 1, meetings: 1, shared: 2 },
    { id: OMAR.address, name: OMAR.name, email: OMAR.address, emailThreads: 1, meetings: 0, shared: 1 },
  ]);
  assert.equal(byName(map, ADA.name).microsoftTotal, 2);
  assert.deepEqual(byName(map, BOB.name).microsoft, [
    { id: MINA.address, name: MINA.name, email: MINA.address, emailThreads: 1, meetings: 1, shared: 2 },
  ]);
  assert.deepEqual(map.people.map((person) => person.name).sort(), [ADA.name, BOB.name]);
  assert.ok(map.map.nodes.every((node) => !('microsoft' in node)));
});

test('broadcasts and cancelled meetings add no Microsoft contacts, but a transcript speaker was present', () => {
  const QUINN = { name: 'Quinn Engineer', address: 'quinn@microsoft.com' };
  const crowd = Array.from({ length: 20 }, (_, index) => ({
    name: `Crowd ${index + 1}`,
    address: `crowd${index + 1}@contoso.com`,
  }));
  const map = buildInfluenceMap(inputs({
    team: [...TEAM, { person_name: QUINN.name, person_email: QUINN.address, org: 'microsoft' }],
    emails: [email({ from: ADA, to: [MINA, ...crowd] })],
    meetings: [
      meeting({ id: 'called-off', organizer: MINA, attendees: [ADA], cancelled: true }),
      meeting({ id: 'workshop', organizer: ADA, attendees: [BOB], at: day(2) }),
    ],
    transcripts: [{
      event_id: 'workshop',
      transcript: ['Ada Customer: Walk us through the design', 'Quinn Engineer: Here is the plan'].join('\n'),
    }],
  }));
  assert.equal(map.sources.broadcastEmails, 1);
  assert.equal(map.sources.cancelledMeetings, 1);
  const quinn = { id: QUINN.address, name: QUINN.name, email: QUINN.address, emailThreads: 0, meetings: 1, shared: 1 };
  assert.deepEqual(byName(map, ADA.name).microsoft, [quinn]);
  assert.deepEqual(byName(map, BOB.name).microsoft, [quinn]);
});

test('Microsoft contacts are capped, most shared first and then by name', () => {
  const colleagues = Array.from({ length: 40 }, (_, index) => ({
    name: `Colleague ${String(index + 1).padStart(2, '0')}`,
    address: `colleague${index + 1}@microsoft.com`,
  }));
  const map = buildInfluenceMap(inputs({
    emails: [
      email({ thread: 'first', from: ADA, to: colleagues.slice(0, 20) }),
      email({ thread: 'second', from: ADA, to: colleagues.slice(20) }),
      email({ thread: 'third', from: ADA, to: [colleagues[39]] }),
    ],
  }));
  const ada = byName(map, ADA.name);
  assert.equal(ada.microsoftTotal, 40);
  assert.equal(ada.microsoft.length, 30);
  assert.deepEqual(
    ada.microsoft.slice(0, 4).map((contact) => [contact.name, contact.shared]),
    [['Colleague 40', 2], ['Colleague 01', 1], ['Colleague 02', 1], ['Colleague 03', 1]],
  );
  assert.deepEqual(map.people.map((person) => person.name), [ADA.name]);
});

test('people pulled into a running thread are recorded as looped in mid-thread', () => {
  const map = buildInfluenceMap(inputs({
    emails: [
      email({ id: 'm1', thread: 't1', from: ADA, to: [BOB], at: day(1) }),
      email({ id: 'm2', thread: 't1', from: BOB, to: [ADA], cc: [CAROL], at: day(2) }),
      email({ id: 'm3', thread: 't1', from: ADA, to: [BOB], cc: [CAROL], at: day(3) }),
    ],
  }));
  const carol = byName(map, CAROL.name);
  assert.equal(carol.signals.addedMidThread, 1);
  assert.equal(carol.signals.loopedInBy, 2);
  assert.equal(carol.signals.cc, 2);
  assert.deepEqual(carol.evidence.map((item) => item.note), ['', 'Added mid-thread']);
  const ada = byName(map, ADA.name);
  assert.equal(ada.signals.sent, 2);
  assert.equal(ada.signals.threadsStarted, 1);
  assert.equal(byName(map, BOB.name).signals.addedMidThread, 0);
  assert.equal(map.sources.emailThreads, 1);
});

test('transcript turns measure word share and who speaks next', () => {
  const map = buildInfluenceMap(inputs({
    meetings: [meeting({ id: 'ev1', organizer: ADA, attendees: [BOB, MINA] })],
    transcripts: [{
      event_id: 'ev1',
      transcript: [
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:04.000',
        '<v Ada Customer>one two three four</v>',
        '',
        '00:00:05.000 --> 00:00:06.000',
        '<v Bob Buyer>five six</v>',
        '',
        '00:00:07.000 --> 00:00:09.000',
        '<v Mina Internal>seven eight nine ten</v>',
      ].join('\n'),
    }],
  }));
  assert.equal(map.sources.transcripts, 1);
  assert.equal(map.sources.transcriptTurns, 3);
  assert.equal(map.sources.unresolvedSpeakers, 0);
  const ada = byName(map, ADA.name);
  const bob = byName(map, BOB.name);
  assert.equal(ada.signals.words, 4);
  assert.equal(ada.signals.wordShare, 0.4);
  assert.equal(ada.signals.responsesDrawn, 1);
  assert.equal(bob.signals.wordShare, 0.2);
  assert.equal(bob.signals.responsesDrawn, 1);
  assert.equal(ada.scoreBasis, 'with-transcripts');
  assert.ok(ada.components.conversationPull > bob.components.conversationPull);
  const edge = map.map.edges.find((item) => item.source === ADA.address && item.target === BOB.address);
  assert.equal(edge.transcript, 1);
  assert.equal(edge.meeting, 1);
});

test('an ambiguous speaker name stays unresolved instead of being guessed', () => {
  const map = buildInfluenceMap(inputs({
    emails: [
      email({ from: { name: 'Sam Lee', address: 'sam.lee@contoso.com' }, to: [ADA] }),
      email({ from: { name: 'Sam Lee', address: 'slee@contoso.com' }, to: [ADA] }),
    ],
    meetings: [meeting({ id: 'amb', organizer: ADA, attendees: [BOB] })],
    transcripts: [{ event_id: 'amb', transcript: 'Sam Lee: I approve\nBuyer, Bob: noted' }],
  }));
  assert.equal(map.sources.unresolvedSpeakers, 1);
  assert.equal(byName(map, BOB.name).signals.turns, 1);
  const sams = map.people.filter((person) => person.name === 'Sam Lee');
  assert.equal(sams.length, 2);
  for (const sam of sams) assert.equal(sam.signals.turns, 0);
});

test('signal floors keep a sparse account from scoring anyone near 100', () => {
  const map = buildInfluenceMap(inputs({ emails: [email({ from: ADA, to: [BOB] })] }));
  assert.equal(map.people.length, 2);
  for (const person of map.people) assert.ok(person.score < 40, `${person.name} scored ${person.score}`);
  const ada = byName(map, ADA.name);
  assert.equal(ada.scoreBasis, 'no-transcripts');
  assert.equal(ada.components.conversationPull, null);
  assert.deepEqual(ada.tags, []);
});

test('a hidden influencer is pulled in deliberately, not just copied on a distribution list', () => {
  const HANK = { name: 'Hank Hidden', address: 'hank@contoso.com' };
  const DEE = { name: 'Dee List', address: 'dee@contoso.com' };
  const map = buildInfluenceMap(inputs({
    emails: [
      // Dee is on the first message of three threads: routine distribution.
      email({ thread: 'd1', from: ADA, to: [DEE], at: day(1) }),
      email({ thread: 'd2', from: BOB, to: [DEE], at: day(2) }),
      email({ thread: 'd3', from: MINA, to: [DEE], at: day(3) }),
      // Hank is added to three threads that were already running.
      email({ thread: 'h1', from: ADA, to: [BOB], at: day(4) }),
      email({ thread: 'h1', from: BOB, to: [ADA], cc: [HANK], at: day(5) }),
      email({ thread: 'h2', from: BOB, to: [ADA], at: day(6) }),
      email({ thread: 'h2', from: ADA, to: [BOB], cc: [HANK], at: day(7) }),
      email({ thread: 'h3', from: MINA, to: [ADA], at: day(8) }),
      email({ thread: 'h3', from: ADA, to: [MINA], cc: [HANK], at: day(9) }),
    ],
    meetings: [meeting({ id: 'steer', organizer: ADA, attendees: [HANK, DEE] })],
  }));
  const hank = byName(map, HANK.name);
  const dee = byName(map, DEE.name);
  assert.equal(hank.hiddenInfluencer, true);
  assert.equal(hank.signals.addedMidThread, 3);
  assert.deepEqual(tagIds(hank), ['frequently-looped-in']);
  // Dee clears the inbound and outbound thresholds but was never deliberately pulled in.
  assert.ok(dee.inbound >= 0.6, `Dee inbound ${dee.inbound}`);
  assert.equal(dee.outbound, 0);
  assert.equal(dee.hiddenInfluencer, false);
  assert.equal(map.map.nodes.find((node) => node.id === HANK.address).hiddenInfluencer, true);
});

test('quiet observer needs two meetings where every speaker was identified', () => {
  const QUINN = { name: 'Quinn Observer', address: 'quinn@contoso.com' };
  const script = (extra = '') => [
    'Ada Customer: we should move the data platform to Fabric this quarter',
    'Mina Internal: agreed I will draft the plan',
    'Ada Customer: great thanks',
  ].join('\n') + extra;
  const base = {
    emails: [email({ from: ADA, to: [QUINN] })],
    meetings: [
      meeting({ id: 'q1', organizer: ADA, attendees: [QUINN, MINA], at: day(2) }),
      meeting({ id: 'q2', organizer: ADA, attendees: [QUINN, MINA], at: day(3) }),
    ],
  };
  const attributed = buildInfluenceMap(inputs({
    ...base,
    transcripts: [{ event_id: 'q1', transcript: script() }, { event_id: 'q2', transcript: script() }],
  }));
  const quinn = byName(attributed, QUINN.name);
  assert.equal(quinn.signals.attributedMeetings, 2);
  assert.deepEqual(tagIds(quinn), ['quiet-observer']);
  assert.deepEqual(tagIds(byName(attributed, ADA.name)), ['convenes-meetings', 'draws-responses']);

  // A shared room device could be anyone in the room, so that meeting proves nothing.
  const roomDevice = buildInfluenceMap(inputs({
    ...base,
    transcripts: [
      { event_id: 'q1', transcript: script() },
      { event_id: 'q2', transcript: script('\nLondon 004 Room (4) Teams: can everyone hear us') },
    ],
  }));
  const quinnAgain = byName(roomDevice, QUINN.name);
  assert.equal(roomDevice.sources.unresolvedSpeakers, 1);
  assert.equal(quinnAgain.signals.attributedMeetings, 1);
  assert.deepEqual(tagIds(quinnAgain), []);
});

test('the map, graph, evidence and AI context are capped', () => {
  const crowd = Array.from({ length: 70 }, (_, index) => ({
    name: `Person ${String(index + 1).padStart(2, '0')}`,
    address: `person${index + 1}@contoso.com`,
  }));
  const data = inputs({ emails: crowd.map((person, index) => email({ from: ADA, to: [person], at: day((index % 28) + 1) })) });
  const map = buildInfluenceMap(data);
  assert.equal(map.totalPeople, 71);
  assert.equal(map.people.length, 60);
  assert.equal(map.map.nodes.length, 40);
  const ada = byName(map, ADA.name);
  assert.equal(ada.evidenceTotal, 70);
  assert.equal(ada.evidence.length, 40);
  assert.equal(buildAnalystContext(data).context.people.length, 25);
});

test('a broadcast meeting transcript is ignored like the meeting', () => {
  const crowd = Array.from({ length: 21 }, (_, index) => ({
    name: `Crowd ${index + 1}`,
    address: `crowd${index + 1}@contoso.com`,
  }));
  const data = inputs({
    emails: [email({ from: ADA, to: [crowd[0]] })],
    meetings: [
      meeting({ id: 'all-hands', organizer: ADA, attendees: crowd, at: day(1) }),
      meeting({ id: 'review', organizer: ADA, attendees: [BOB], at: day(2) }),
    ],
    transcripts: [{ event_id: 'all-hands', transcript: 'Ada Customer: welcome everyone\nMystery Caller: who is speaking' }],
  });
  const map = buildInfluenceMap(data);
  assert.equal(map.sources.broadcastMeetings, 1);
  assert.equal(map.sources.broadcastTranscripts, 1);
  assert.equal(map.sources.transcripts, 0);
  assert.equal(map.sources.transcriptTurns, 0);
  assert.equal(map.sources.unresolvedSpeakers, 0);
  const ada = byName(map, ADA.name);
  assert.equal(ada.signals.turns, 0);
  assert.equal(ada.signals.words, 0);
  assert.equal(ada.signals.covered, false);
  assert.equal(ada.scoreBasis, 'no-transcripts');
  const listener = byName(map, 'Crowd 1');
  assert.equal(listener.signals.covered, false);
  assert.equal(listener.signals.attributedMeetings, 0);

  const { context } = buildAnalystContext(data);
  assert.deepEqual(context.transcripts, []);
  assert.equal(JSON.stringify(context).includes('welcome everyone'), false);
});

test('broadcast email text never reaches the AI and a thread of only broadcasts is left out', () => {
  const crowd = Array.from({ length: 21 }, (_, index) => ({
    name: `Crowd ${index + 1}`,
    address: `crowd${index + 1}@contoso.com`,
  }));
  const data = inputs({
    emails: [
      email({ thread: 'news', from: ADA, to: crowd, at: day(1), subject: 'Newsletter', body: 'Quarterly newsletter for everyone' }),
      email({ thread: 'kickoff', from: ADA, to: crowd, at: day(2), subject: 'Kickoff', body: 'Kickoff announcement for the company' }),
      email({ thread: 'kickoff', from: BOB, to: [ADA], at: day(3), subject: 'RE: Kickoff', body: 'Procurement can start next week' }),
    ],
  });
  assert.equal(buildInfluenceMap(data).sources.broadcastEmails, 2);
  const { context } = buildAnalystContext(data);
  assert.equal(context.emailThreads.length, 1);
  const [thread] = context.emailThreads;
  assert.equal(thread.title, 'RE: Kickoff');
  assert.equal(thread.date, day(3));
  assert.match(thread.text, /^From: Bob Buyer \[P\d+\]/);
  assert.match(thread.text, /Procurement can start next week/);
  const text = JSON.stringify(context);
  assert.equal(text.includes('Quarterly newsletter'), false);
  assert.equal(text.includes('Kickoff announcement'), false);
  assert.equal(text.includes('Crowd'), false);

  const onlyBroadcasts = buildAnalystContext(inputs({
    emails: [email({ from: ADA, to: crowd, body: 'Quarterly newsletter for everyone' })],
    meetings: [
      meeting({ id: 'all-hands', organizer: ADA, attendees: crowd, at: day(1) }),
      meeting({ id: 'review', organizer: ADA, attendees: [BOB], at: day(2) }),
    ],
    transcripts: [{ event_id: 'all-hands', transcript: 'Ada Customer: welcome everyone' }],
  })).context;
  assert.ok(onlyBroadcasts.people.length > 0);
  assert.deepEqual(onlyBroadcasts.transcripts, []);
  assert.deepEqual(onlyBroadcasts.emailThreads, []);
});

test('an AI assessment is parsed against the supplied refs and quotes are verified', () => {
  const { context, refToId, sources } = buildAnalystContext(analysisInputs());
  const result = parseInfluenceAssessment(modelReply(context), { refToId, sources });
  assert.equal(result.version, ANALYST_VERSION);
  const ada = result.people.find((person) => person.personId === ADA.address);
  assert.equal(ada.stance, 'champion');
  assert.equal(ada.decisionRole, 'Budget owner');
  assert.equal(ada.evidence[0].verified, true);
  assert.deepEqual(Object.keys(ada.evidence[0].source).sort(), ['date', 'id', 'kind', 'title', 'webLink']);
  assert.equal(ada.evidence[0].source.kind, 'transcript');
  assert.equal(ada.evidence[0].source.id, 'arch');
  const bob = result.people.find((person) => person.personId === BOB.address);
  assert.equal(bob.evidence[0].verified, false);
  assert.equal(bob.adoptedSuggestions[0].verified, true);
  assert.deepEqual(result.caveats, ['Only one meeting transcript.']);
});

test('your stance overrides the AI stance and new activity marks the analysis stale', () => {
  const data = analysisInputs();
  const { context, refToId, sources } = buildAnalystContext(data);
  const assessment = {
    provider: 'copilot',
    model: 'gpt-5.6-luna',
    analyzedAt: day(4),
    inputHash: hashAnalystContext(context),
    result: parseInfluenceAssessment(modelReply(context), { refToId, sources }),
  };
  const fresh = buildInfluenceMap({
    ...data,
    assessment,
    overrides: [{ personId: BOB.address, stance: 'champion', note: 'Confirmed on call', hidden: false }],
  });
  assert.equal(fresh.assessment.stale, false);
  assert.equal(fresh.assessment.provider, 'copilot');
  const bob = byName(fresh, BOB.name);
  assert.equal(bob.stance, 'champion');
  assert.equal(bob.stanceSource, 'you');
  assert.equal(bob.ai.stance, 'blocker');
  assert.deepEqual(bob.override, { stance: 'champion', note: 'Confirmed on call' });
  const ada = byName(fresh, ADA.name);
  assert.equal(ada.stance, 'champion');
  assert.equal(ada.stanceSource, 'ai');

  const later = buildInfluenceMap({
    ...data,
    assessment,
    emails: [...data.emails, email({ thread: 'budget', from: BOB, to: [ADA], at: day(5), body: 'Security signed off.' })],
  });
  assert.equal(later.assessment.stale, true);
});

test('an unreadable or outdated saved analysis is reported, never shown as AI output', () => {
  const data = analysisInputs();
  const saved = { provider: 'copilot', model: null, analyzedAt: day(4), inputHash: 'x' };
  const unreadable = buildInfluenceMap({ ...data, assessment: { ...saved, result: undefined } });
  assert.match(unreadable.assessment.error, /could not be read/);
  assert.ok(unreadable.people.every((person) => person.ai === null && person.stance === null));
  const outdated = buildInfluenceMap({ ...data, assessment: { ...saved, result: { version: 0, people: [], caveats: [] } } });
  assert.match(outdated.assessment.error, /older analyzer version/);
});

test('excluded people leave the map without changing other scores and are masked in the AI context', () => {
  const data = analysisInputs();
  const before = buildInfluenceMap(data);
  const overrides = [
    { personId: BOB.address, stance: null, note: '', hidden: true },
    { personId: 'gone@contoso.com', stance: null, note: '', hidden: true },
  ];
  const after = buildInfluenceMap({ ...data, overrides });
  assert.equal(byName(after, BOB.name), undefined);
  assert.equal(after.totalPeople, before.totalPeople - 1);
  assert.deepEqual(after.hiddenPeople, [
    { id: BOB.address, name: BOB.name, affiliation: 'customer' },
    { id: 'gone@contoso.com', name: 'gone@contoso.com', affiliation: null },
  ]);
  assert.equal(byName(after, ADA.name).score, byName(before, ADA.name).score);
  assert.equal(after.map.nodes.some((node) => node.id === BOB.address), false);
  assert.equal(after.map.edges.some((edge) => edge.source === BOB.address || edge.target === BOB.address), false);

  const { context } = buildAnalystContext({ ...data, overrides });
  const text = JSON.stringify(context);
  assert.equal(text.includes(BOB.name), false);
  assert.equal(text.includes('cannot approve spend'), false);
  assert.equal(text.includes('Procurement needs'), false);
  assert.match(context.transcripts[0].text, /Hidden participant: \[omitted\]/);
});

test('an excluded person stays hidden where only their name was seen, without masking others', () => {
  const JANE_A = { name: 'Jane Doe', address: 'jane.a@contoso.com' };
  const JANE_B = { name: 'Jane Doe', address: 'jane.b@contoso.com' };
  const SAM_A = { name: 'Sam Lee', address: 'sam.a@contoso.com' };
  const SAM_B = { name: 'Sam Lee', address: 'sam.b@contoso.com' };
  const JANE_NO_ADDRESS = { name: 'Jane Doe', address: '' };
  const hide = (person) => ({ personId: person.address, stance: null, note: '', hidden: true });
  const data = inputs({
    emails: [
      email({ thread: 'intro', from: ADA, to: [JANE_A, SAM_A], at: day(1), subject: 'Intro', body: 'Meet the team' }),
      email({ thread: 'intro', from: ADA, to: [JANE_B, SAM_B], at: day(2), subject: 'RE: Intro', body: 'Adding more people' }),
      email({ thread: 'plan', from: ADA, to: [BOB, JANE_NO_ADDRESS], at: day(3), subject: 'Plan', body: 'Here is the plan' }),
      email({ thread: 'plan', from: JANE_NO_ADDRESS, to: [ADA], at: day(4), subject: 'RE: Plan', body: 'My private remark on the budget' }),
    ],
    meetings: [meeting({ id: 'sync', organizer: ADA, attendees: [BOB], at: day(5) })],
    transcripts: [{
      event_id: 'sync',
      transcript: [
        'Ada Customer: let us review the plan',
        'Jane Doe: my private view on the vendor',
        'Sam Lee: I can take the action',
        'Bob Buyer: agreed',
      ].join('\n'),
    }],
    overrides: [hide(JANE_A), hide(JANE_B)],
  });
  const { context } = buildAnalystContext(data);
  const text = JSON.stringify(context);
  assert.equal(text.includes('Jane'), false);
  assert.equal(text.includes('private remark'), false);
  assert.equal(text.includes('private view'), false);
  const transcript = context.transcripts[0].text;
  assert.match(transcript, /Hidden participant: \[omitted\]/);
  assert.match(transcript, /Sam Lee \[unmatched\]: I can take the action/);
  const plan = context.emailThreads.find((thread) => thread.title === 'Plan');
  assert.match(plan.text, /To\/Cc: Bob Buyer \[P\d+\], Hidden participant\n/);
  assert.match(plan.text, /From: Hidden participant \([^)]*\)\nTo\/Cc: Ada Customer \[P\d+\]\n\[omitted\]$/);

  // With one Jane excluded, the other is still shown, but a sighting that could be either
  // of them stays hidden.
  const oneHidden = buildAnalystContext({ ...data, overrides: [hide(JANE_A)] }).context;
  const intro = oneHidden.emailThreads.find((thread) => thread.title === 'Intro');
  assert.match(intro.text, /To\/Cc: Hidden participant, Sam Lee \[P\d+\]\n/);
  assert.match(intro.text, /To\/Cc: Jane Doe \[P\d+\], Sam Lee \[P\d+\]\n/);
  assert.match(oneHidden.transcripts[0].text, /Hidden participant: \[omitted\]/);
  assert.equal(JSON.stringify(oneHidden).includes('private view'), false);
});

test('the AI context never contains an email address or quoted reply history', () => {
  const CONTACT = { name: 'SampleContact@example.test', address: 'samplecontact@example.test' };
  const base = analysisInputs();
  const { context } = buildAnalystContext({
    ...base,
    emails: [
      ...base.emails,
      email({ from: CONTACT, to: [ADA], subject: 'Ping ada@contoso.com', body: 'Reach me at samplecontact@example.test' }),
    ],
  });
  const text = JSON.stringify(context);
  assert.doesNotMatch(text, EMAIL_PATTERN);
  assert.match(text, /Contact me at \[email\]/);
  assert.equal(text.includes('Old quoted text'), false);
  assert.equal(context.account, 'Contoso');
});

test('the AI context and its hash are deterministic', () => {
  const first = buildAnalystContext(analysisInputs()).context;
  const second = buildAnalystContext(analysisInputs()).context;
  assert.deepEqual(first, second);
  assert.equal(hashAnalystContext(first), hashAnalystContext(second));
  assert.notEqual(hashAnalystContext(first), hashAnalystContext({ ...first, account: 'Other' }));
  assert.match(hashAnalystContext(first), /^[0-9a-f]{64}$/);
});

test('an invalid AI reply is rejected with an explicit error', () => {
  const { context, refToId, sources } = buildAnalystContext(analysisInputs());
  const good = JSON.parse(modelReply(context)).people[0];
  const ref = good.personRef;
  const transcript = context.transcripts[0].ref;
  const evidence = { sourceRef: transcript, quote: 'I want the pilot live before the board meeting' };
  const suggestion = { suggestion: 'Run the security review', sourceRefs: [transcript] };
  const reply = (people) => JSON.stringify({ people, caveats: [] });
  const cases = [
    ['not json', 'not valid JSON'],
    [JSON.stringify([]), 'not a JSON object'],
    [JSON.stringify({ people: {} }), '"people" is not a list'],
    [reply([null]), 'a person entry is not an object'],
    [reply([{ ...good, personRef: 'P99' }]), 'unknown person'],
    [reply([{ ...good, personRef: [ref] }]), 'a person reference is not text'],
    [reply([good, good]), 'duplicate person'],
    [reply([{ ...good, stance: 'ally' }]), 'invalid stance'],
    [reply([{ ...good, stance: ['champion'] }]), 'invalid stance'],
    [reply([{ ...good, confidence: 'certain' }]), 'invalid confidence'],
    [reply([{ ...good, confidence: 7 }]), 'invalid confidence'],
    [reply([{ ...good, reason: ' ' }]), 'missing reason'],
    [reply([{ ...good, reason: {} }]), `reason for ${ref} is not text`],
    [reply([{ ...good, decisionRole: {} }]), `decisionRole for ${ref} is not text`],
    [reply([{ ...good, evidence: 'none' }]), `evidence for ${ref} is not a list`],
    [reply([{ ...good, evidence: [[transcript]] }]), `an evidence entry for ${ref} is not an object`],
    [reply([{ ...good, evidence: [...Array(5).fill(evidence), 'late'] }]), 'an evidence entry'],
    [reply([{ ...good, evidence: [{ sourceRef: 'X9', quote: 'anything at all' }] }]), 'unknown source'],
    [reply([{ ...good, evidence: [{ ...evidence, sourceRef: [transcript] }] }]), `a source reference for ${ref} is not text`],
    [reply([{ ...good, evidence: [{ ...evidence, quote: 42 }] }]), `an evidence quote for ${ref} is not text`],
    [reply([{ ...good, adoptedSuggestions: {} }]), `adoptedSuggestions for ${ref} is not a list`],
    [reply([{ ...good, adoptedSuggestions: ['Run the review'] }]), 'an adopted suggestion for'],
    [reply([{ ...good, adoptedSuggestions: [{ suggestion: 'Do it', sourceRefs: [] }] }]), 'without sources'],
    [reply([{ ...good, adoptedSuggestions: [...Array(5).fill(suggestion), { suggestion: 'Late' }] }]), 'without sources'],
    [reply([{ ...good, adoptedSuggestions: [{ ...suggestion, sourceRefs: transcript }] }]), `sourceRefs for ${ref} is not a list`],
    [reply([{ ...good, adoptedSuggestions: [{ ...suggestion, suggestion: ' ' }] }]), 'missing adopted suggestion text'],
    [reply([{ ...good, adoptedSuggestions: [{ ...suggestion, suggestion: 5 }] }]), 'adopted suggestion text for'],
    [reply([{ ...good, adoptedSuggestions: [{ ...suggestion, adoptedAs: ['x'] }] }]), `adoptedAs for ${ref} is not text`],
    [reply([{ ...good, adoptedSuggestions: [{ ...suggestion, quote: false }] }]), 'an adopted suggestion quote for'],
    [JSON.stringify({ people: [good], caveats: 'none' }), '"caveats" is not a list'],
    [JSON.stringify({ people: [good], caveats: [42] }), 'a caveat is not text'],
  ];
  for (const [content, why] of cases) {
    assert.throws(
      () => parseInfluenceAssessment(content, { refToId, sources }),
      (error) => error.message.includes(why) && error.message.includes('Nothing was saved'),
      why,
    );
  }
  assert.throws(() => parseInfluenceAssessment(modelReply(context), {}), /requires the refToId and sources maps/);
});

test('a valid AI reply is normalized and keeps at most five evidence items and suggestions per person', () => {
  const { context, refToId, sources } = buildAnalystContext(analysisInputs());
  const good = JSON.parse(modelReply(context)).people[0];
  const transcript = context.transcripts[0].ref;
  const evidence = Array.from({ length: 7 }, () => ({
    sourceRef: transcript,
    quote: 'I want the pilot live before the board meeting',
  }));
  const adoptedSuggestions = Array.from({ length: 6 }, (_, index) => ({
    suggestion: `Idea ${index + 1}`,
    sourceRefs: [transcript, ` ${transcript} `],
  }));
  const result = parseInfluenceAssessment(JSON.stringify({
    people: [{ ...good, stance: ' Champion ', confidence: 'HIGH', decisionRole: null, evidence, adoptedSuggestions }],
  }), { refToId, sources });
  const [person] = result.people;
  assert.equal(person.personId, ADA.address);
  assert.equal(person.stance, 'champion');
  assert.equal(person.confidence, 'high');
  assert.equal(person.decisionRole, null);
  assert.equal(person.evidence.length, 5);
  assert.ok(person.evidence.every((item) => item.verified));
  assert.equal(person.adoptedSuggestions.length, 5);
  assert.deepEqual(person.adoptedSuggestions.map((item) => item.suggestion), ['Idea 1', 'Idea 2', 'Idea 3', 'Idea 4', 'Idea 5']);
  assert.equal(person.adoptedSuggestions[0].sources.length, 1);
  assert.equal(person.adoptedSuggestions[0].adoptedAs, '');
  assert.equal(person.adoptedSuggestions[0].quote, '');
  assert.equal(person.adoptedSuggestions[0].verified, false);
  assert.deepEqual(result.caveats, []);
});

test('quotes are verified word for word, tolerating typographic punctuation and ellipses', () => {
  const text = "Bob Buyer [P2]: I can't approve spend \u2014 not until security signs off on the design.";
  assert.equal(verifyQuote('I can\u2019t approve spend - not until security', text), true);
  assert.equal(verifyQuote('"I can\'t approve spend \u2026 security signs off"', text), true);
  assert.equal(verifyQuote('I will approve spend now', text), false);
  assert.equal(verifyQuote('spend', text), false);
  assert.equal(verifyQuote('', text), false);
});

test('override targets are profiled non-Microsoft people and existing overrides', () => {
  const ids = profiledPersonIds(analysisInputs({ overrides: [{ personId: 'gone@contoso.com', hidden: true }] }));
  assert.ok(ids.has(ADA.address));
  assert.ok(ids.has(BOB.address));
  assert.ok(ids.has('gone@contoso.com'));
  assert.equal(ids.has(MINA.address), false);
});

test('transcript text is split into speaker turns', () => {
  assert.deepEqual(parseTurns('Ada Customer: first\ncontinued here\nAda Customer: again\nBob Buyer: reply'), [
    { label: 'Ada Customer', text: 'first continued here again' },
    { label: 'Bob Buyer', text: 'reply' },
  ]);
});

test('quoted reply history is removed before the model sees an email', () => {
  assert.equal(stripQuotedHistory('Agreed.\n\n-----Original Message-----\nFrom: someone'), 'Agreed.');
  assert.equal(stripQuotedHistory('Yes please.\nOn Mon, Jan 5, 2026 Ada wrote:\n> older'), 'Yes please.');
  assert.equal(stripQuotedHistory('No history here.'), 'No history here.');
});

test('name variants match "Last, First (Org)" display names', () => {
  const variants = nameVariants('Doe, Jane (Contoso)');
  assert.ok(variants.includes('jane doe'));
  assert.ok(variants.includes('doe, jane'));
  assert.deepEqual(nameVariants('  '), []);
});
