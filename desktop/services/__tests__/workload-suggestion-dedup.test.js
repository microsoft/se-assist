'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { dedupeSuggestions, jaccard, normText } = require('../workload-suggestion-dedup');

test('normText/jaccard normalize and score token overlap', () => {
  assert.equal(normText('  Contoso  AZURE—Migration! '), 'contoso azure migration');
  assert.equal(jaccard(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'c'])), 1);
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['c', 'd'])), 0);
});

test('drops a proposal that matches an existing workload for the same account (identical normalized title)', () => {
  const existing = [{ tpid: '111', title: 'Contoso Azure Migration', description: 'Move Contoso workloads to Azure.' }];
  const suggestions = [
    { tpid: '111', title: 'Contoso Azure Migration', description: 'Migrating Contoso to the Azure cloud.' },
    { tpid: '111', title: 'Contoso Security Review', description: 'Review Contoso security posture and identity.' },
  ];
  const kept = dedupeSuggestions(suggestions, existing);
  assert.deepEqual(kept.map((s) => s.title), ['Contoso Security Review']);
});

test('drops a re-worded proposal via high title+description token overlap (not just verbatim)', () => {
  const existing = [{ tpid: '111', title: 'Azure Data Platform Modernization', description: 'Modernize Contoso data platform on Azure Synapse and Fabric.' }];
  const suggestions = [
    // Same account, heavily overlapping wording → duplicate.
    { tpid: '111', title: 'Azure Data Platform Modernization for Contoso', description: 'Modernize the Contoso data platform on Azure Synapse and Fabric.' },
  ];
  assert.equal(dedupeSuggestions(suggestions, existing).length, 0);
});

test('keeps a same-titled proposal for a DIFFERENT account (account is part of the identity)', () => {
  const existing = [{ tpid: '111', title: 'Copilot Rollout', description: 'Deploy Microsoft 365 Copilot.' }];
  const suggestions = [{ tpid: '222', title: 'Copilot Rollout', description: 'Deploy Microsoft 365 Copilot.' }];
  const kept = dedupeSuggestions(suggestions, existing);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].tpid, '222');
});

test('removes near-duplicate proposals within the same batch, preserving the first and order', () => {
  const suggestions = [
    { tpid: '111', title: 'Fabric Analytics Pilot', description: 'Pilot Microsoft Fabric analytics for Contoso finance.' },
    { tpid: '111', title: 'Fabric Analytics Pilot for Contoso', description: 'Pilot Microsoft Fabric analytics for the Contoso finance team.' },
    { tpid: '111', title: 'Security Copilot Evaluation', description: 'Evaluate Security Copilot for the SOC.' },
  ];
  const kept = dedupeSuggestions(suggestions, []);
  assert.deepEqual(kept.map((s) => s.title), ['Fabric Analytics Pilot', 'Security Copilot Evaluation']);
});

test('returns everything when there are no existing workloads and no intra-batch dups', () => {
  const suggestions = [
    { tpid: '111', title: 'Azure Migration', description: 'Lift and shift to Azure.' },
    { tpid: '222', title: 'Copilot Rollout', description: 'Deploy Copilot.' },
  ];
  assert.equal(dedupeSuggestions(suggestions, []).length, 2);
});
