'use strict';

/**
 * meeting-transcript.js — pull a Teams meeting transcript for a completed online meeting.
 *
 * WHY WorkIQ. Transcript access needs delegated Microsoft Graph permission
 * (OnlineMeetingTranscript.Read.All) that the app's Azure CLI / MSAL Graph token does NOT
 * carry — only the WorkIQ M365 Copilot OAuth (the same path that ingests mail/calendar/chat)
 * can read it. So this reuses the app's WorkIQ client exactly like m365-ingest does.
 *
 * FLOW (all delegated, /me):
 *   1. Resolve the meeting's onlineMeeting by its Join URL:
 *      GET /me/onlineMeetings?$filter=JoinWebUrl eq '<joinUrl>'  (works for meetings you
 *      organized; returns empty for others — surfaced honestly, not silently).
 *   2. List transcripts: GET /me/onlineMeetings/{id}/transcripts  (empty when the meeting
 *      was never transcribed — surfaced honestly).
 *   3. Fetch the newest transcript's content as WebVTT:
 *      GET /me/onlineMeetings/{id}/transcripts/{tid}/content?$format=text/vtt
 *      and clean it into readable "Speaker: text" lines.
 *
 * NOTE: the Teams *AI recap* (aiInsights) is intentionally NOT fetched here — WorkIQ's proxy
 * denies that Graph path ("Access denied for GET path .../aiInsights") and the MSAL token
 * lacks the scope, so there is no working path for it. We do not pretend otherwise.
 */

// Parse a Teams WebVTT transcript into readable "Speaker: text" lines, merging consecutive
// cues from the same speaker and dropping the timestamps. Faithful — no summarization.
function cleanVtt(vtt) {
  const text = String(vtt || '');
  if (!/^\s*WEBVTT/i.test(text) && !text.includes('-->')) {
    // Not VTT — return trimmed as-is rather than guessing.
    return text.trim();
  }
  const lines = text.split(/\r?\n/);
  const out = [];
  let lastSpeaker = null;
  let buf = [];
  const flush = () => {
    if (buf.length) {
      const body = buf.join(' ').replace(/\s+/g, ' ').trim();
      if (body) out.push(lastSpeaker ? `${lastSpeaker}: ${body}` : body);
      buf = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^WEBVTT/i.test(line)) continue;
    if (line.includes('-->')) continue;            // timestamp line
    if (/^\s*$/.test(line)) continue;               // blank
    if (/^\d+$/.test(line.trim())) continue;        // cue index
    if (/^NOTE\b/.test(line)) continue;             // VTT note
    // Cue payload. Extract speaker from <v Name>text</v> when present.
    let speaker = null;
    let content = line;
    const m = /^<v\s+([^>]+)>([\s\S]*?)(<\/v>)?\s*$/i.exec(line.trim());
    if (m) { speaker = m[1].trim(); content = m[2]; }
    content = content.replace(/<\/?v[^>]*>/gi, '').replace(/<[^>]+>/g, '').trim();
    if (speaker !== null && speaker !== lastSpeaker) { flush(); lastSpeaker = speaker; }
    if (content) buf.push(content);
  }
  flush();
  return out.join('\n');
}

// Extract the list of distinct speakers (for a small summary line in the UI).
function speakersFromClean(cleaned) {
  const set = new Set();
  for (const line of String(cleaned || '').split('\n')) {
    const m = /^([^:]{1,60}):\s/.exec(line);
    if (m) set.add(m[1].trim());
  }
  return [...set];
}

/**
 * Fetch a meeting's transcript. `wiq` is an already-obtained WorkIQ client (injected for
 * testability). `meeting` is the local row { event_id, subject, is_online_meeting,
 * online_meeting_url }. Returns a discriminated result — always { ok } plus a reason/message
 * so the caller can render an honest state (fail loud, never a silent empty box).
 */
async function fetchTranscript(wiq, meeting) {
  if (!meeting) return { ok: false, reason: 'not_found', message: 'Meeting not found in the local datastore.' };
  const joinUrl = String(meeting.online_meeting_url || '').trim();
  if (!Number(meeting.is_online_meeting) || !joinUrl) {
    return { ok: false, reason: 'not_online', message: 'This is not a Teams online meeting, so it has no transcript.' };
  }

  const ready = await wiq.probe();
  if (!ready.ok) {
    return { ok: false, reason: 'workiq', message: `Teams data is unavailable: ${ready.error || 'WorkIQ not ready'}. Sign in to Microsoft 365 (the WorkIQ/Copilot connection) and try again.` };
  }

  // 1) Resolve the online meeting by its Join URL (delegated /me — organizer only).
  const filter = `/me/onlineMeetings?$filter=JoinWebUrl eq '${joinUrl.replace(/'/g, "''")}'`;
  const resolved = await wiq.fetchOne(filter);
  const om = resolved.value && resolved.value[0];
  if (!om || !om.id) {
    return {
      ok: false,
      reason: 'not_resolvable',
      message: 'Couldn’t open this meeting in Teams. Transcript retrieval works for meetings you organized; for meetings organized by someone else, Teams doesn’t expose the transcript to you here.',
    };
  }

  // 2) List transcripts.
  const list = await wiq.fetchOne(`/me/onlineMeetings/${om.id}/transcripts`);
  const transcripts = Array.isArray(list.value) ? list.value : [];
  if (!transcripts.length) {
    return { ok: true, hasTranscript: false, message: 'No transcript found — this meeting wasn’t transcribed in Teams.' };
  }
  // Newest first.
  transcripts.sort((a, b) => String(b.createdDateTime || '').localeCompare(String(a.createdDateTime || '')));
  const t = transcripts[0];

  // 3) Fetch VTT content.
  const contentRes = await wiq.fetchOne(`/me/onlineMeetings/${om.id}/transcripts/${t.id}/content?$format=text/vtt`);
  const raw = contentRes && contentRes.raw && typeof contentRes.raw.data === 'string' ? contentRes.raw.data : null;
  if (!raw) {
    return { ok: false, reason: 'no_content', message: 'A transcript exists but its content could not be retrieved from Teams.' };
  }
  const cleaned = cleanVtt(raw);
  return {
    ok: true,
    hasTranscript: true,
    transcript: cleaned,
    rawLength: raw.length,
    transcriptCount: transcripts.length,
    createdDateTime: t.createdDateTime || null,
    speakers: speakersFromClean(cleaned),
  };
}

module.exports = { fetchTranscript, cleanVtt, speakersFromClean };
