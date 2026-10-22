'use strict';

const { EMAIL_SOURCE_SELECT, parseMcpPayload, getMcpErrorMessage } = require('./workiq-client');
const { emailBodyText, isProtectedMessageNotice } = require('./email-content');
const { normalizeEvidence, normalizeCopilotSearch } = require('./work-agent-tools');
const { callPublicWebTool, assertPublicQuery } = require('./work-agent-web');

const MAX_SOURCE_CHARS = 160000;
const MAX_CONTEXT_CHARS = 240000;
const NO_MATCH_NOTICE = 'No matches in this focused work search; this does not establish that the information does not exist.';

function bounded(evidence) {
  if (evidence.text.length > MAX_SOURCE_CHARS) {
    throw new Error('This source exceeds the output research budget. No text was silently truncated. Narrow the research focus or review this source directly.');
  }
  return evidence;
}

function workSearchEvidence(result) {
  const error = getMcpErrorMessage(result, 'WorkIQ search');
  if (error) throw new Error(error);
  const data = parseMcpPayload(result);
  const retrieval = data?.['application/vnd.ms-workiq.retrieval'];
  const plain = (result?.content || []).filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n').trim();
  const markdown = typeof retrieval?.markdown === 'string' ? retrieval.markdown.trim() : '';
  const hits = Array.isArray(retrieval?.retrievalHits) ? retrieval.retrievalHits : [];
  const noResults = retrieval?.resultCount === 0 && !hits.length;
  const text = markdown || (hits.length ? JSON.stringify(hits) : !data ? plain : '');
  if (!text && !noResults) throw new Error('WorkIQ returned no usable research envelope. An empty object is not evidence.');
  const evidence = normalizeEvidence(result);
  return bounded({
    text: text || 'The focused search returned no matches.',
    sources: evidence.sources,
    gaps: noResults ? [NO_MATCH_NOTICE] : [],
  });
}

function createOutputResearch({ client, ensureConnected, signal, onProgress, webTool = callPublicWebTool }) {
  let ready;
  const read = async (name, args) => {
    signal.throwIfAborted();
    ready ||= ensureConnected({ reason: 'work-output' });
    const connected = await ready;
    signal.throwIfAborted();
    if (!connected?.connected) throw new Error(connected?.error || 'Connect WorkIQ to research this output.');
    const result = await client.readTool(name, args, 90000, signal, retry => onProgress({
      phase: 'retry', label: `Retrying the same WorkIQ request (${retry.attempt}/${retry.attempts}).`,
      error: retry.error,
    }));
    signal.throwIfAborted();
    return result;
  };
  return {
    async source(task) {
      if (!task.sourceMessageId) throw new Error('This research subject has no source email ID. Open the email again from Deep Research search.');
      const result = await read('fetch', { entityUrls: [`/me/messages/${encodeURIComponent(task.sourceMessageId)}?$select=${EMAIL_SOURCE_SELECT}`] });
      const error = getMcpErrorMessage(result, 'Source email');
      if (error) throw new Error(error);
      const payload = parseMcpPayload(result);
      const record = payload?.results?.[0];
      if (payload?.results?.length !== 1 || record?.statusCode !== 200 || record.data?.id !== task.sourceMessageId
        || typeof record.data.body?.content !== 'string') throw new Error('WorkIQ did not return the exact full source email.');
      const email = record.data;
      const body = emailBodyText(email.body);
      if (isProtectedMessageNotice(body)) {
        throw new Error('WorkIQ returned a protected-message notice, not the source email content. Open the message in Outlook; it cannot support a generated output yet.');
      }
      return bounded({
        text: JSON.stringify({
          subject: email.subject, from: email.from, to: email.toRecipients, cc: email.ccRecipients,
          receivedAt: email.receivedDateTime, sentAt: email.sentDateTime, body,
        }),
        sources: normalizeEvidence(result).sources, gaps: [],
      });
    },
    async workSearch(query) {
      return workSearchEvidence(await read('retrieve', { query: [query], strategy: 'grounding' }));
    },
    async publicSearch(query, privateTerms) {
      assertPublicQuery(query, privateTerms);
      const result = await webTool('web_search', { query }, {
        signal, onRetry: retry => onProgress({
          phase: 'retry', label: `Public research paused; retrying the same query (${retry.attempt}/${retry.attempts}).`,
          error: retry.error,
        }),
      });
      signal.throwIfAborted();
      const evidence = normalizeCopilotSearch(result);
      if (evidence.truncated) throw new Error('Public research exceeded the output budget. Narrow the technical question; no incomplete summary was used.');
      return { text: evidence.text, sources: evidence.sources, gaps: evidence.warning ? [evidence.warning] : [] };
    },
  };
}

module.exports = { createOutputResearch, workSearchEvidence, MAX_CONTEXT_CHARS, NO_MATCH_NOTICE };
