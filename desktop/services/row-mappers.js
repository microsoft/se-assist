// ── DB row → API object mappers ──────────────────────────────────────
// Pure functions that translate snake_case SQLite rows into the camelCase
// shapes the renderer consumes. Extracted verbatim from app-ipc.js — no
// behavior changes.

function rowToProfile(row) {
  return {
    id: row.id,
    tpid: row.tpid,
    displayName: row.display_name,
    summary: row.summary,
    relationshipHealth: row.relationship_health,
    version: row.version,
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  };
}

function rowToTodo(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    customerName: row.customer_name || null,
    customerTpid: row.customer_tpid || null,
    workloadId: row.workload_id ?? null,
    workloadName: row.workload_name || null,
    meetingEventId: row.meeting_event_id || null,
    title: row.title,
    description: row.description,
    status: row.status,
    dueAt: row.due_at,
    sourceRef: row.source_ref,
    version: row.version,
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  };
}

function rowToAsset(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    assetType: row.asset_type,
    title: row.title,
    url: row.url,
    tags: JSON.parse(row.tags_json || '[]'),
    freshnessLabel: row.freshness_label,
    notes: row.notes,
    version: row.version,
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  };
}

function rowToTimelineEvent(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    eventType: row.event_type,
    source: row.source,
    sourceId: row.source_id,
    title: row.title,
    occurredAt: row.occurred_at,
    summary: row.summary,
    metadata: JSON.parse(row.metadata_json || '{}'),
    relevanceScore: row.relevance_score,
    version: row.version,
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  };
}

function rowToEmailRef(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    graphMessageId: row.graph_message_id,
    conversationId: row.conversation_id,
    subject: row.subject,
    senderEmail: row.sender_email,
    sentAt: row.sent_at,
    snippet: row.snippet,
    participants: JSON.parse(row.participants_json || '[]'),
    version: row.version,
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  };
}

function rowToMeetingRef(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    graphEventId: row.graph_event_id,
    subject: row.subject,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    organizerEmail: row.organizer_email,
    attendees: JSON.parse(row.attendees_json || '[]'),
    transcriptRef: row.transcript_ref,
    prepStatus: row.prep_status,
    version: row.version,
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  };
}

function rowToTeamsRef(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    chatId: row.chat_id,
    teamId: row.team_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    createdAt: row.created_at,
    from: {
      name: row.sender_name || '',
      userId: row.sender_user_id || '',
    },
    mentionSummary: row.mention_summary,
    version: row.version,
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  };
}

function rowToTranscript(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    meetingRefId: row.meeting_ref_id,
    title: row.title,
    recordedAt: row.recorded_at,
    storageUri: row.storage_uri,
    summary: row.summary,
    actionItems: JSON.parse(row.extracted_actions_json || '[]'),
    version: row.version,
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  };
}

module.exports = {
  rowToProfile,
  rowToTodo,
  rowToAsset,
  rowToTimelineEvent,
  rowToEmailRef,
  rowToMeetingRef,
  rowToTeamsRef,
  rowToTranscript,
};
