const { test } = require('node:test');
const assert = require('node:assert/strict');

const intel = require('../intelligence');

// A tiny fake db: routes prepare(sql) to a matcher that returns rows. Unmatched
// queries return empty results (get→undefined, all→[]). An optional `throwOn`
// substring makes prepare throw, simulating an absent table.
function makeFakeDb(routes = [], throwOn = null) {
  return {
    prepare(sql) {
      if (throwOn && sql.includes(throwOn)) throw new Error('no such table');
      const route = routes.find((r) => sql.includes(r.match));
      return {
        get: (...args) => (route && route.get ? route.get(...args) : undefined),
        all: (...args) => (route && route.all ? route.all(...args) : []),
      };
    },
  };
}

test('empty intel shapes carry the source and available:false', () => {
  assert.equal(intel.emptyTeamsIntel('graph').source, 'graph');
  assert.equal(intel.emptyTeamsIntel().available, false);
  assert.equal(intel.emptyEmailIntel('cli').source, 'cli');
  assert.equal(intel.emptyMeetingIntel().available, false);
});

test('resolveTeamsSourceMode validates and defaults to auto', () => {
  assert.equal(intel.resolveTeamsSourceMode({ SE_ASSIST_TEAMS_SOURCE: 'graph' }), 'graph');
  assert.equal(intel.resolveTeamsSourceMode({ SE_ASSIST_TEAMS_SOURCE: 'BOGUS' }), 'auto');
  assert.equal(intel.resolveTeamsSourceMode({}), 'auto');
});

test('resolveEmailSourceMode validates and defaults to auto', () => {
  assert.equal(intel.resolveEmailSourceMode({ SE_ASSIST_EMAIL_SOURCE: 'workiq' }), 'workiq');
  assert.equal(intel.resolveEmailSourceMode({ SE_ASSIST_EMAIL_SOURCE: 'cli' }), 'auto');
  assert.equal(intel.resolveEmailSourceMode({}), 'auto');
});

test('cliTeamsHasData / graphTeamsHasData reflect presence and swallow errors', () => {
  const hasCli = makeFakeDb([{ match: 'teams_chat_customer_links', get: () => ({ 1: 1 }) }]);
  assert.equal(intel.cliTeamsHasData(hasCli, '42'), true);
  assert.equal(intel.cliTeamsHasData(hasCli, null), false);

  const noGraph = makeFakeDb([]);
  assert.equal(intel.graphTeamsHasData(noGraph, 'p1'), false);

  const broken = makeFakeDb([], 'cached_customer_teams_refs');
  assert.equal(intel.graphTeamsHasData(broken, 'p1'), false); // error → false
});

test('loadTeamsIntelligence in auto mode with no data returns empty(none)', () => {
  const empty = makeFakeDb([]);
  const out = intel.loadTeamsIntelligence(empty, '42', 'p1');
  assert.equal(out.source, 'none');
  assert.equal(out.available, false);
});

test('loadAccountTeam maps rows and buckets by org', () => {
  const db = makeFakeDb([{
    match: 'customer_account_team',
    all: () => [
      { person_name: 'MS One', person_email: 'a@microsoft.com', org: 'microsoft', email_sends: 3, email_cc: 1, teams_msgs: 5, last_activity: '2026-01-01', sources: 'x', engagement: 9 },
      { person_name: 'Cust One', person_email: null, org: 'customer', email_sends: 0, email_cc: 0, teams_msgs: 0, last_activity: null, sources: '', engagement: 2 },
    ],
  }]);
  const out = intel.loadAccountTeam(db, '42');
  assert.equal(out.available, true);
  assert.equal(out.microsoft.length, 1);
  assert.equal(out.customer.length, 1);
  assert.equal(out.microsoft[0].email, 'a@microsoft.com');
  assert.equal(out.customer[0].email, null);
  assert.equal(out.counts.microsoft, 1);
  assert.equal(out.counts.customer, 1);
});

test('loadAccountTeam returns empty for no tpid and for an absent table', () => {
  assert.equal(intel.loadAccountTeam(makeFakeDb([]), null).available, false);
  const broken = makeFakeDb([], 'customer_account_team');
  assert.equal(intel.loadAccountTeam(broken, '42').available, false);
});
