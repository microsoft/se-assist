// The SE Assist agent catalog — the declarative source of truth for every AI feature.
//
// Each entry is a *dedicated agent*: a named capability with its own specialized
// instruction focus, the knowledge blocks it grounds itself in, the tools (grounding
// sources) it needs, its memory configuration, and its model options. This is the
// single place that answers "what AI agents does the app have, and how is each one
// configured" — the runtime executes them and app-ipc wires the concrete render +
// gather implementations by id.
//
// Keeping this metadata separate from the implementation keeps the catalog readable
// and lets a Settings surface enumerate the agents (see runtime.describeAgents()).

'use strict';

// Only the Secretary top-level chat (inbox scope + scan) is pinned to this GitHub Copilot model.
// Deep Research (Work Outputs), the Work Agent and every other agent keep the model selected in Settings.
// A pinned request never falls back: it fails if the model or reasoning level is unavailable.
const SECRETARY_CHAT_MODEL = Object.freeze({ model: 'gpt-5.6-luna', reasoningEffort: 'high' });

const AGENTS = [
  {
    id: 'comprehensive-summary',
    name: 'Relationship Summary Analyst',
    description:
      'Produces a comprehensive, grounded analysis of a customer relationship from Teams, email, meeting, opportunity and milestone signal.',
    knowledge: ['se-assist-persona', 'grounding-contract'],
    tools: ['profileWorkspace', 'accountTeam', 'teamsIntel', 'emailIntel', 'meetingIntel', 'opportunities', 'milestones'],
    memory: 'none',
    model: {},
    presenter: 'summary',
  },
  {
    id: 'tech-stack',
    name: 'Technology Stack Analyst',
    description:
      'Inventories a customer\'s Microsoft and third-party technology from evidenced signal and surfaces whitespace to pitch.',
    knowledge: ['se-assist-persona', 'grounding-contract'],
    tools: ['profileWorkspace', 'teamsIntel', 'emailIntel', 'opportunities', 'milestones'],
    memory: 'none',
    model: {},
    presenter: 'techStack',
  },
  {
    id: 'acr-analysis',
    name: 'Consumption Trend Analyst',
    description:
      'Analyzes Azure Consumed Revenue (monthly $ by service) with profile, stack and pipeline to surface growth opportunities and risks.',
    knowledge: ['se-assist-persona', 'grounding-contract', 'microsoft-solution-families'],
    tools: ['customerProfile', 'acrConsumption', 'techStackBrief', 'opportunities', 'milestones'],
    memory: 'none',
    model: {},
    presenter: 'acr',
  },
  {
    id: 'sales-advisor',
    name: 'Pre-Sales Strategy Coach',
    description:
      'Turns per-account data into a concrete pre-sales action plan: talk tracks, use-case pitches, PoCs, demos, and who to engage.',
    knowledge: ['grounding-contract', 'microsoft-solution-families'],
    tools: ['customerProfile', 'acrConsumption', 'aiCapacity', 'techStackBrief', 'opportunities', 'milestones', 'customerContacts', 'accountTeam', 'teamsIntel', 'emailIntel'],
    memory: 'none',
    model: { maxTokens: 2400 },
    presenter: 'salesAdvisor',
  },
  {
    id: 'workload-suggester',
    name: 'Workload Suggester',
    description:
      'Proposes one or more suggested workloads from the last week of a roster account\'s emails, meetings and Teams chats, each resolved to a real customer (tpid + name) with a title and short description.',
    knowledge: ['grounding-contract'],
    tools: ['emailIntel', 'meetingIntel', 'teamsIntel'],
    memory: 'none',
    // Heaviest agent: a large multi-account prompt + high reasoning can exceed the default 120s
    // deadline, so give it more room. If it still times out, the user narrows the account filter.
    model: { maxTokens: 8000, timeoutMs: 240000 },
  },
  {
    id: 'workload-discoverer',
    name: 'Workload Discoverer',
    description:
      'For ONE account and a user-supplied workload description, picks the specific emails, meetings and Teams chats that fit the description and proposes the workload\'s title, description and category. Used by the "Discover" step of the New workload popup.',
    knowledge: ['grounding-contract'],
    tools: ['emailIntel', 'meetingIntel', 'teamsIntel'],
    memory: 'none',
    model: { maxTokens: 4000, timeoutMs: 180000 },
  },
  {
    id: 'customer-analysis',
    name: 'Account Strategist',
    description:
      'Narrates the deterministic customer-insights facts into a tailored, prioritized account analysis with next-best-actions.',
    knowledge: ['grounding-contract', 'microsoft-solution-families'],
    tools: ['customerProfile', 'customerInsights', 'researchDossier'],
    memory: 'none',
    model: { maxTokens: 2400 },
    presenter: 'customerAnalysis',
  },
  {
    id: 'assistant',
    name: 'SE Assist Copilot',
    description:
      'The conversational work-prioritization assistant: ranks pressing milestones and summarizes what is top of mind per customer.',
    knowledge: ['grounding-contract'],
    tools: ['pressingMilestones', 'topOfMind'],
    memory: { type: 'conversation', maxTurns: 12 },
    model: {},
  },
  {
    id: 'secretary-scope',
    name: 'Secretary Search Scope',
    description:
      'Resolves an optional search instruction for pulled customer email into an explicit time window before any emails are read.',
    knowledge: [],
    tools: [],
    memory: 'none',
    modelRole: 'utility',
    model: { maxTokens: 700, timeoutMs: 120000, ...SECRETARY_CHAT_MODEL },
  },
  {
    id: 'secretary',
    name: 'Secretary',
    description:
      'Reads every customer-linked email already pulled into SE Assist in the time window (last 24 hours by default), received and sent, in bounded batches, carrying open todos forward through longer conversations.',
    knowledge: ['grounding-contract'],
    tools: [],
    memory: 'none',
    model: { maxTokens: 8000, timeoutMs: 180000, ...SECRETARY_CHAT_MODEL },
  },
  {
    id: 'work-agent',
    name: 'Work Agent',
    description:
      'Investigates one action item using live WorkIQ search, source emails and documents, and web-grounded research; returns sourced findings and a draft for user review, explicitly marking access-limited findings as partial.',
    knowledge: ['grounding-contract'],
    tools: ['workiq_search', 'workiq_read_email', 'workiq_read', 'workiq_document', 'web_search', 'web_read'],
    memory: { type: 'conversation', maxTurns: 12 },
    model: { maxTokens: 6000, timeoutMs: 240000, reasoningEffort: 'high' },
    toolLoop: { maxRounds: 12, maxToolRecoveries: 1, allowPartialResults: true },
  },
  {
    id: 'work-output',
    name: 'Work Output Writer',
    description: 'Produces one scoped situation brief, reply draft, action checklist or technical recommendation from saved evidence. Research and retries are managed independently per output.',
    knowledge: ['grounding-contract'],
    tools: [],
    memory: 'none',
    model: { maxTokens: 6000, timeoutMs: 180000, reasoningEffort: 'high' },
  },
  {
    id: 'work-output-public-query',
    name: 'Public Technical Query',
    description: 'Extracts one generic public technical question without private customer or conversation data.',
    knowledge: ['grounding-contract'],
    tools: [],
    memory: 'none',
    modelRole: 'utility',
    model: { maxTokens: 600, timeoutMs: 90000, reasoningEffort: 'high' },
  },
  {
    id: 'work-output-gap-triage',
    name: 'Research Gap Triage',
    description: 'Classifies each open Deep Research gap as answerable from work data, public documentation, a person, or a research limitation, and may suggest one technical question.',
    knowledge: ['grounding-contract'],
    tools: [],
    memory: 'none',
    modelRole: 'utility',
    model: { maxTokens: 3000, timeoutMs: 90000, reasoningEffort: 'high' },
  },
  {
    id: 'work-output-gap-answer',
    name: 'Research Gap Judge',
    description: 'Decides whether retrieved evidence answers one open Deep Research question and returns the answer with a verbatim supporting quote.',
    knowledge: ['grounding-contract'],
    tools: [],
    memory: 'none',
    model: { maxTokens: 2000, timeoutMs: 120000, reasoningEffort: 'high' },
  },
  {
    id: 'meeting-prep',
    name: 'Meeting Prep Assistant',
    description:
      'Identifies the customer + Microsoft products for a meeting and writes a grounded preparatory note.',
    knowledge: ['grounding-contract'],
    tools: ['meetingGrounding', 'knownAccounts', 'productCatalog'],
    memory: 'none',
    model: { maxTokens: 1600 },
  },
  {
    id: 'milestone-signal-finder',
    name: 'Milestone Signal Finder',
    description:
      'Given one engagement milestone and the account\'s recent emails, meetings and Teams chats, surfaces the specific items related to that milestone and why they matter.',
    knowledge: ['se-assist-persona', 'grounding-contract'],
    tools: ['milestoneContext', 'emailIntel', 'meetingIntel', 'teamsIntel'],
    memory: 'none',
    // The three milestone agents below run back-to-back as one "Milestone AI" pass at high
    // reasoning, where a reasoning model spends heavy think-time regardless of the small maxTokens.
    // The default 120s timeout was too tight — the LAST step (HoK) routinely timed out, so it
    // effectively never completed. Give each its own generous per-call budget (independent IPC
    // calls, so these do not sum), with the most headroom for the heaviest/last HoK step.
    model: { maxTokens: 1600, timeoutMs: 180000 },
  },
  {
    id: 'milestone-comment-suggester',
    name: 'Milestone Comment Suggester',
    description:
      'Drafts a concise progress comment for one engagement milestone from the emails, meetings and Teams chats that occurred between the previous comment and today.',
    knowledge: ['se-assist-persona', 'grounding-contract'],
    tools: ['milestoneContext', 'emailIntel', 'meetingIntel', 'teamsIntel'],
    memory: 'none',
    model: { maxTokens: 600, timeoutMs: 180000 },
  },
  {
    id: 'milestone-hok-suggester',
    name: 'Milestone HoK Activity Suggester',
    description:
      'Drafts a suggested HoK activity (subject, description, task category) for one engagement milestone from the emails, meetings and Teams chats already linked to it as Related signal.',
    knowledge: ['se-assist-persona', 'grounding-contract'],
    tools: ['milestoneContext', 'emailIntel', 'meetingIntel', 'teamsIntel'],
    memory: 'none',
    // Last in the chain and heaviest input (its prompt carries every linked signal's body), so it
    // is the one that was timing out — give it the most headroom.
    model: { maxTokens: 700, timeoutMs: 240000 },
  },
  {
    id: 'transcript-summarizer',
    name: 'Meeting Transcript Summarizer',
    description:
      'Summarizes a Teams meeting transcript into a concise recap and structured to-do items for local SE Assist Tasks, grounded strictly in the transcript text.',
    knowledge: ['grounding-contract'],
    tools: [],
    memory: 'none',
    model: { maxTokens: 4000 },
  },
  {
    id: 'org-title-mapper',
    name: 'Org Title Mapper',
    description:
      'Maps a described capability area to the Microsoft directory job-title prefixes most likely to identify the right specialists.',
    knowledge: [],
    tools: [],
    memory: 'none',
    modelRole: 'utility',
    model: { maxTokens: 400 },
  },
  {
    id: 'org-roster-matcher',
    name: 'Org Roster Matcher',
    description:
      'Picks the best-fit people for a capability area from a fixed candidate roster pulled from the directory.',
    knowledge: [],
    tools: ['orgRoster'],
    memory: 'none',
    modelRole: 'utility',
    model: { maxTokens: 1200 },
  },
  {
    id: 'stakeholder-influence-analyst',
    name: 'Stakeholder Influence Analyst',
    description:
      "Judges each listed customer person's observable work stance and adopted suggestions from supplied, email-free transcript and email excerpts, citing verbatim quotes.",
    knowledge: ['grounding-contract'],
    tools: [],
    memory: 'none',
    model: { maxTokens: 6000, timeoutMs: 180000 },
  },
];

const AGENTS_BY_ID = new Map(AGENTS.map((a) => [a.id, a]));

function getAgentSpec(id) {
  return AGENTS_BY_ID.get(id);
}

module.exports = { AGENTS, AGENTS_BY_ID, getAgentSpec, SECRETARY_CHAT_MODEL };
