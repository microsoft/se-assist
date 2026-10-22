'use strict';

const crypto = require('node:crypto');
const { listTasks, saveTask } = require('./customer-tasks');

const transcriptHash = text => crypto.createHash('sha256').update(text.trim()).digest('hex');
const actionKey = item => crypto.createHash('sha256').update(
  [item.title, item.owner || ''].map(value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()).join('\n'),
).digest('hex');

function text(value, label, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || (!optional && !value.trim())) throw new Error(`The meeting recap has an invalid ${label}.`);
  return value.trim() || null;
}

function validateActions(value) {
  if (!Array.isArray(value)) throw new Error('The meeting recap must include a to-do items array.');
  const seen = new Set();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('The meeting recap has an invalid to-do item.');
    const title = text(item.title, 'to-do title');
    if (title.length > 240) throw new Error('Meeting to-do titles must be concise (240 characters or fewer).');
    const dueDate = text(item.dueDate, 'to-do due date', true);
    if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)
      || !Number.isFinite(Date.parse(dueDate)) || new Date(dueDate).toISOString().slice(0, 10) !== dueDate)) {
      throw new Error('The meeting recap has an invalid to-do due date; use YYYY-MM-DD or null.');
    }
    return {
      title, description: text(item.description, 'to-do description', true) || '',
      owner: text(item.owner, 'to-do owner', true), dueDate,
    };
  }).filter(item => {
    const key = actionKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseTranscriptSummary(content) {
  let value;
  try { value = JSON.parse(content); }
  catch { throw new Error('The AI returned an invalid meeting recap. No summary or Tasks were saved. Try summarizing again.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The AI returned an invalid meeting recap object.');
  const list = key => {
    if (!Array.isArray(value[key])) throw new Error(`The meeting recap must include ${key} as an array.`);
    return value[key].map(item => text(item, key));
  };
  const actionItems = validateActions(value.todos);
  const bullets = key => {
    const items = list(key);
    return items.length ? items.map(item => `- ${item}`) : ['- None recorded.'];
  };
  const lines = [
    `Summary: ${text(value.summary, 'summary')}`,
    '',
    'Key points:', ...bullets('keyPoints'),
    '',
    'Decisions:', ...bullets('decisions'),
    '',
    'To-do items:',
    ...(actionItems.length ? actionItems.map(item => `- ${item.title}${item.description ? `: ${item.description}` : ''}${item.owner ? `; Owner: ${item.owner}` : ''}${item.dueDate ? `; Due: ${item.dueDate}` : ''}`) : ['- None recorded.']),
    '',
    'Risks / open questions:', ...bullets('risks'),
  ];
  return { summary: lines.join('\n'), actionItems };
}

function getMeeting(database, eventId) {
  if (typeof eventId !== 'string' || !eventId.trim()) throw new Error('eventId is required.');
  const meeting = database.prepare('SELECT event_id, subject, start_at FROM active_meetings WHERE event_id = ?').get(eventId);
  if (!meeting) throw new Error('Meeting not found in the local datastore.');
  return meeting;
}

function getSavedActions(notes) {
  if (notes?.summary_actions_json == null) return null;
  let value;
  try { value = JSON.parse(notes.summary_actions_json); }
  catch { throw new Error('Saved meeting to-do items are invalid. Summarize the transcript again.'); }
  return validateActions(value);
}

function getMeetingTasks(database, eventId) {
  getMeeting(database, eventId);
  const notes = database.prepare('SELECT * FROM meeting_notes WHERE event_id = ?').get(eventId);
  const actionItems = getSavedActions(notes);
  return {
    ok: true, tasks: listTasks(database, { meetingEventId: eventId }),
    canCreateTasks: actionItems !== null && notes.summary_transcript_hash === transcriptHash(notes.transcript || ''),
    actionItemCount: actionItems?.length || 0,
  };
}

function getReusableSummary(notes, transcript) {
  if (!notes?.summary?.trim() || notes.summary_transcript_hash !== transcriptHash(transcript)) return null;
  const actionItems = getSavedActions(notes);
  return actionItems === null ? null : { summary: notes.summary, actionItems };
}

function saveSummary(database, eventId, transcript, recap, previousNotes) {
  database.transaction(() => {
    getMeeting(database, eventId);
    const current = database.prepare('SELECT * FROM meeting_notes WHERE event_id = ?').get(eventId);
    if ((current?.transcript || '') !== (previousNotes?.transcript || '')
      || (current?.summary || '') !== (previousNotes?.summary || '')) {
      throw new Error('Meeting notes changed while the summary was being generated. Your edits were kept; summarize again.');
    }
    database.prepare(`
      INSERT INTO meeting_notes (event_id, transcript, summary, summary_actions_json, summary_transcript_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(event_id) DO UPDATE SET
        transcript = excluded.transcript, summary = excluded.summary,
        summary_actions_json = excluded.summary_actions_json,
        summary_transcript_hash = excluded.summary_transcript_hash, updated_at = CURRENT_TIMESTAMP
    `).run(eventId, transcript, recap.summary, JSON.stringify(recap.actionItems), transcriptHash(transcript));
  })();
}

function meetingCustomer(database, eventId) {
  const tags = database.prepare(`
    SELECT DISTINCT tpid FROM active_meeting_customer_links
    WHERE event_id = ? AND match_method <> 'ai-rejected' AND TRIM(tpid) <> ''
  `).all(eventId);
  if (tags.length !== 1) return {
    profileId: null,
    note: tags.length ? 'Multiple customers are tagged; Tasks start with customer Unselected.'
      : 'No customer is tagged; Tasks start with customer Unselected.',
  };
  const tpid = tags[0].tpid;
  let profile = database.prepare(`
    SELECT id FROM active_cached_customer_profiles WHERE tpid = ? AND deleted_at IS NULL ORDER BY id LIMIT 1
  `).get(tpid);
  if (!profile) {
    const customer = database.prepare(`
      SELECT name FROM active_customers WHERE tpid = ?
      ORDER BY CASE WHEN parent_crm_account_id IS NULL OR parent_crm_account_id = '' THEN 0 ELSE 1 END, name LIMIT 1
    `).get(tpid);
    if (!customer) throw new Error('The meeting customer is no longer in the datastore. Update the meeting tag before creating Tasks.');
    profile = { id: crypto.randomUUID() };
    database.prepare(`
      INSERT INTO cached_customer_profiles (id, tpid, display_name, updated_at) VALUES (?, ?, ?, ?)
    `).run(profile.id, tpid, customer.name, new Date().toISOString());
  }
  return { profileId: profile.id, note: 'New Tasks use the meeting customer; workload starts as None.' };
}

function createMeetingTasks(database, eventId) {
  return database.transaction(() => {
    getMeeting(database, eventId);
    const notes = database.prepare('SELECT * FROM meeting_notes WHERE event_id = ?').get(eventId);
    const actionItems = getSavedActions(notes);
    if (actionItems === null || notes.summary_transcript_hash !== transcriptHash(notes.transcript || '')) {
      throw new Error('Generate a summary with to-do items before creating Tasks. Edited notes need to be summarized again.');
    }
    let createdCount = 0;
    let existingCount = 0;
    let deletedCount = 0;
    let customer;
    for (const item of actionItems) {
      const key = actionKey(item);
      const existing = database.prepare(`
        SELECT deleted_at FROM active_cached_customer_todos WHERE meeting_event_id = ? AND meeting_action_key = ?
      `).get(eventId, key);
      if (existing) {
        if (existing.deleted_at) deletedCount++;
        else existingCount++;
        continue;
      }
      customer ||= meetingCustomer(database, eventId);
      saveTask(database, {
        profileId: customer.profileId, title: item.title,
        description: [item.description, item.owner ? `Owner: ${item.owner}` : ''].filter(Boolean).join('\n'),
        dueAt: item.dueDate, sourceRef: `meeting:${eventId}`,
      }, { meetingEventId: eventId, meetingActionKey: key });
      createdCount++;
    }
    return {
      ...getMeetingTasks(database, eventId), createdCount, existingCount, deletedCount,
      customerNote: customer?.note || '',
    };
  })();
}

module.exports = {
  parseTranscriptSummary, getMeeting, getMeetingTasks, getReusableSummary, saveSummary, createMeetingTasks,
};
