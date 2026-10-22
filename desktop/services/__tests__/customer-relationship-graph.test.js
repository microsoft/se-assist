'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildCustomerRelationshipGraph,
  participantList,
} = require('../customer-relationship-graph');

test('participantList accepts Graph emailAddress participants', () => {
  const participants = participantList(JSON.stringify([
    { emailAddress: { name: 'Ada Customer', address: 'ADA@CONTOSO.COM' } },
  ]));
  assert.deepEqual(participants, [{ name: 'Ada Customer', email: 'ada@contoso.com' }]);
});

test('a customer contact accumulates evidence across email, meetings and Teams', () => {
  const graph = buildCustomerRelationshipGraph({
    teamRows: [
      { person_name: 'Mina Internal', person_email: 'mina@microsoft.com', org: 'microsoft' },
      { person_name: 'Ada Customer', person_email: 'ada@contoso.com', org: 'customer' },
    ],
    emailRows: [{
      from_name: 'Mina Internal',
      from_address: 'mina@microsoft.com',
      to_json: JSON.stringify([{ name: 'Ada Customer', address: 'ada@contoso.com' }]),
      cc_json: '[]',
      received_at: '2026-01-02T10:00:00Z',
    }],
    meetingRows: [{
      organizer_name: 'Ada Customer',
      organizer_address: 'ada@contoso.com',
      attendees_json: JSON.stringify([
        { name: 'Mina Internal', address: 'mina@microsoft.com' },
      ]),
      start_at: '2026-01-03T10:00:00Z',
    }],
    teamsRows: [{
      chat_id: 'chat-1',
      topic: 'Fabric pilot',
      chat_raw_json: JSON.stringify({
        members: [
          { displayName: 'Mina Internal', email: 'mina@microsoft.com' },
          { displayName: 'Ada Customer', email: 'ada@contoso.com' },
        ],
      }),
      sender_name: 'Ada Customer',
      sender_id: 'ada@contoso.com',
      last_message_at: '2026-01-04T10:00:00Z',
      sent_at: '2026-01-04T10:00:00Z',
    }],
  });

  // A single customer contact: no peer to link to, but all three channels counted.
  assert.deepEqual(graph.nodes.map((n) => n.name), ['Ada Customer']);
  assert.deepEqual(graph.edges, []);
  const detail = graph.details['ada@contoso.com'];
  assert.equal(detail.eventTotal, 3, 'email + meeting + chat');
  assert.deepEqual(detail.microsoft.map((p) => p.name), ['Mina Internal']);
  assert.equal(detail.microsoft[0].sharedEvents, 3);
  assert.deepEqual(
    graph.events.map((e) => e.kind).sort(),
    ['email', 'meeting', 'teams'],
  );
  assert.deepEqual(graph.summary, {
    internalPeople: 1,
    externalPeople: 1,
    externalShown: 1,
    truncated: false,
    customerConnections: 0,
    interactions: 3,
  });
});

test('the map links customer contacts to each other and counts their Microsoft contacts', () => {
  const graph = buildCustomerRelationshipGraph({
    teamRows: [
      { person_name: 'Mina Internal', person_email: 'mina@microsoft.com', org: 'microsoft' },
      { person_name: 'Ada Customer', person_email: 'ada@contoso.com', org: 'customer' },
    ],
    emailRows: [{
      message_id: 'm1',
      subject: 'Fabric rollout',
      from_name: 'Mina Internal',
      from_address: 'mina@microsoft.com',
      to_json: JSON.stringify([
        { name: 'Ada Customer', address: 'ada@contoso.com' },
        { name: 'Bob Customer', address: 'bob@contoso.com' },
      ]),
      cc_json: '[]',
      received_at: '2026-01-02T10:00:00Z',
    }],
  });

  // Only customer people are rendered — Microsoft is a count, not a node.
  assert.deepEqual(graph.nodes.map((n) => n.name).sort(), ['Ada Customer', 'Bob Customer']);
  assert.equal(graph.edges.length, 1, 'the two customer people share one item');
  assert.deepEqual(
    { source: graph.edges[0].source, target: graph.edges[0].target, total: graph.edges[0].total },
    { source: 'ada@contoso.com', target: 'bob@contoso.com', total: 1 },
  );
  const ada = graph.nodes.find((n) => n.id === 'ada@contoso.com');
  assert.equal(ada.microsoftCount, 1, 'Ada worked with one Microsoft person');
  assert.equal(ada.customerCount, 1, 'Ada is connected to one other customer contact');
  assert.deepEqual(
    graph.details['ada@contoso.com'].microsoft.map((p) => p.name),
    ['Mina Internal'],
  );
  assert.deepEqual(graph.summary, {
    internalPeople: 1,
    externalPeople: 2,
    externalShown: 2,
    truncated: false,
    customerConnections: 1,
    interactions: 1,
  });
});

test('each contact carries the emails, meetings and chats behind their connections', () => {
  const graph = buildCustomerRelationshipGraph({
    emailRows: [{
      message_id: 'm1',
      subject: 'Pricing question',
      from_name: 'Ada Customer',
      from_address: 'ada@contoso.com',
      to_json: JSON.stringify([{ name: 'Mina Internal', address: 'mina@microsoft.com' }]),
      cc_json: '[]',
      received_at: '2026-01-02T10:00:00Z',
    }],
    meetingRows: [{
      event_id: 'e1',
      subject: 'Architecture design session',
      organizer_name: 'Mina Internal',
      organizer_address: 'mina@microsoft.com',
      attendees_json: JSON.stringify([{ name: 'Ada Customer', address: 'ada@contoso.com' }]),
      start_at: '2026-01-05T10:00:00Z',
    }],
  });

  const detail = graph.details['ada@contoso.com'];
  assert.equal(detail.eventTotal, 2);
  const items = detail.eventIds.map((id) => graph.events.find((e) => e.id === id));
  // Newest first, and each item keeps its real subject so the panel can list it.
  assert.deepEqual(
    items.map((item) => [item.kind, item.title]),
    [['meeting', 'Architecture design session'], ['email', 'Pricing question']],
  );
});

test('same-org communication is excluded from the customer relationship map', () => {
  const graph = buildCustomerRelationshipGraph({
    teamRows: [
      { person_name: 'One Microsoft', person_email: 'one@microsoft.com', org: 'microsoft' },
      { person_name: 'Two Microsoft', person_email: 'two@microsoft.com', org: 'microsoft' },
    ],
    emailRows: [{
      from_name: 'One Microsoft',
      from_address: 'one@microsoft.com',
      to_json: JSON.stringify([{ name: 'Two Microsoft', address: 'two@microsoft.com' }]),
      cc_json: '[]',
    }],
  });
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
  assert.deepEqual(graph.summary, {
    internalPeople: 0,
    externalPeople: 0,
    externalShown: 0,
    truncated: false,
    customerConnections: 0,
    interactions: 0,
  });
});

test('a broadcast meeting does not seed the relationship map', () => {
  // One customer meeting organizer + a large block of Microsoft attendees (an
  // all-hands the customer was invited to). Fanning this out would add every
  // Microsoft attendee as a "contact"; the broadcast guard drops it entirely.
  const attendees = [];
  for (let i = 0; i < 30; i += 1) {
    attendees.push({ name: `MS ${i}`, address: `ms${i}@microsoft.com` });
  }
  const graph = buildCustomerRelationshipGraph({
    meetingRows: [{
      organizer_name: 'Ada Customer',
      organizer_address: 'ada@contoso.com',
      attendees_json: JSON.stringify(attendees),
      start_at: '2026-02-01T10:00:00Z',
    }],
  });
  assert.equal(graph.nodes.length, 0, 'broadcast meeting must not create contacts');
  assert.equal(graph.summary.internalPeople, 0);
});

test('a small meeting still links focused attendees, honoring the broadcast threshold', () => {
  const graph = buildCustomerRelationshipGraph({
    meetingRows: [{
      organizer_name: 'Ada Customer',
      organizer_address: 'ada@contoso.com',
      attendees_json: JSON.stringify([
        { name: 'Mina Internal', address: 'mina@microsoft.com' },
        { name: 'Nael Internal', address: 'nael@microsoft.com' },
      ]),
      start_at: '2026-02-02T10:00:00Z',
    }],
    broadcastMaxPerSide: 5,
  });
  assert.equal(graph.summary.internalPeople, 2);
  assert.equal(graph.summary.externalPeople, 1);
});

test('rendered nodes are capped per side while the summary reports true totals', () => {
  // 8 distinct customer people each in a focused 1:1 email with the same
  // Microsoft seller — well under the broadcast threshold individually.
  const emailRows = [];
  for (let i = 0; i < 8; i += 1) {
    emailRows.push({
      from_name: 'Sam Seller',
      from_address: 'sam@microsoft.com',
      to_json: JSON.stringify([{ name: `Cust ${i}`, address: `cust${i}@contoso.com` }]),
      cc_json: '[]',
      received_at: `2026-03-0${(i % 9) + 1}T10:00:00Z`,
    });
  }
  const graph = buildCustomerRelationshipGraph({ emailRows, maxNodesPerSide: 3 });
  assert.equal(graph.summary.externalPeople, 8, 'summary reports the true external total');
  assert.equal(graph.summary.externalShown, 3, 'only the top 3 are rendered');
  assert.equal(graph.summary.truncated, true);
  assert.equal(graph.nodes.filter((n) => n.type === 'external').length, 3);
});
