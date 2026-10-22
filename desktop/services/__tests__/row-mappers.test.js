const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  rowToProfile,
  rowToTodo,
  rowToAsset,
  rowToTimelineEvent,
  rowToTeamsRef,
  rowToTranscript,
} = require('../row-mappers');

test('rowToProfile remaps snake_case columns to camelCase', () => {
  const out = rowToProfile({
    id: 'p1', tpid: '42', display_name: 'Acme', summary: 's',
    relationship_health: 'green', version: 3, deleted_at: null,
    updated_at: 'u', synced_at: 'y',
  });
  assert.deepEqual(out, {
    id: 'p1', tpid: '42', displayName: 'Acme', summary: 's',
    relationshipHealth: 'green', version: 3, deletedAt: null,
    updatedAt: 'u', syncedAt: 'y',
  });
});

test('rowToAsset parses tags_json and defaults to empty array', () => {
  assert.deepEqual(rowToAsset({ tags_json: '["a","b"]' }).tags, ['a', 'b']);
  assert.deepEqual(rowToAsset({ tags_json: null }).tags, []);
});

test('rowToTodo includes nullable workload and meeting associations without leaking action keys', () => {
  const task = rowToTodo({
    id: 't1', profile_id: 'p1', title: 'Follow up',
    customer_name: 'Contoso', customer_tpid: '1001',
    workload_id: 7, workload_name: 'Pilot', meeting_event_id: 'meeting-1', meeting_action_key: 'internal-key',
  });
  assert.equal(task.profileId, 'p1');
  assert.equal(task.customerName, 'Contoso');
  assert.equal(task.workloadId, 7);
  assert.equal(task.workloadName, 'Pilot');
  assert.equal(task.meetingEventId, 'meeting-1');
  assert.equal(Object.hasOwn(task, 'meetingActionKey'), false);
  const legacy = rowToTodo({ id: 'old', profile_id: null, title: 'Old task' });
  assert.equal(legacy.workloadId, null);
  assert.equal(legacy.meetingEventId, null);
  assert.equal(legacy.customerName, null);
});

test('rowToTimelineEvent parses metadata_json and defaults to empty object', () => {
  assert.deepEqual(rowToTimelineEvent({ metadata_json: '{"k":1}' }).metadata, { k: 1 });
  assert.deepEqual(rowToTimelineEvent({ metadata_json: '' }).metadata, {});
});

test('rowToTeamsRef nests sender fields under from', () => {
  const out = rowToTeamsRef({ sender_name: 'Jo', sender_user_id: 'u9' });
  assert.deepEqual(out.from, { name: 'Jo', userId: 'u9' });
  const empty = rowToTeamsRef({});
  assert.deepEqual(empty.from, { name: '', userId: '' });
});

test('rowToTranscript parses extracted_actions_json into actionItems', () => {
  assert.deepEqual(rowToTranscript({ extracted_actions_json: '["do x"]' }).actionItems, ['do x']);
  assert.deepEqual(rowToTranscript({}).actionItems, []);
});
