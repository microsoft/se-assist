const { test } = require('node:test');
const assert = require('node:assert/strict');

const sl = require('../signal-links');

// A tiny fake db mirroring services/__tests__/intelligence.test.js: prepare(sql) routes to a
// matcher by substring. Each route may provide get()/all()/run(). Unmatched queries return
// empty (get->undefined, all->[], run->{changes:0}). `capture` collects run() calls so tests
// can assert what SQL/params the resolver emitted without a real database.
function makeFakeDb(routes = [], capture = []) {
  return {
    prepare(sql) {
      const route = routes.find((r) => sql.includes(r.match));
      return {
        get: (...args) => (route && route.get ? route.get(...args) : undefined),
        all: (...args) => (route && route.all ? route.all(...args) : []),
        run: (...args) => {
          capture.push({ sql, args });
          return route && route.run ? route.run(...args) : { changes: 1 };
        },
      };
    },
  };
}

test('SIGNAL_TYPES and TARGET_TYPES are the canonical enums', () => {
  assert.deepEqual([...sl.SIGNAL_TYPES], ['email', 'meeting', 'chat']);
  assert.deepEqual(
    [...sl.TARGET_TYPES],
    ['account', 'milestone', 'opportunity', 'workload', 'action', 'hok_activity'],
  );
});

test('encodeSignalId namespaces the native id', () => {
  assert.equal(sl.encodeSignalId('email', 'AAMkAD123'), 'email:AAMkAD123');
  assert.equal(sl.encodeSignalId('meeting', 'evt-9'), 'meeting:evt-9');
});

test('encode/decode round-trips a chat id that itself contains colons', () => {
  const chatId = '19:abc123def456@thread.tacv2';
  const encoded = sl.encodeSignalId('chat', chatId);
  assert.equal(encoded, `chat:${chatId}`);
  const decoded = sl.decodeSignalId(encoded);
  assert.equal(decoded.signalType, 'chat');
  assert.equal(decoded.nativeId, chatId); // first-colon split preserves the inner colons
});

test('encodeSignalId fails loud on unknown type and empty id', () => {
  assert.throws(() => sl.encodeSignalId('sms', 'x'), /unknown signal_type/);
  assert.throws(() => sl.encodeSignalId('email', '   '), /empty native id/);
  assert.throws(() => sl.encodeSignalId('email', null), /empty native id/);
});

test('decodeSignalId fails loud on malformed / unknown-prefix ids', () => {
  assert.throws(() => sl.decodeSignalId('no-prefix-here'), /malformed signal_id/);
  assert.throws(() => sl.decodeSignalId(':leadingcolon'), /malformed signal_id/);
  assert.throws(() => sl.decodeSignalId('sms:123'), /unknown signal_type/);
  assert.throws(() => sl.decodeSignalId('email:'), /empty native id/);
});

test('resolveSignal routes an email id to the emails table only', () => {
  const captured = [];
  let seenSql = null;
  const db = {
    prepare(sql) {
      seenSql = sql;
      return {
        get: () => ({
          nativeId: 'AAMkAD123',
          title: 'Q3 review',
          subtitle: 'Jane Doe',
          date: '2024-05-01T10:00:00Z',
          webLink: 'https://outlook/mail/AAMkAD123',
        }),
        all: () => [],
        run: (...a) => captured.push(a),
      };
    },
  };
  const res = sl.resolveSignal(db, 'email:AAMkAD123');
  assert.match(seenSql, /FROM active_emails/);
  assert.match(seenSql, /WHERE message_id = \?/);
  assert.equal(res.signalType, 'email');
  assert.equal(res.nativeId, 'AAMkAD123');
  assert.equal(res.title, 'Q3 review');
  assert.equal(res.webLink, 'https://outlook/mail/AAMkAD123');
});

test('resolveSignal routes a chat id to teams_chats (never the emails table)', () => {
  let seenSql = null;
  const db = {
    prepare(sql) {
      seenSql = sql;
      return { get: () => ({ nativeId: '19:x@thread.tacv2', title: 'Deal room' }), all: () => [] };
    },
  };
  const res = sl.resolveSignal(db, 'chat:19:x@thread.tacv2');
  assert.match(seenSql, /FROM active_teams_chats/);
  assert.doesNotMatch(seenSql, /FROM active_emails/);
  assert.equal(res.signalType, 'chat');
  assert.equal(res.nativeId, '19:x@thread.tacv2');
});

test('resolveSignal returns null for an absent (but well-formed) signal', () => {
  const db = makeFakeDb([]); // get -> undefined
  assert.equal(sl.resolveSignal(db, 'meeting:evt-missing'), null);
});

test('resolveSignal throws on a malformed id (not a silent null)', () => {
  const db = makeFakeDb([]);
  assert.throws(() => sl.resolveSignal(db, 'garbage'), /malformed signal_id/);
});

test('linkSignal encodes from type+nativeId and emits an upsert', () => {
  const captured = [];
  const db = makeFakeDb([{ match: 'INSERT INTO signal_links', run: () => ({ changes: 1 }) }], captured);
  const out = sl.linkSignal(db, {
    signalType: 'chat',
    nativeId: '19:x@thread.tacv2',
    targetType: 'workload',
    targetId: 42,
    tpid: 'TP1',
  });
  assert.equal(out.signalId, 'chat:19:x@thread.tacv2');
  assert.equal(out.targetId, '42'); // coerced to text to match the schema
  assert.equal(captured.length, 1);
  assert.match(captured[0].sql, /ON CONFLICT\(signal_type, signal_id, target_type, target_id\)/);
  assert.equal(captured[0].args[0], 'chat'); // signal_type
  assert.equal(captured[0].args[1], 'chat:19:x@thread.tacv2'); // signal_id
  assert.equal(captured[0].args[2], 'workload'); // target_type
  assert.equal(captured[0].args[3], '42'); // target_id
});

test('linkSignal fails loud on unknown target type and empty target id', () => {
  const db = makeFakeDb([]);
  assert.throws(
    () => sl.linkSignal(db, { signalId: 'email:a', targetType: 'nope', targetId: 1 }),
    /unknown target_type/,
  );
  assert.throws(
    () => sl.linkSignal(db, { signalId: 'email:a', targetType: 'workload', targetId: '  ' }),
    /empty target_id/,
  );
});

test('unlinkSignal deletes exactly the composite identity', () => {
  const captured = [];
  const db = makeFakeDb([{ match: 'DELETE FROM signal_links', run: () => ({ changes: 1 }) }], captured);
  const changes = sl.unlinkSignal(db, {
    signalId: 'meeting:evt-9',
    targetType: 'milestone',
    targetId: 'MS-7',
  });
  assert.equal(changes, 1);
  assert.match(captured[0].sql, /WHERE signal_type = \? AND signal_id = \? AND target_type = \? AND target_id = \?/);
  assert.deepEqual(captured[0].args, ['meeting', 'meeting:evt-9', 'milestone', 'MS-7']);
});

test('listSignalsForTarget validates target type and scopes the query', () => {
  let seenSql = null;
  const db = {
    prepare(sql) {
      seenSql = sql;
      return { all: () => [{ id: 1 }], get: () => undefined };
    },
  };
  const rows = sl.listSignalsForTarget(db, 'opportunity', 'OPP-1');
  assert.equal(rows.length, 1);
  assert.match(seenSql, /WHERE target_type = \? AND target_id = \?/);
  assert.throws(() => sl.listSignalsForTarget(db, 'bogus', 'x'), /unknown target_type/);
});

test('listTargetsForSignal validates the signal id', () => {
  const db = { prepare: () => ({ all: () => [], get: () => undefined }) };
  assert.deepEqual(sl.listTargetsForSignal(db, 'email:a1'), []);
  assert.throws(() => sl.listTargetsForSignal(db, 'bad'), /malformed signal_id/);
});
