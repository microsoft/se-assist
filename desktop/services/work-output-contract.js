'use strict';

const crypto = require('node:crypto');

const OUTPUTS = {
  situation: {
    title: 'Current situation',
    scope: 'Full source email and one focused Microsoft 365 search for directly related recent status, changes and decisions.',
    instruction: 'Return at most five short bullets: the ask, latest confirmed position, what changed, what needs my attention, and any material blocker. Check whether the ask is already resolved. Do not summarize every message.',
    dependencies: [],
  },
  actions: {
    title: 'Action checklist',
    scope: 'Full source email, available situation/technical findings, and one focused Microsoft 365 search for commitments, owners, deadlines and dependencies.',
    instruction: 'Return concrete, nonduplicated next steps, not vague research suggestions. Separate confirmed owners from suggested owners. A dueDate must be explicitly confirmed in evidence, never estimated. Dependencies are plain-language prerequisites. An empty list is valid when no actions remain.',
    dependencies: ['situation', 'technical'],
  },
  technical: {
    title: 'Technical recommendation',
    scope: 'One focused Microsoft 365 requirements search and one public technical search, preferring official product documentation. No unrelated web research.',
    instruction: 'Answer only the specified technical question. Give the recommended approach, the important trade-offs, confirmed customer constraints and unresolved assumptions. Public search summaries are research, not proof that original pages were read. Cite returned sources when available; citations are optional.',
    dependencies: ['situation'],
  },
  reply: {
    title: 'Reply draft',
    scope: 'Full source email and currently usable saved outputs. No additional work or public searches.',
    instruction: 'Write only a concise ready-to-send reply to the source email, with no internal analysis, source list or Draft marker. Address the actual ask. Do not disclose internal details, promise unapproved work or assert unverified dates. Ask precise questions for missing facts. Nothing has been sent. Do not pretend unavailable outputs were researched.',
    dependencies: ['situation', 'actions', 'technical'],
  },
};
const DEFAULT_OUTPUTS = ['situation', 'actions', 'reply'];
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const normalized = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const actionKey = item => hash([normalized(item.title), normalized(item.owner || '')]);

function text(value, label, max = 6000, optional = false) {
  if (optional && value == null) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) {
    throw new Error(`${label} must be ${optional ? 'at most' : '1 to'} ${max} characters.`);
  }
  return value.trim();
}

function strings(value, label, max = 20) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be an array of at most ${max} items.`);
  return value.map(item => text(item, label, 1500));
}

function parseOutput(content, area) {
  let value;
  try { value = JSON.parse(content); }
  catch { throw new Error('The model returned invalid output JSON. Saved research was kept; retry this area to generate it again.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.needsInput !== 'boolean') {
    throw new Error('The model returned an invalid output object.');
  }
  const result = {
    content: text(value.content, 'Output text', 12000),
    gaps: strings(value.gaps, 'Unresolved questions'),
    needsInput: value.needsInput,
    actions: [],
  };
  if (!Array.isArray(value.actions) || value.actions.length > 12 || (area !== 'actions' && value.actions.length)) {
    throw new Error('The model returned an invalid action checklist.');
  }
  const seen = new Set();
  result.actions = value.actions.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Invalid checklist item.');
    const owner = text(item.owner, 'Action owner', 200, true) || null;
    if (!['confirmed', 'suggested', 'unassigned'].includes(item.ownerStatus)
      || (owner === null) !== (item.ownerStatus === 'unassigned')) throw new Error('Invalid action owner qualification.');
    const dueDate = text(item.dueDate, 'Confirmed due date', 10, true) || null;
    if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(Date.parse(dueDate))
      || new Date(dueDate).toISOString().slice(0, 10) !== dueDate || item.dueDateConfirmed !== true)) {
      throw new Error('Action deadlines must be confirmed YYYY-MM-DD dates or null.');
    }
    const action = {
      title: text(item.title, 'Action title', 240),
      description: text(item.description, 'Action description', 2000, true),
      owner, ownerStatus: item.ownerStatus, dueDate,
      dependsOn: strings(item.dependsOn, 'Action prerequisites', 8),
      evidence: text(item.evidence, 'Action evidence or suggestion qualification', 1500),
    };
    return { ...action, key: actionKey(action) };
  }).filter(item => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
  if (result.needsInput && !result.gaps.length) throw new Error('An output that needs input must explain what is missing.');
  return result;
}

module.exports = { OUTPUTS, DEFAULT_OUTPUTS, hash, text, normalized, parseOutput };
