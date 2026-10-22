'use strict';

const { callPublicWebTool, assertPublicQuery } = require('./work-agent-web');
const { publicSourceUrl } = require('./public-web-page');
const { EMAIL_SOURCE_SELECT, parseMcpPayload, getMcpErrorMessage } = require('./workiq-client');
const { emailBodyText } = require('./email-content');

const MAX_EVIDENCE_CHARS = 24000;
const UNCITED_WEB_WARNING = 'Public web research returned no source citations. Its summary is available as uncited research, not a source-verified page read.';

function requiredText(value, name, maxLength = 2000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  if (value.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters; narrow the request.`);
  return value.trim();
}

function sourceUrl(value, publicOnly = false) {
  if (publicOnly) return publicSourceUrl(value);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalizeEvidence(result, { publicOnly = false, provider = 'WorkIQ' } = {}) {
  if (!result) throw new Error(`${provider} returned no usable research result.`);
  const error = getMcpErrorMessage(result, provider);
  if (error) throw new Error(error);
  const texts = (result.content || []).filter((item) => item.type === 'text').map((item) => item.text);
  const data = parseMcpPayload(result);
  const page = publicOnly && typeof data?.text === 'string' && publicSourceUrl(data.url) ? data : null;
  const text = page ? page.text : data ? JSON.stringify(data) : texts.join('\n');
  if (!text.trim()) throw new Error(`${provider} returned an empty research result.`);
  const sources = new Map();
  const addSource = (url, title) => {
    const safe = sourceUrl(url, publicOnly);
    if (safe && !sources.has(safe)) sources.set(safe, { url: safe, title: String(title || safe).slice(0, 200) });
  };
  const collect = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    for (const key of ['url', 'webUrl', 'webLink', 'link']) {
      if (typeof value[key] === 'string') addSource(value[key], value.title || value.name || value.subject);
    }
    Object.values(value).forEach(collect);
  };
  collect(data);
  if (!page || !Array.isArray(page.references)) {
    for (const match of text.matchAll(/^Title:\s*([^\n]+)\r?\nURL:\s*(https:\/\/\S+)/gm)) addSource(match[2], match[1]);
    for (const match of text.matchAll(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g)) addSource(match[2], match[1]);
    for (const match of text.matchAll(/https:\/\/[^\s<>"\\\])]+/g)) addSource(match[0].replace(/[.,;:]+$/, ''));
  }
  if (publicOnly && !sources.size) {
    throw new Error(`${provider} returned no public web sources. The Work Agent will not substitute an unverified answer.`);
  }
  const truncated = text.length > MAX_EVIDENCE_CHARS || (publicOnly && data?.truncated === true);
  return {
    text: text.slice(0, MAX_EVIDENCE_CHARS),
    truncated,
    ...(truncated ? { notice: data?.notice || 'Evidence was shortened. Make a narrower query or read the specific source for missing detail.' } : {}),
    ...(publicOnly && Number.isInteger(data?.nextStartIndex) ? { nextStartIndex: data.nextStartIndex } : {}),
    ...(page?.redirectNotice ? { redirectNotice: page.redirectNotice } : {}),
    ...(page ? { url: page.url, startIndex: page.startIndex, totalCharacters: page.totalCharacters } : {}),
    sources: [...sources.values()],
  };
}

function isBingSearchUrl(value) {
  try {
    const url = new URL(publicSourceUrl(value));
    return ['www.bing.com', 'bing.com'].includes(url.hostname)
      && url.pathname === '/search' && Boolean(url.searchParams.get('q')?.trim());
  } catch { return false; }
}

function normalizeCopilotSearch(result) {
  const provider = 'GitHub Copilot web search';
  if (!result) throw new Error(`${provider} returned no usable research result.`);
  const error = getMcpErrorMessage(result, provider);
  if (error) throw new Error(error);
  const data = parseMcpPayload(result);
  if (data?.type !== 'output_text' || typeof data.text?.value !== 'string' || !data.text.value.trim()) {
    throw new Error(`${provider} returned an invalid or empty search response.`);
  }
  const annotations = [
    ...(Array.isArray(data.text.annotations) ? data.text.annotations : []),
    ...(Array.isArray(data.annotations) ? data.annotations : []),
  ];
  const sources = new Map();
  for (const annotation of annotations) {
    const citation = annotation?.url_citation;
    const url = publicSourceUrl(citation?.url);
    if (url && !isBingSearchUrl(url) && !sources.has(url)) sources.set(url, { url, title: String(citation.title || url).slice(0, 200) });
  }
  const text = data.text.value;
  return {
    text: text.slice(0, MAX_EVIDENCE_CHARS), sources: [...sources.values()],
    truncated: text.length > MAX_EVIDENCE_CHARS,
    notice: 'This is an AI-generated search summary, not a page read. Citations are optional. Use the returned research alongside other evidence; when source URLs are available, web_read can check important details. Do not invent citations or claim an original page was read.',
    ...(!sources.size ? { warning: UNCITED_WEB_WARNING } : {}),
  };
}

function definition(name, description, properties, required) {
  return { type: 'function', function: {
    name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
  } };
}

function workPath(path) {
  const value = requiredText(path, 'WorkIQ path', 4000);
  if (!/^\/(me|users|chats|teams|groups|drives|sites|communications)(\/|\?|$)/.test(value)
    || /[\\\r\n#]/.test(value) || value.includes('..')) {
    throw new Error('Use a relative Microsoft 365 record path, not an external URL or an action.');
  }
  return value;
}

function calendarResource(path) {
  const url = new URL(path, 'https://graph.microsoft.com');
  const match = /^(\/(?:me|users\/[^/]+)(?:\/calendar|\/calendars\/[^/]+)?\/)(events|calendarView)(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match || (match[2] === 'calendarView' && match[3])) return null;
  return { collection: `${match[1]}events`, id: match[3] ? decodeURIComponent(match[3]) : null, query: url.search };
}

function workSourceKey(resource) {
  const pathname = new URL(workPath(resource), 'https://graph.microsoft.com').pathname;
  const chat = /^\/(?:(?:me|users\/[^/]+)\/)?chats\/([^/]+)(?:\/|$)/.exec(pathname);
  return chat ? `chat:${decodeURIComponent(chat[1])}` : pathname;
}

function isChatSource(url, key) {
  const parsed = new URL(url);
  const match = /^\/l\/(?:chat|message)\/([^/]+)/.exec(parsed.pathname);
  return ['teams.microsoft.com', 'teams.cloud.microsoft'].includes(parsed.hostname)
    && match && `chat:${decodeURIComponent(match[1])}` === key;
}

function accessGuidance(key) {
  return key.startsWith('chat:')
    ? 'A link in an accessible email or chat does not grant access to the linked Teams chat. Ask the chat owner to verify your membership and tenant policy.'
    : 'Ask the source owner or your administrator to verify access for the current WorkIQ account and tenant policy.';
}

function normalizeBlockedSources(value = []) {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid blocked-source context. Start a new investigation.');
  const sources = new Map();
  for (const source of value) {
    if (source?.status !== 403) throw new Error('Invalid blocked-source status. Start a new investigation.');
    const resource = workPath(source.resource);
    const key = workSourceKey(resource);
    const url = source.url == null ? null : sourceUrl(source.url);
    if (source.url != null && (!url || !isChatSource(url, key))) {
      throw new Error('The blocked-source link does not match its Teams chat. Start a new investigation.');
    }
    sources.set(key, {
      kind: key.startsWith('chat:') ? 'Teams chat' : 'Microsoft 365 source',
      resource, status: 403, code: source.code == null ? null : requiredText(source.code, 'Access error code', 200),
      url, guidance: accessGuidance(key),
    });
  }
  return [...sources.values()];
}

function createWorkAgentTools({ client, ensureConnected, signal, sourceMessageId, accountScope, onProgress, privateTerms = [], blockedSources = [], webTool = callPublicWebTool }) {
  let ready = null;
  const webSources = new Set();
  const webEvidence = new Map();
  const workSources = new Map();
  const deniedSources = new Map(normalizeBlockedSources(blockedSources).map(source => [workSourceKey(source.resource), source]));
  const emails = new Map();
  const emailIds = new Map();
  const resolvedUsers = new Map();
  const events = new Map();
  const eventReferences = new Map();
  const eventKey = (collection, id) => JSON.stringify([collection, id]);
  const eventRecord = resource => {
    const record = eventReferences.get(resource.id) || events.get(eventKey(resource.collection, resource.id));
    if (!record || record.collection !== resource.collection) {
      throw Object.assign(new Error('That calendar event reference was not returned for this calendar in this investigation. No source was requested. Use the matching eventReferences path from a Graph events/calendarView result; do not reconstruct, shorten or change a native event ID.'), {
        code: 'WORKIQ_EVENT_REFERENCE_UNKNOWN',
      });
    }
    return record;
  };
  const rememberEmail = (id, metadata = {}) => {
    if (typeof id !== 'string' || !id) return null;
    const known = emails.get(id) || { reference: `email-${emails.size + 1}` };
    const record = {
      ...known,
      ...(metadata.subject ? { subject: metadata.subject } : {}),
      ...(metadata.receivedDateTime ? { receivedAt: metadata.receivedDateTime } : {}),
    };
    emails.set(id, record);
    emailIds.set(record.reference, id);
    return record;
  };
  if (sourceMessageId) rememberEmail(sourceMessageId);
  const emailId = value => {
    const id = requiredText(value === null ? sourceMessageId : value, 'Email message ID', 2000);
    if (emailIds.has(id)) return emailIds.get(id);
    if (emails.has(id)) return id;
    throw Object.assign(new Error('That email reference was not returned in this investigation. Use the matching emailReferences entry, or null for the selected source. Do not reconstruct or shorten an email ID.'), {
      code: 'WORKIQ_EMAIL_REFERENCE_UNKNOWN',
    });
  };
  const assertSource = (medium, id, metadata = '') => {
    if (accountScope && !accountScope.accepts(medium, id, metadata)) {
      throw Object.assign(new Error('This source belongs to an archived account. Re-add its TPID in User Home before reading it.'), { code: 'ACCOUNT_ARCHIVED' });
    }
  };
  const workEvidence = (result, { mail = false, calendar = null } = {}) => {
    let data = parseMcpPayload(result);
    let excluded = 0;
    if (accountScope && data) {
      const error = getMcpErrorMessage(result, 'WorkIQ');
      if (error) throw new Error(error);
      const medium = mail ? 'email' : calendar ? 'meeting' : null;
      const allowed = (record, kind = medium, id = record?.id) => {
        const metadata = JSON.stringify(record);
        const accepted = kind ? accountScope.accepts(kind, id, metadata) : !accountScope.isArchivedText(metadata);
        if (!accepted) excluded++;
        return accepted;
      };
      if (medium && Array.isArray(data.results)) {
        data = { ...data, results: data.results.map(page => {
          if (Array.isArray(page.data?.value)) return { ...page, data: { ...page.data, value: page.data.value.filter(record => allowed(record)) } };
          if (page.data?.id) assertSource(medium, page.data.id, JSON.stringify(page.data));
          return page;
        }) };
      }
      const retrieval = data['application/vnd.ms-workiq.retrieval'];
      if (Array.isArray(retrieval?.retrievalHits)) {
        const media = { Emails: 'email', Meetings: 'meeting', Events: 'meeting', Chats: 'chat' };
        data = { ...data, 'application/vnd.ms-workiq.retrieval': {
          ...retrieval, retrievalHits: retrieval.retrievalHits.filter(hit => allowed(hit, media[hit.entityType] || null, hit.resourceId)),
        } };
        if (excluded) data = { 'application/vnd.ms-workiq.retrieval': { retrievalHits: data['application/vnd.ms-workiq.retrieval'].retrievalHits } };
      } else if (!medium) accountScope.assertText(JSON.stringify(data));
      if (excluded) {
        data = { ...data, rosterNotice: `${excluded} archived-account source(s) excluded.${retrieval ? ' The unscoped search summary was omitted; read the eligible source references for full evidence.' : ''} Re-add the account in User Home to restore access.` };
      }
      result = { ...result, structuredContent: data };
    }
    const evidence = normalizeEvidence(result);
    for (const source of evidence.sources) workSources.set(source.url, source);
    const references = new Map();
    const add = (id, metadata) => {
      const record = rememberEmail(id, metadata);
      if (record) references.set(record.reference, record);
    };
    for (const hit of data?.['application/vnd.ms-workiq.retrieval']?.retrievalHits || []) {
      if (hit.entityType === 'Emails') add(hit.resourceId, { subject: hit.resourceMetadata?.general?.title });
    }
    if (mail) {
      for (const result of data?.results || []) {
        for (const record of Array.isArray(result.data?.value) ? result.data.value : [result.data]) {
          if (record?.id) add(record.id, record);
        }
      }
    }
    const calendarReferences = [];
    if (calendar) {
      for (const page of data?.results || []) {
        if (page.statusCode !== 200) continue;
        for (const record of Array.isArray(page.data?.value) ? page.data.value : [page.data]) {
          if (typeof record?.id !== 'string' || !record.id.trim()) continue;
          const key = eventKey(calendar.collection, record.id);
          const known = events.get(key) || { reference: `event-${events.size + 1}`, collection: calendar.collection, id: record.id };
          events.set(key, known);
          eventReferences.set(known.reference, known);
          calendarReferences.push({
            reference: known.reference, path: `${known.collection}/${known.reference}`,
            subject: record.subject, start: record.start, end: record.end,
          });
        }
      }
    }
    return {
      ...evidence,
      ...(excluded ? { excludedArchivedSources: excluded, notice: data.rosterNotice } : {}),
      ...(references.size ? { emailReferences: [...references.values()] } : {}),
      ...(calendarReferences.length ? { eventReferences: calendarReferences } : {}),
    };
  };
  const accessFailure = (error, resource) => {
    let key;
    let target = null;
    try {
      key = workSourceKey(resource);
      if (key.startsWith('chat:')) target = [...workSources.values()].find(source => isChatSource(source.url, key));
    } catch (decodeError) {
      if (!(decodeError instanceof URIError)) throw decodeError;
      error.message += ' The blocked source link could not be resolved because its identifier is malformed.';
    }
    const guidance = accessGuidance(key || '');
    error.blockedSource = {
      kind: key?.startsWith('chat:') ? 'Teams chat' : 'Microsoft 365 source',
      resource, status: 403, code: error.code || null,
      url: target?.url || null, guidance,
    };
    if (key) {
      deniedSources.set(key, error.blockedSource);
      error.sourceAccessDenied = true;
    }
    error.message += ` ${guidance} This source was not read. Retrying or reconnecting does not grant access.`;
    return error;
  };
  const getBlockedSource = error => error?.statusCode === 403 && error.sourceAccessDenied ? error.blockedSource : null;
  const readWeb = async (name, args) => {
    signal?.throwIfAborted();
    const key = JSON.stringify({ name, args });
    if (webEvidence.has(key)) {
      onProgress?.({ phase: 'reuse', tool: name, label: 'Reusing the identical public research result already retrieved in this investigation.' });
      return webEvidence.get(key);
    }
    const response = await webTool(name, args, {
      signal,
      onRetry: (retry) => onProgress?.({
        phase: 'retry', tool: name,
        label: `${name === 'web_search' ? 'GitHub Copilot search' : 'Public page read'} paused for ${Math.ceil(retry.delayMs / 1000)}s; retrying the same request (${retry.attempt}/${retry.attempts}).`,
        error: retry.error,
      }),
    });
    const result = name === 'web_search' ? normalizeCopilotSearch(response)
      : normalizeEvidence(response, { publicOnly: true, provider: 'Public page read' });
    webEvidence.set(key, result);
    return result;
  };
  const read = async (name, args, onRetry) => {
    signal?.throwIfAborted();
    if (accountScope && name === 'fetch') {
      for (const resource of args.entityUrls) {
        const url = new URL(resource, 'https://graph.microsoft.com');
        accountScope.assertText([...url.searchParams.values()].join(' '));
        const source = /\/(messages|events|chats)\/([^/]+)(?:\/|$)/.exec(url.pathname);
        if (source) assertSource({ messages: 'email', events: 'meeting', chats: 'chat' }[source[1]], decodeURIComponent(source[2]));
        const fields = url.searchParams.getAll('$select').flatMap(value => value.split(','))
          .map(field => field.trim().split('/')[0].toLowerCase()).filter(Boolean);
        const calendar = calendarResource(resource);
        const collection = /^\/(?:me|users\/[^/]+)\/(?:mailFolders\/[^/]+\/)?messages$/.test(url.pathname) || (calendar && !calendar.id);
        if (collection && (!fields.length || fields.some(field => ['*', 'body', 'uniquebody'].includes(field)) || url.searchParams.has('$expand'))) {
          throw Object.assign(new Error('Discover email and meeting metadata first with an explicit $select excluding body, uniqueBody, wildcards, and $expand. Then read an eligible source through its returned reference.'), { code: 'WORKIQ_METADATA_REQUIRED' });
        }
      }
    }
    if (name === 'fetch' && deniedSources.size) {
      for (const resource of args.entityUrls) {
        const denied = deniedSources.get(workSourceKey(resource));
        if (denied) throw Object.assign(new Error('This source already returned HTTP 403 and remains excluded. No permission retry was sent. Start a new investigation after access changes.'), {
          statusCode: 403, code: denied.code, blockedSource: denied, sourceAccessDenied: true,
        });
      }
    }
    if (!ready) ready = ensureConnected({ reason: 'work-agent' });
    const status = await ready;
    signal?.throwIfAborted();
    if (!status?.connected) throw new Error(status?.error || 'Connect WorkIQ in User Home to investigate your work.');
    try {
      return await client.readTool(name, args, 180000, signal, (retry) => {
        onRetry?.(retry);
        onProgress?.({
          phase: 'retry', tool: name,
          label: `WorkIQ ${name}${args.strategy === 'grounding' ? ' (Microsoft 365)' : args.strategy === 'copilot' ? ' (all connected sources)' : ''} returned a backend error. Retrying the same request (${retry.attempt}/${retry.attempts}).`,
          error: retry.error,
        });
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (name === 'fetch' && error.statusCode === 403) {
        throw accessFailure(error, error.resource || args.entityUrls[0]);
      }
      throw error;
    }
  };
  const readWorkResource = async (path) => {
    const userPath = /^\/users\/([^/?]+)(?=\/|\?|$)/.exec(path);
    const address = userPath ? decodeURIComponent(userPath[1]) : null;
    const isAddress = address && /^[^@\s/\\]+@[^@\s/\\]+$/.test(address);
    const key = isAddress ? address.toLowerCase() : null;
    const withUserId = id => `/users/${encodeURIComponent(id)}${path.slice(userPath[0].length)}`;
    const fetch = resource => read('fetch', { entityUrls: [resource] });
    if (key && resolvedUsers.has(key)) return fetch(withUserId(resolvedUsers.get(key)));
    try {
      return await fetch(path);
    } catch (error) {
      if (!isAddress || error.statusCode !== 404
        || !['Request_ResourceNotFound', 'ResourceNotFound'].includes(error.code)) throw error;
      onProgress?.({
        phase: 'resolve', tool: 'workiq_read',
        label: 'WorkIQ could not find the user by this address (HTTP 404). Checking an exact directory email/sign-in match before reading the same resource.',
      });
      // Graph /users/{key} accepts an ID or UPN, not necessarily the user's mail address.
      const literal = address.replace(/'/g, "''");
      const filter = encodeURIComponent(`mail eq '${literal}' or userPrincipalName eq '${literal}'`);
      const lookup = parseMcpPayload(await fetch(`/users?$filter=${filter}&$select=id,mail,userPrincipalName&$top=2`));
      signal?.throwIfAborted();
      const record = lookup?.results?.[0];
      const users = record?.data?.value;
      if (lookup?.results?.length !== 1 || record?.statusCode !== 200 || !Array.isArray(users)) {
        throw new Error('WorkIQ returned an invalid user directory lookup. The requested source was not read.', { cause: error });
      }
      if (users.length !== 1 || record.data['@odata.nextLink']) {
        throw new Error(`${error.message} The exact directory lookup ${users.length === 0 ? 'found no matching user' : 'did not identify a unique user'}. The requested source was not read; no other person was substituted.`, { cause: error });
      }
      const user = users[0];
      if (typeof user?.id !== 'string' || !user.id.trim()
        || ![user.mail, user.userPrincipalName].some(value => typeof value === 'string' && value.toLowerCase() === key)) {
        throw new Error('WorkIQ returned an unverified directory match. The requested source was not read; no other person was substituted.', { cause: error });
      }
      resolvedUsers.set(key, user.id);
      onProgress?.({
        phase: 'resolve', tool: 'workiq_read',
        label: 'Resolved the same person to a verified directory ID. Reading the originally requested resource; its access permissions and query are unchanged.',
      });
      return fetch(withUserId(user.id));
    }
  };
  const queryProperty = { type: 'string', description: 'A focused research question, not instructions to take an action.' };
  return {
    workiq_search: {
      label: ({ scope }) => scope === 'm365' ? 'Searching WorkIQ (Microsoft 365)' : scope === 'enterprise' ? 'Searching WorkIQ (all connected sources)' : 'Searching WorkIQ',
      isRecoverableError: (error) => error?.code === 'WORKIQ_TRANSIENT_TOOL_FAILURE' && error.tool === 'retrieve',
      getRecoveryKey: ({ scope }) => scope,
      recoveryInstructions: 'The search returned no evidence. Rephrase this same research question as a shorter, focused workiq_search query. Keep the exact same scope, work sources and intent; do not replace this search with the public web or claim that it found no results. A successful workiq_search is required before a completed answer.',
      definition: definition('workiq_search', 'Search live work sources. Choose m365 for Outlook emails, Teams, meetings, people, OneDrive and SharePoint. Choose enterprise when researching other connected systems or when the source system is unknown. Choose scope before searching, never switch scopes to work around a failure. Refine queries using relevant names and dates.', {
        query: queryProperty,
        scope: { type: 'string', enum: ['m365', 'enterprise'], description: 'm365 searches the Microsoft 365 index. enterprise searches all connected sources, including federated connectors. Recovery must keep the same scope.' },
      }, ['query', 'scope']),
      execute: async ({ query, scope }) => {
        const strategy = scope === 'm365' ? 'grounding' : scope === 'enterprise' ? 'copilot' : null;
        if (!strategy) throw new Error('Choose an explicit WorkIQ search scope: m365 or enterprise.');
        accountScope?.assertText(query);
        let lastRetry;
        const result = workEvidence(await read('retrieve', {
          query: [requiredText(query, 'WorkIQ query')], strategy,
        }, retry => { lastRetry = retry; }));
        signal?.throwIfAborted();
        if (lastRetry) onProgress?.({
          phase: 'recovered', tool: 'workiq_search', recovered: true,
          label: `WorkIQ search (${scope === 'm365' ? 'Microsoft 365' : 'all connected sources'}) recovered on attempt ${lastRetry.attempt}/${lastRetry.attempts}. The same search returned research; continuing the investigation.`,
        });
        return result;
      },
    },
    workiq_read_email: {
      label: 'Reading the full email',
      getBlockedSource,
      isRecoverableError: error => error?.code === 'WORKIQ_EMAIL_REFERENCE_UNKNOWN',
      getRecoveryKey: () => 'email-reference',
      recoveryInstructions: 'No source was requested. Select the emailReferences entry for the same intended email and call workiq_read_email with its short reference. Use null for the selected source email. Do not guess a new ID or substitute another email. A real access denial is not recoverable.',
      definition: definition('workiq_read_email', 'Read a complete email with its sender, recipients, dates and Outlook link. Pass messageId:null for the selected task source. For another email, use its short reference from emailReferences (e.g. email-2); the app resolves the exact original ID. Exact IDs already returned in this investigation are also accepted, but never reconstruct or shorten them. References are valid only in this investigation. The app constructs the Graph request.', {
        messageId: { type: ['string', 'null'], description: 'Use null for the selected task source, or the short reference from emailReferences, e.g. email-2.' },
      }, ['messageId']),
      execute: async ({ messageId }) => {
        const id = emailId(messageId);
        const result = await read('fetch', {
          entityUrls: [`/me/messages/${encodeURIComponent(id)}?$select=${EMAIL_SOURCE_SELECT}`],
        });
        const error = getMcpErrorMessage(result, 'WorkIQ email read');
        if (error) throw new Error(error);
        const payload = parseMcpPayload(result);
        const record = payload?.results?.[0];
        if (payload?.results?.length !== 1 || record?.statusCode !== 200 || record.data?.id !== id) {
          throw new Error('WorkIQ did not return the requested email record. No other email was substituted.');
        }
        return workEvidence({ structuredContent: { ...payload, results: [{
          ...record,
          data: { ...record.data, body: { contentType: 'text', content: emailBodyText(record.data.body) } },
        }] } }, { mail: true });
      },
    },
    workiq_read: {
      label: 'Reading work sources',
      getBlockedSource,
      isRecoverableError: (error) => ['WORKIQ_EVENT_REFERENCE_UNKNOWN', 'WORKIQ_METADATA_REQUIRED'].includes(error?.code) || (error?.statusCode === 400 && (
        ['RequestBroker--ParseUri', 'InefficientFilter'].includes(error.code)
        || (error.code === 'BadRequest' && /\b(?:Invalid (?:filter|query) (?:clause|option)|Syntax error|Could not find a property named)\b/i.test(error.message))
      )),
      getRecoveryKey: ({ path }, errorCode) => {
        const calendar = calendarResource(path);
        if (calendar?.id) {
          if (errorCode === 'WORKIQ_EVENT_REFERENCE_UNKNOWN') return `event-reference:${calendar.collection}`;
          const record = eventRecord(calendar);
          return `${record.collection}/${encodeURIComponent(record.id)}`;
        }
        return new URL(path, 'https://graph.microsoft.com').pathname;
      },
      recoveryInstructions: 'No evidence was returned. For WORKIQ_METADATA_REQUIRED, keep the same collection and filters, request explicit metadata fields without body or uniqueBody, then use eligible returned references for full reads. For WORKIQ_EVENT_REFERENCE_UNKNOWN, no source was requested: select the same intended event from eventReferences and use its exact short path in the same calendar, preserving the query; never substitute a different meeting or calendar. For a Graph query error, correct URI encoding, invalid Graph properties or unsupported sorting, keeping the same relative resource path, record IDs and intended filters. Encode individual query values, not the entire query string: parameter separators must be literal &, never %26 or &amp;. For InefficientFilter, remove unsupported sorting rather than inventing filter restrictions. Do not replace the failed source or claim an empty result. A successful read of the same resource is required before a completed answer.',
      definition: definition('workiq_read', 'Read Microsoft 365 records via relative Graph paths using exact IDs from previous results and valid Graph property names. For calendar event details, use the short path returned in eventReferences (e.g. /me/events/event-1); the app retains the exact native ID and calendar. Discover events first through a focused Graph events/calendarView query including id,subject,start,end. Search-index meeting IDs are not Graph event references. Never retype or transform a native event ID. Prefer directory IDs for /users paths: mail addresses are not necessarily sign-in names. If a user address returns not-found, the app checks an exact mail/sign-in match and reads the same resource with the verified ID; missing or ambiguous matches fail, never guess another identity. Use workiq_read_email for individual emails instead of constructing an email path. Include $select and $top for collections; keep & query separators literal (never %26 or &amp;) and encode only individual values. Email recipient properties are toRecipients and ccRecipients, never recipients.', {
        path: { type: 'string', description: 'Relative read-only path, e.g. /me/messages/{id}?$select=id,subject,body,webLink' },
      }, ['path']),
      execute: async ({ path }) => {
        const value = workPath(path);
        signal?.throwIfAborted();
        const calendar = calendarResource(value);
        const event = calendar?.id ? eventRecord(calendar) : null;
        const result = await readWorkResource(event ? `${event.collection}/${encodeURIComponent(event.id)}${calendar.query}` : value);
        signal?.throwIfAborted();
        if (event) {
          const error = getMcpErrorMessage(result, 'WorkIQ event read');
          if (error) throw new Error(error);
          const payload = parseMcpPayload(result);
          const record = payload?.results?.[0];
          if (payload?.results?.length !== 1 || record?.statusCode !== 200 || record.data?.id !== event.id) {
            throw new Error('WorkIQ did not return the requested calendar event. No other meeting was substituted.');
          }
        }
        return workEvidence(result, {
          calendar,
          mail: /^\/(?:me|users\/[^/]+)\/(?:mailFolders\/[^/]+\/)?messages(?:\/[^/?]+)?$/.test(new URL(value, 'https://graph.microsoft.com').pathname),
        });
      },
    },
    workiq_document: {
      label: 'Investigating a work document',
      definition: definition('workiq_document', 'Read and investigate a specific OneDrive or SharePoint document returned by WorkIQ. Ask focused questions and request citations. Read-only; cannot create, edit or send anything.', {
        url: { type: 'string', description: 'Exact HTTPS OneDrive or SharePoint document URL from a retrieved source.' },
        question: queryProperty,
      }, ['url', 'question']),
      execute: async ({ url, question }) => {
        accountScope?.assertText(question);
        const target = sourceUrl(requiredText(url, 'Document URL', 4000));
        if (!target || !/(^|\.)(sharepoint\.com|sharepoint-df\.com|1drv\.ms|onedrive\.live\.com)$/i.test(new URL(target).hostname)) {
          throw new Error('Use the OneDrive or SharePoint URL returned by WorkIQ.');
        }
        return workEvidence(await read('ask', {
          question: `Read-only document research. Do not create, modify, send, or share anything. Answer using the supplied document and cite the supporting passages and source URL.\nQuestion: ${requiredText(question, 'Document question')}`,
          fileUrls: [target],
        }));
      },
    },
    web_search: {
      label: 'Searching the public web (GitHub Copilot / Bing)',
      definition: definition('web_search', 'Search the public web using GitHub Copilot Bing-backed search. Only this query is sent to the search service, not the task or conversation. Ask a focused public technical question, preferring official primary sources. Never include customer/account/sender names, confidential text, internal project names, personal data, credentials or customer plans. Returns an AI-generated summary with source URLs when available, not original page text. Citations are optional: use uncited summaries as research, without calling them independently verified. When source URLs are provided, web_read can check important details.', { query: queryProperty }, ['query']),
      execute: async ({ query }) => {
        const question = requiredText(query, 'Public web query', 1000);
        assertPublicQuery(question, privateTerms);
        const evidence = await readWeb('web_search', { query: question });
        for (const source of evidence.sources) webSources.add(source.url);
        return evidence;
      },
    },
    web_read: {
      label: 'Reading the original public web source',
      isRecoverableError: (error) => error?.code === 'WEB_SOURCE_NOT_DISCOVERED',
      getRecoveryKey: () => 'public-web',
      recoveryInstructions: 'No page was fetched. Use an exact public URL already returned by web_search or an earlier web_read. Do not invent or rewrite URLs, including GitHub raw-file paths. If the intended document has not been discovered, use web_search to find it first, then retry web_read on a returned URL. Keep the same research question and intended document; a failed URL validation is not evidence that the document is unavailable.',
      definition: definition('web_read', 'Read an exact public webpage URL returned by web_search or a previous web_read in this investigation directly from its publisher, without credentials or cookies. Follow returned references to verify facts. Do not invent URLs or change hosts/paths to raw GitHub URLs. Private and undiscovered URLs are not permitted. When a page is truncated, use its nextStartIndex as startIndex to read the following part.', {
        url: { type: 'string', description: 'Exact HTTPS source URL returned by web_search or web_read during this investigation.' },
        startIndex: { type: 'number', description: 'Optional zero-based character offset. Use the previous result nextStartIndex to continue a long page.' },
      }, ['url']),
      execute: async ({ url, startIndex = 0 }) => {
        const target = sourceUrl(requiredText(url, 'Public source URL', 4000), true);
        const message = 'Read only a public source returned by web_search or an earlier web_read in this investigation.';
        if (!target) throw new Error(message);
        if (!webSources.has(target)) throw Object.assign(new Error(message), { code: 'WEB_SOURCE_NOT_DISCOVERED' });
        const evidence = await readWeb('web_fetch', {
          url: target, max_length: 18000, start_index: startIndex,
        });
        for (const source of evidence.sources) webSources.add(source.url);
        return evidence;
      },
    },
  };
}

module.exports = { createWorkAgentTools, normalizeEvidence, normalizeCopilotSearch, normalizeBlockedSources, UNCITED_WEB_WARNING };
