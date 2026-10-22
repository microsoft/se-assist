'use strict';

// Persistence for the stakeholder influence map (migrations 031-032). Only the user's own
// corrections and the latest AI assessment are stored; the deterministic signals are
// recomputed from the local email / meeting / transcript inventory on every read.

const { STANCES } = require('./stakeholder-influence');

const NOTE_MAX = 500;

function parseResult(json) {
  try {
    const value = JSON.parse(json);
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

function listOverrides(db, tpid) {
  return db.prepare(
    `SELECT person_id, stance, note, hidden, updated_at FROM stakeholder_overrides
     WHERE tpid = ? ORDER BY person_id`,
  ).all(tpid).map((row) => ({
    personId: row.person_id,
    stance: row.stance || null,
    note: row.note || '',
    hidden: Number(row.hidden) === 1,
    updatedAt: row.updated_at,
  }));
}

function getAssessment(db, tpid) {
  const row = db.prepare(
    `SELECT provider, model, analyzed_at, input_hash, result_json FROM stakeholder_assessments
     WHERE tpid = ?`,
  ).get(tpid);
  if (!row) return null;
  return {
    provider: row.provider,
    model: row.model || null,
    analyzedAt: row.analyzed_at,
    inputHash: row.input_hash,
    // undefined when the stored JSON cannot be read; the engine reports that explicitly.
    result: parseResult(row.result_json),
  };
}

// Everything the engine needs for one account, from local tables only.
function loadAccountInputs(db, tpid) {
  const account = db.prepare(
    `SELECT name FROM customers WHERE tpid = ? AND COALESCE(TRIM(name), '') <> ''
     ORDER BY CASE WHEN parent_crm_account_id IS NULL OR parent_crm_account_id = '' THEN 0 ELSE 1 END, name
     LIMIT 1`,
  ).get(tpid);
  const team = db.prepare(
    'SELECT person_name, person_email, org FROM customer_account_team WHERE tpid = ?',
  ).all(tpid);
  const contacts = db.prepare(
    'SELECT full_name, job_title, email FROM customer_contacts WHERE tpid = ?',
  ).all(tpid);
  const emails = db.prepare(
    `SELECT e.message_id, e.conversation_id, e.internet_message_id, e.subject, e.from_name, e.from_address, e.to_json, e.cc_json,
            e.sent_at, e.received_at, e.body_text, e.web_link
     FROM email_customer_links l
     JOIN emails e ON e.message_id = l.message_id
     WHERE l.tpid = ? AND l.match_method <> 'ai-rejected'`,
  ).all(tpid);
  const meetings = db.prepare(
    `SELECT m.event_id, m.subject, m.organizer_name, m.organizer_address, m.attendees_json, m.start_at,
            m.is_cancelled, m.web_link
     FROM meeting_customer_links l
     JOIN meetings m ON m.event_id = l.event_id
     WHERE l.tpid = ? AND l.match_method <> 'ai-rejected'`,
  ).all(tpid);
  const transcripts = db.prepare(
    `SELECT n.event_id, n.transcript
     FROM meeting_customer_links l
     JOIN meeting_notes n ON n.event_id = l.event_id
     WHERE l.tpid = ? AND l.match_method <> 'ai-rejected' AND TRIM(COALESCE(n.transcript, '')) <> ''`,
  ).all(tpid);
  return {
    tpid,
    accountName: account?.name || null,
    team,
    contacts,
    emails,
    meetings,
    transcripts,
    overrides: listOverrides(db, tpid),
    assessment: getAssessment(db, tpid),
  };
}

// Applies a partial correction. A row with no stance, no note and not hidden is deleted.
// Hiding a person also removes the AI's saved judgement about them.
function setOverride(db, { tpid, personId, now = new Date().toISOString(), ...patch } = {}) {
  const account = String(tpid || '').trim();
  const person = String(personId || '').trim();
  if (!account) throw new Error('tpid is required.');
  if (!person) throw new Error('personId is required.');
  if ('stance' in patch && patch.stance != null && patch.stance !== '' && !STANCES.includes(patch.stance)) {
    throw new Error(`Stance must be one of: ${STANCES.join(', ')}.`);
  }
  if ('note' in patch && patch.note != null && typeof patch.note !== 'string') throw new Error('The note must be text.');
  const note = 'note' in patch ? String(patch.note || '').trim() : undefined;
  if (note && note.length > NOTE_MAX) throw new Error(`The note is ${note.length} characters; the limit is ${NOTE_MAX}.`);
  if ('hidden' in patch && typeof patch.hidden !== 'boolean') throw new Error('hidden must be true or false.');
  db.transaction(() => {
    const current = db.prepare(
      'SELECT stance, note, hidden FROM stakeholder_overrides WHERE tpid = ? AND person_id = ?',
    ).get(account, person);
    const next = {
      stance: 'stance' in patch ? (patch.stance || null) : (current?.stance || null),
      note: note !== undefined ? note : (current?.note || ''),
      hidden: 'hidden' in patch ? patch.hidden : Number(current?.hidden) === 1,
    };
    if (!next.stance && !next.note && !next.hidden) {
      db.prepare('DELETE FROM stakeholder_overrides WHERE tpid = ? AND person_id = ?').run(account, person);
    } else {
      db.prepare(
        `INSERT INTO stakeholder_overrides (tpid, person_id, stance, note, hidden, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tpid, person_id) DO UPDATE SET stance = excluded.stance, note = excluded.note,
           hidden = excluded.hidden, updated_at = excluded.updated_at`,
      ).run(account, person, next.stance, next.note, next.hidden ? 1 : 0, now);
    }
    if (next.hidden) {
      const row = db.prepare('SELECT result_json FROM stakeholder_assessments WHERE tpid = ?').get(account);
      const result = row ? parseResult(row.result_json) : undefined;
      if (result && Array.isArray(result.people) && result.people.some((item) => item?.personId === person)) {
        result.people = result.people.filter((item) => item?.personId !== person);
        db.prepare('UPDATE stakeholder_assessments SET result_json = ? WHERE tpid = ?').run(JSON.stringify(result), account);
      }
    }
  })();
  return listOverrides(db, account);
}

function saveAssessment(db, { tpid, provider, model = null, analyzedAt = new Date().toISOString(), inputHash, result }) {
  if (!tpid || !provider || !inputHash || !result) throw new Error('tpid, provider, inputHash and result are required.');
  db.prepare(
    `INSERT INTO stakeholder_assessments (tpid, provider, model, analyzed_at, input_hash, result_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tpid) DO UPDATE SET provider = excluded.provider, model = excluded.model,
       analyzed_at = excluded.analyzed_at, input_hash = excluded.input_hash, result_json = excluded.result_json`,
  ).run(tpid, provider, model || null, analyzedAt, inputHash, JSON.stringify(result));
}

function clearAssessment(db, tpid) {
  return db.prepare('DELETE FROM stakeholder_assessments WHERE tpid = ?').run(tpid).changes > 0;
}

module.exports = {
  NOTE_MAX,
  clearAssessment,
  loadAccountInputs,
  saveAssessment,
  setOverride,
};
