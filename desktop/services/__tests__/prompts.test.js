const { test } = require('node:test');
const assert = require('node:assert/strict');

const prompts = require('../agents/prompts');

// Minimal fixtures — enough to exercise each builder end-to-end so any missing
// dependency surfaces as a ReferenceError. Every builder must return a
// { systemMessage, userMessage } pair of non-empty strings.
const analysisCtx = { title: 'T', subtitle: 'S', counts: { a: 1 }, analysis: 'body' };
const custCtx = {
  profile: { displayName: 'Acme', tpid: '1', relationshipHealth: 'green', summary: 's' },
  customer: {}, teams: {}, email: {}, meetings: {}, accountTeam: { microsoft: [], customer: [] },
  opportunities: [], milestones: [], todos: [],
};
const assistantCtx = { pressing: [], topOfMind: {} };
const meetingCtx = {
  meeting: { subject: 'M' }, linkedCustomers: [], candidateCustomers: [],
  knownAccounts: [], products: [],
};
const milestoneSignalCtx = {
  milestone: { name: 'MS' }, window: {}, signal: { emails: [], meetings: [], chats: [] },
};

const cases = {
  buildComprehensivePrompt: [custCtx],
  buildTechStackPrompt: [custCtx],
  buildTechStackPresentationPrompt: [analysisCtx],
  buildSummaryPresentationPrompt: [analysisCtx],
  buildAcrAnalysisPrompt: [{ ...custCtx, acr: {} }],
  buildAcrAnalysisPresentationPrompt: [analysisCtx],
  buildSalesAdvisorPrompt: [{ customer: {}, accountTeam: [], contacts: [], opportunities: [], milestones: [], acr: {}, aiCapacity: {} }],
  buildSalesAdvisorPresentationPrompt: [analysisCtx],
  buildCustomerAnalysisPrompt: [custCtx],
  buildCustomerAnalysisPresentationPrompt: [analysisCtx],
  buildAssistantPrompt: [{ userName: 'Me', question: 'q?', history: [], context: assistantCtx }],
  buildAssistantAgentPrompt: [{ userName: 'Me', question: 'q?', context: assistantCtx }],
  buildOrgKeywordPrompt: ['azure ai'],
  buildOrgMatchPrompt: ['azure ai', [{ id: '1', displayName: 'X', jobTitle: 'CSA', department: 'D' }]],
  buildMeetingPrepPrompt: [meetingCtx],
  buildTranscriptSummaryPrompt: [{ subject: 'Review', transcript: 'Ada: I will send the notes.', meetingDate: '2026-10-01' }],
  buildMilestoneSignalPrompt: [milestoneSignalCtx],
  buildMilestoneCommentPrompt: [milestoneSignalCtx],
  buildWorkloadSuggesterPrompt: [{ accounts: [{ tpid: '1', name: 'Acme', emails: [], meetings: [], chats: [] }], since: '2024-01-01T00:00:00.000Z' }],
  buildSecretaryScopePrompt: [{ guidance: 'the last 7 days', now: '2026-09-21T12:00:00.000Z', defaultSince: '2026-09-20T12:00:00.000Z' }],
  buildSecretaryPrompt: [{ userName: 'Me', emails: [{ message_id: 'E1', subject: 'Follow up', from_name: 'A', body_content: 'please send the deck' }] }],
  buildWorkAgentPrompt: [{ userName: 'Me', task: { title: 'Send deck', summary: 'send the deck', priority: 'high' } }],
  buildStakeholderInfluencePrompt: [{ account: 'Acme', people: [], transcripts: [], emailThreads: [] }],
};

for (const [name, args] of Object.entries(cases)) {
  test(`${name} returns a non-empty system/user message pair`, () => {
    const fn = prompts[name];
    assert.equal(typeof fn, 'function', `${name} should be exported`);
    const out = fn(...args);
    assert.ok(out && typeof out === 'object', `${name} should return an object`);
    assert.equal(typeof out.systemMessage, 'string');
    assert.equal(typeof out.userMessage, 'string');
    assert.ok(out.systemMessage.length > 0, `${name} systemMessage should be non-empty`);
    assert.ok(out.userMessage.length > 0, `${name} userMessage should be non-empty`);
  });
}

test('every documented builder is exported', () => {
  assert.equal(Object.keys(cases).length, 23);
  for (const name of Object.keys(cases)) {
    assert.equal(typeof prompts[name], 'function');
  }
});

test('stakeholder influence prompt limits the model to cited, observable work stance', () => {
  const output = prompts.buildStakeholderInfluencePrompt({
    account: 'Contoso',
    people: [{ ref: 'P1', name: 'Dana Lee', title: 'CIO', affiliation: 'contoso.com', score: 72, signals: 'Sent 3 emails.', tags: ['Decision maker'] }],
    transcripts: [{ ref: 'M1', title: 'Roadmap review', date: '2026-10-01T15:00:00Z', text: 'Dana Lee [P1]: Let us pilot in Q3.' }],
    emailThreads: [],
  });
  assert.match(output.systemMessage, /champion.*blocker.*neutral.*unclear/s);
  assert.match(output.systemMessage, /verbatim/);
  assert.match(output.systemMessage, /untrusted data/);
  assert.match(output.systemMessage, /Never infer or mention protected or personal characteristics/);
  assert.match(output.systemMessage, /Activity volume, seniority or job title alone is not a stance/);
  assert.match(output.systemMessage, /STRICT JSON only/);
  assert.match(output.userMessage, /Account: Contoso/);
  assert.match(output.userMessage, /P1 \| Dana Lee \| CIO \| contoso\.com \| score 72/);
  assert.match(output.userMessage, /Tags: Decision maker/);
  assert.match(output.userMessage, /\[M1\] Roadmap review \(2026-10-01T15:00:00Z\)\nDana Lee \[P1\]: Let us pilot in Q3\./);
  assert.match(output.userMessage, /Email threads:\n\(none\)/);
  assert.match(output.userMessage, /"personRef":"P1"/);
  assert.doesNotMatch(output.userMessage, /@/);
});

test('meeting recap prompts require concise grounded actions without inventing owners, dates or Tasks', () => {
  const output = prompts.buildTranscriptSummaryPrompt({
    subject: 'Architecture review', meetingDate: '2026-10-01', transcript: 'Ada: I will send the notes.',
  });
  assert.match(output.systemMessage, /outstanding commitment or follow-up/);
  assert.match(output.systemMessage, /Start its title with an action verb/);
  assert.match(output.systemMessage, /under 240 characters/);
  assert.match(output.systemMessage, /untrusted meeting content/);
  assert.match(output.systemMessage, /completed work/);
  assert.match(output.userMessage, /"todos":\[/);
  assert.match(output.userMessage, /todos must be \[\]/);
  assert.match(output.userMessage, /Meeting date: 2026-10-01/);
  assert.match(output.userMessage, /dueDate must be YYYY-MM-DD or null/);
});

test('Work Agent prompts require real source investigation, private-data boundaries, and a separate reply draft', () => {
  const output = prompts.buildWorkAgentPrompt({
    task: { title: 'Resolve the question', sourceMessageId: 'email-id', webLink: 'https://outlook.office.com/mail/item/test', excerpt: 'A short excerpt', date: '2026-09-01' },
    question: 'Check the latest decision',
  });
  assert.match(output.userMessage, /email-id/);
  assert.match(output.userMessage, /sourceExcerpt/);
  assert.match(output.userMessage, /Check the latest decision/);
  assert.match(output.systemMessage, /read the full source email/i);
  assert.match(output.systemMessage, /workiq_read_email with \{"messageId":null\}/);
  assert.match(output.systemMessage, /short reference from emailReferences/);
  assert.match(output.systemMessage, /exact short path from eventReferences/);
  assert.match(output.systemMessage, /never retype or transform a long event ID/);
  assert.match(output.systemMessage, /not a grant of access/);
  assert.match(output.systemMessage, /outcome "blocked".*excluded, not read or recovered/);
  assert.match(output.systemMessage, /clearly labeled PARTIAL findings/);
  assert.match(output.systemMessage, /ETA is unverified/);
  assert.match(output.systemMessage, /Keep negative findings evidence-scoped/);
  assert.match(output.systemMessage, /current signed-in WorkIQ account only/);
  assert.match(output.systemMessage, /Only starting a new investigation after access changes/);
  assert.match(output.systemMessage, /draft must not contain facts, promises or dates that depend on unread sources/);
  assert.match(output.systemMessage, /Never use application-only bulk-export APIs/);
  assert.doesNotMatch(output.systemMessage, /URL-encode the ID/);
  assert.match(output.systemMessage, /mail address is not necessarily a sign-in name/);
  assert.match(output.systemMessage, /same person, resource and permissions/);
  assert.match(output.systemMessage, /never guess aliases or substitute another person/);
  assert.match(output.systemMessage, /search WorkIQ/);
  assert.match(output.systemMessage, /Choose its scope explicitly/);
  assert.match(output.systemMessage, /email task and related Microsoft 365 conversations uses "m365"/);
  assert.match(output.systemMessage, /never as a fallback after an error/);
  assert.match(output.systemMessage, /tool error is not evidence or an empty search/);
  assert.match(output.systemMessage, /same work-source scope and research intent/);
  assert.match(output.systemMessage, /must succeed before you present a completed solution/);
  assert.match(output.systemMessage, /keep & query-parameter separators literal/);
  assert.match(output.systemMessage, /conversationId-only filter, omit \$orderby/);
  assert.match(output.systemMessage, /web_read/);
  assert.match(output.systemMessage, /material unanswered question or conflicting evidence/);
  assert.match(output.systemMessage, /Do not repeat equivalent searches or reread the same page/);
  assert.match(output.systemMessage, /Citations are optional, not a requirement/);
  assert.match(output.systemMessage, /Use useful uncited web summaries alongside WorkIQ research/);
  assert.match(output.systemMessage, /Missing citations are not a tool failure/);
  assert.match(output.systemMessage, /Do not stop or repeatedly search solely to obtain a citation/);
  assert.match(output.systemMessage, /WorkIQ results without source links are also usable research/);
  assert.match(output.systemMessage, /Distinguish uncited research from facts checked in an original source/);
  assert.doesNotMatch(output.systemMessage, /uncited search summary is a source failure|uncited summaries are rejected/);
  assert.match(output.systemMessage, /GitHub Copilot Bing-backed public web search/);
  assert.match(output.systemMessage, /AI-generated summary, not original page text/);
  assert.match(output.systemMessage, /nextStartIndex/);
  assert.match(output.systemMessage, /untrusted evidence/);
  assert.match(output.systemMessage, /Keep private investigation in WorkIQ/);
  assert.match(output.systemMessage, /Draft:/);
  assert.match(output.systemMessage, /read-only/i);
});

test('Secretary includes every supplied email and its full body rather than a preview cutoff', () => {
  const emails = Array.from({ length: 41 }, (_, i) => ({
    message_id: `email-${i}`,
    conversation_id: `thread-${i}`,
    body_content: `${'context '.repeat(500)}Action at the end ${i}`,
    excerpt: 'An incomplete preview',
  }));
  const output = prompts.buildSecretaryPrompt({ emails, scope: { label: 'the last 24 hours' } });
  assert.match(output.userMessage, /email-40/);
  assert.match(output.userMessage, /Action at the end 40/);
  assert.doesNotMatch(output.userMessage, /An incomplete preview/);
  assert.match(output.systemMessage, /ALL actionable todos/);
  assert.match(output.systemMessage, /untrusted evidence/);
  assert.match(output.systemMessage, /SHARED FOLLOW-UPS/);
  assert.match(output.systemMessage, /Being CC'd is not by itself a task/);
  assert.match(output.systemMessage, /Never pretend the user personally owns another person's commitment/);
  assert.match(output.userMessage, /"ownership": "direct\|shared"/);
});

test('Secretary retains grounded earlier todos while processing a long conversation', () => {
  const output = prompts.buildSecretaryPrompt({
    emails: [{ message_id: 'new', body_content: 'The deck has been sent.' }],
    previousItems: [{ title: 'Send deck', summary: 'Send the requested deck.', priority: 'high', sourceMessageId: 'earlier' }],
  });
  assert.match(output.userMessage, /"sourceMessageId":"earlier"/);
  assert.match(output.systemMessage, /complete UPDATED list/);
  assert.match(output.systemMessage, /Keep every previous item not resolved/);
  assert.match(output.systemMessage, /Remove a previous item only when a later reply provides evidence/);
});

test('Secretary tells the model which stored body it has, who sent each email, and that only customer email is supplied', () => {
  const output = prompts.buildSecretaryPrompt({ emails: [
    { message_id: 'E1', body_content: 'Opening lines only', body_source: 'preview', from_you: true },
    { message_id: 'E2', body_content: 'Whole message', body_source: 'full', from_you: false },
    { message_id: 'E3', body_content: 'Sender unknown' },
  ] });
  const emails = JSON.parse(output.userMessage.split('\n').at(-1)).emails;
  assert.deepEqual(emails.map((email) => [email.messageId, email.bodySource, email.fromYou]), [
    ['E1', 'preview', true], ['E2', 'full', false], ['E3', null, null],
  ]);
  assert.match(output.systemMessage, /already pulled/);
  assert.match(output.systemMessage, /Only email already matched to the user's customer accounts is supplied/);
  assert.match(output.systemMessage, /Treat condensed and preview bodies as incomplete evidence/);
  assert.match(output.systemMessage, /Web addresses are shortened to site and path/);
  assert.match(output.systemMessage, /a request the user sent to others is not the user's task/);
});

test('Secretary scope has explicit dates and does not impose the old 21-day cutoff', () => {
  const output = prompts.buildSecretaryScopePrompt({
    guidance: 'Find todos for Contoso over the last 30 days',
    now: '2026-09-21T12:00:00.000Z',
    defaultSince: '2026-09-20T12:00:00.000Z',
    timeZone: 'Europe/Stockholm',
  });
  assert.match(output.systemMessage, /last 24 hours/);
  assert.match(output.systemMessage, /Do not impose a hidden 21-day cutoff/);
  assert.match(output.systemMessage, /"error"/);
  assert.match(output.userMessage, /last 30 days/);
  assert.match(output.userMessage, /Europe\/Stockholm/);
});
