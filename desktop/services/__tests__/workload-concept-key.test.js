'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeConceptKey, deriveConceptKey, dropDismissedByKey, MAX_KEY_LEN,
} = require('../workload-concept-key');

test('normalizeConceptKey slugifies to kebab-case', () => {
  assert.equal(normalizeConceptKey('Fabric Data Migration'), 'fabric-data-migration');
  assert.equal(normalizeConceptKey('Copilot / Agents @ Work!'), 'copilot-agents-work');
  assert.equal(normalizeConceptKey('  SAP on Azure  '), 'sap-on-azure');
});

test('normalizeConceptKey collapses separators and trims stray hyphens', () => {
  assert.equal(normalizeConceptKey('a---b__c   d'), 'a-b-c-d');
  assert.equal(normalizeConceptKey('---leading-and-trailing---'), 'leading-and-trailing');
  assert.equal(normalizeConceptKey('already-kebab-case'), 'already-kebab-case');
});

test('normalizeConceptKey returns empty string for empty/garbage input', () => {
  assert.equal(normalizeConceptKey(''), '');
  assert.equal(normalizeConceptKey(null), '');
  assert.equal(normalizeConceptKey(undefined), '');
  assert.equal(normalizeConceptKey('***'), '');
  assert.equal(normalizeConceptKey('   '), '');
});

test('normalizeConceptKey caps length and never leaves a trailing hyphen', () => {
  const long = 'word '.repeat(40); // 200 chars of "word "
  const key = normalizeConceptKey(long);
  assert.ok(key.length <= MAX_KEY_LEN, `key length ${key.length} should be <= ${MAX_KEY_LEN}`);
  assert.ok(!key.endsWith('-'), 'capped key must not end with a hyphen');
  assert.ok(!key.startsWith('-'), 'key must not start with a hyphen');
});

test('deriveConceptKey falls back to a title-derived slug', () => {
  assert.equal(deriveConceptKey('Migrate SQL to Azure'), 'migrate-sql-to-azure');
  assert.equal(deriveConceptKey(''), '');
});

test('dropDismissedByKey removes only exact (tpid, conceptKey) matches', () => {
  const dismissed = new Map([
    ['100', new Set(['fabric-data-migration'])],
    ['200', new Set(['copilot-adoption'])],
  ]);
  const suggestions = [
    { tpid: '100', conceptKey: 'fabric-data-migration', title: 'A' }, // dismissed -> drop
    { tpid: '100', conceptKey: 'copilot-adoption', title: 'B' },      // different effort -> keep
    { tpid: '200', conceptKey: 'copilot-adoption', title: 'C' },      // dismissed for 200 -> drop
    { tpid: '300', conceptKey: 'fabric-data-migration', title: 'D' }, // other account -> keep
  ];
  const kept = dropDismissedByKey(suggestions, dismissed);
  assert.deepEqual(kept.map((s) => s.title), ['B', 'D']);
});

test('dropDismissedByKey normalizes the suggestion key before matching', () => {
  const dismissed = new Map([['100', new Set(['fabric-data-migration'])]]);
  // Model re-emitted the same effort with different casing/spacing — still suppressed.
  const kept = dropDismissedByKey(
    [{ tpid: '100', conceptKey: 'Fabric  Data  Migration', title: 'A' }],
    dismissed,
  );
  assert.equal(kept.length, 0);
});

test('dropDismissedByKey is a no-op when nothing is dismissed', () => {
  const suggestions = [{ tpid: '1', conceptKey: 'x', title: 'A' }];
  assert.deepEqual(dropDismissedByKey(suggestions, new Map()), suggestions);
  assert.deepEqual(dropDismissedByKey(suggestions, null), suggestions);
});

test('dropDismissedByKey keeps suggestions with no resolvable key', () => {
  const dismissed = new Map([['100', new Set(['fabric-data-migration'])]]);
  const kept = dropDismissedByKey([{ tpid: '100', conceptKey: '', title: 'A' }], dismissed);
  assert.equal(kept.length, 1);
});
