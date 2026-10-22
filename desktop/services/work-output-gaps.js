'use strict';

// Deep Research gap register. The open questions ("gaps") are derived from the saved outputs on
// every read; work_output_gaps stores only what was added to a gap afterwards: its classification,
// research status, answer and verbatim supporting quote. Everything here is deterministic; the
// models only classify gaps and judge retrieved evidence, and their replies are parsed strictly.

const { OUTPUTS, hash, text, normalized } = require('./work-output-contract');
const { NO_MATCH_NOTICE } = require('./work-output-research');
const { UNCITED_WEB_WARNING } = require('./work-agent-tools');
const { verifyQuote } = require('./stakeholder-influence');

const GAP_KINDS = ['m365', 'public', 'person', 'limitation'];
const RESEARCHABLE_KINDS = ['m365', 'public'];
const RESOLVING_STATUSES = ['answered', 'partial'];
const MAX_TRIAGE_GAPS = 30;
const NOT_FOUND_NOTE = 'The retrieved evidence did not answer this question. This does not establish that the answer does not exist.';
const UNVERIFIED_QUOTE_NOTE = 'A proposed answer was discarded because its supporting quote was not found verbatim in the retrieved evidence.';

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OUTPUT_TITLES = Object.values(OUTPUTS).map(spec => escapeRegExp(spec.title)).join('|');
const UPSTREAM_NOTICE = new RegExp(`^(?:${OUTPUT_TITLES}) is .+ and was not used\\. Facts depending on it remain unverified\\.$`);
const FIXED_NOTICES = new Set([NO_MATCH_NOTICE, UNCITED_WEB_WARNING].map(normalized));

// The limitation an output records when an upstream output could not be used.
function upstreamNotice(title, state) {
  return `${title} is ${state} and was not used. Facts depending on it remain unverified.`;
}

// Downstream outputs prefix an inherited gap with the title of the output that raised it, for
// example "Current situation: Who owns the migration?". The innermost prefix names the origin.
function gapQuestion(raw, area = null) {
  let question = String(raw).trim();
  let origin = area;
  for (let stripped = true; stripped;) {
    stripped = false;
    for (const [key, spec] of Object.entries(OUTPUTS)) {
      if (question.startsWith(`${spec.title}: `)) {
        question = question.slice(spec.title.length + 2).trim();
        origin = key;
        stripped = true;
        break;
      }
    }
  }
  return { question, origin };
}

const gapKey = question => hash(normalized(question));
const rawGapKey = raw => gapKey(gapQuestion(raw).question);

// Research coverage notices are qualifications of the evidence, not questions to research.
const isResearchNotice = question => UPSTREAM_NOTICE.test(question) || FIXED_NOTICES.has(normalized(question));

function gapRecord(row, parseSaved) {
  return {
    key: row.gap_key, text: row.text, kind: row.kind, kindReason: row.kind_reason, status: row.status,
    answer: row.answer, quote: row.quote, query: row.query,
    sources: parseSaved(row.sources_json, 'gap sources'),
    notes: parseSaved(row.notes_json, 'gap notes'),
    error: row.error_json ? parseSaved(row.error_json, 'gap error') : null,
    model: row.model, checkedAt: row.checked_at, updatedAt: row.updated_at,
  };
}

const gapView = record => ({
  kind: record?.kind ?? null, kindReason: record?.kindReason ?? null, status: record?.status ?? 'open',
  answer: record?.answer ?? null, quote: record?.quote ?? null, query: record?.query ?? null,
  sources: record?.sources ?? [], notes: record?.notes ?? [], error: record?.error ?? null,
  model: record?.model ?? null, checkedAt: record?.checkedAt ?? null, updatedAt: record?.updatedAt ?? null,
});

// One entry per distinct question across all outputs, merged with its saved research. A
// researched question that no current output lists any more stays visible as unlisted.
function listGaps(outputs, records) {
  const saved = new Map(records.map(record => [record.key, record]));
  const listed = new Map();
  for (const output of outputs) {
    for (const raw of output.gaps) {
      const { question, origin } = gapQuestion(raw, output.area);
      if (!normalized(question) || isResearchNotice(question)) continue;
      const key = gapKey(question);
      const entry = listed.get(key);
      if (entry) {
        if (!entry.areas.includes(output.area)) entry.areas.push(output.area);
        continue;
      }
      listed.set(key, { key, text: question, origin, areas: [output.area], listed: true, ...gapView(saved.get(key)) });
    }
  }
  const unlisted = records.filter(record => !listed.has(record.key) && record.status !== 'open')
    .map(record => ({ key: record.key, text: record.text, origin: null, areas: [], listed: false, ...gapView(record) }));
  return [...listed.values(), ...unlisted];
}

// Part of an output's saved dependencies: an output is out of date once a question it still
// lists has been answered or partly answered by research.
function researchStamp(areaGaps, records) {
  const keys = new Set(areaGaps.map(rawGapKey));
  const resolved = records.filter(record => RESOLVING_STATUSES.includes(record.status) && keys.has(record.key))
    .map(record => [record.key, record.status, record.answer])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return resolved.length ? { research: hash(resolved) } : {};
}

// Verified research handed to the output writer as evidence.
const researchedGaps = records => records.filter(record => RESOLVING_STATUSES.includes(record.status)).map(record => ({
  question: record.text, kind: record.kind, status: record.status, answer: record.answer, quote: record.quote,
  sources: record.sources, notes: record.notes,
}));

function parseObject(content, message) {
  let value;
  try { value = JSON.parse(content); } catch { throw new Error(message); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value;
}

// Every supplied id must be classified exactly once; otherwise nothing is saved.
function parseGapTriage(content, ids) {
  const invalid = detail => new Error(`The model returned an invalid gap classification${detail ? ` (${detail})` : ''}. No gap was classified; retry classification.`);
  const value = parseObject(content, invalid().message);
  if (!Array.isArray(value.gaps)) throw invalid('gaps is not a list');
  const classified = new Map();
  for (const item of value.gaps) {
    if (!item || typeof item !== 'object' || !ids.includes(item.id)) throw invalid('unknown gap id');
    if (classified.has(item.id)) throw invalid(`${item.id} was classified twice`);
    if (!GAP_KINDS.includes(item.kind)) throw invalid(`${item.id} has an unknown kind`);
    let reason;
    try { reason = text(item.reason, 'Classification reason', 600); } catch (error) { throw invalid(error.message); }
    classified.set(item.id, { kind: item.kind, reason });
  }
  const missing = ids.filter(id => !classified.has(id));
  if (missing.length) throw invalid(`missing ${missing.join(', ')}`);
  let technicalQuestion;
  try { technicalQuestion = text(value.technicalQuestion, 'Suggested technical question', 1200, true) || null; }
  catch (error) { throw invalid(error.message); }
  return { classified, technicalQuestion };
}

function parseGapAnswer(content) {
  const invalid = detail => new Error(`The model returned an invalid research judgment${detail ? ` (${detail})` : ''}. Nothing was saved as an answer; research this gap again.`);
  const value = parseObject(content, invalid().message);
  if (!['answered', 'partial', 'not_found'].includes(value.status)) throw invalid('unknown status');
  if (value.status === 'not_found') return { status: 'not_found', answer: null, quote: null };
  try {
    return { status: value.status, answer: text(value.answer, 'Answer', 2000), quote: text(value.quote, 'Supporting quote', 1000) };
  } catch (error) {
    throw invalid(error.message);
  }
}

// An answer counts only when its quote appears verbatim in the evidence that was retrieved.
function judgedOutcome(judgment, evidenceText) {
  if (judgment.status === 'not_found') return { status: 'still_open', answer: null, quote: null, notes: [NOT_FOUND_NOTE] };
  if (!verifyQuote(judgment.quote, evidenceText)) return { status: 'still_open', answer: null, quote: null, notes: [UNVERIFIED_QUOTE_NOTE] };
  return { status: judgment.status, answer: judgment.answer, quote: judgment.quote, notes: [] };
}

module.exports = {
  GAP_KINDS, RESEARCHABLE_KINDS, RESOLVING_STATUSES, MAX_TRIAGE_GAPS, NOT_FOUND_NOTE, UNVERIFIED_QUOTE_NOTE,
  upstreamNotice, gapQuestion, gapKey, rawGapKey, isResearchNotice, gapRecord, listGaps, researchStamp,
  researchedGaps, parseGapTriage, parseGapAnswer, judgedOutcome,
};
