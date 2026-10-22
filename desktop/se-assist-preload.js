/**
 * SE Assist preload script.
 * Exposes IPC APIs for SQLite, auth, CRM, and MSX settings to the renderer.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('seAssistAPI', {
  // SQLite CRUD
  dbQuery: (sql, params) => ipcRenderer.invoke('se-db-query', sql, params),
  dbRun: (sql, params) => ipcRenderer.invoke('se-db-run', sql, params),
  beginCrmSync: () => ipcRenderer.invoke('se-crm-sync-begin'),
  endCrmSync: (token) => ipcRenderer.invoke('se-crm-sync-end', token),
  dbBackupList: () => ipcRenderer.invoke('se-db-backup-list'),
  dbBackupNow: () => ipcRenderer.invoke('se-db-backup-now'),
  dbBackupExport: () => ipcRenderer.invoke('se-db-backup-export'),
  dbBackupOpenFolder: () => ipcRenderer.invoke('se-db-backup-open-folder'),
  dbBackupSettings: (patch) => ipcRenderer.invoke('se-db-backup-settings', patch),
  dbBackupRestore: (payload) => ipcRenderer.invoke('se-db-backup-restore', payload),
  workloadCreate: (payload) => ipcRenderer.invoke('se-workload-create', payload),
  workloadApplyTemplate: (payload) => ipcRenderer.invoke('se-workload-apply-template', payload),
  workloadSaveTemplate: (payload) => ipcRenderer.invoke('se-workload-save-template', payload),
  workloadApproveSuggestion: (payload) => ipcRenderer.invoke('se-workload-approve-suggestion', payload),
  suggestWorkloads: (payload) => ipcRenderer.invoke('se-suggest-workloads', payload),
  workloadDiscover: (payload) => ipcRenderer.invoke('se-workload-discover', payload),

  // Auth (shared with MSX)
  ensureAuth: (options) => ipcRenderer.invoke('ensure-auth', options),
  getAuthStatus: () => ipcRenderer.invoke('get-auth-status'),

  // In-app Microsoft (Entra ID) sign-in — the only auth path
  entraSignIn: (options) => ipcRenderer.invoke('entra-sign-in', options),
  entraSignOut: () => ipcRenderer.invoke('entra-sign-out'),
  entraStatus: () => ipcRenderer.invoke('entra-status'),

  // GitHub Copilot model provider — device-flow sign-in + status
  githubSignInStart: () => ipcRenderer.invoke('github-sign-in-start'),
  githubSignInWait: (flowId) => ipcRenderer.invoke('github-sign-in-wait', flowId),
  githubSignOut: () => ipcRenderer.invoke('github-sign-out'),
  githubStatus: () => ipcRenderer.invoke('github-status'),
  copilotProbe: () => ipcRenderer.invoke('copilot-probe'),
  copilotListModels: () => ipcRenderer.invoke('copilot-list-models'),
  copilotSetModel: (modelId) => ipcRenderer.invoke('copilot-set-model', modelId),
  copilotSetUtilityModel: (modelId) => ipcRenderer.invoke('copilot-set-utility-model', modelId),
  modelProviderStatus: () => ipcRenderer.invoke('model-provider-status'),
  modelActivityStatus: () => ipcRenderer.invoke('model-activity-status'),
  onModelActivity: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('se-model-activity', handler);
    return () => ipcRenderer.removeListener('se-model-activity', handler);
  },

  // Owned-account detection (MSX) + customer-data ingestion (WorkIQ)
  deriveOwnedAccounts: () => ipcRenderer.invoke('derive-owned-accounts'),
  applyOwnedAccounts: (tpids) => ipcRenderer.invoke('apply-owned-accounts', tpids),
  workiqStatus: (opts) => ipcRenderer.invoke('workiq-status', opts),
  workiqConnect: () => ipcRenderer.invoke('workiq-connect'),
  workiqDisconnect: () => ipcRenderer.invoke('workiq-disconnect'),
  m365IngestRun: (payload) => ipcRenderer.invoke('m365-ingest-run', payload),
  m365IngestStatus: () => ipcRenderer.invoke('m365-ingest-status'),
  m365AutoIngestSet: (cfg) => ipcRenderer.invoke('m365-autoingest-set', cfg),
  onM365IngestProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('m365-ingest-progress', handler);
    return () => ipcRenderer.removeListener('m365-ingest-progress', handler);
  },

  // CRM (shared with MSX) — payload: { path, method?, query?, body? }
  crmRequest: (payload) => ipcRenderer.invoke('crm-request', payload),

  // MSX Settings (read TPIDs and CRM config)
  getMsxSettings: () => ipcRenderer.invoke('se-get-msx-settings'),

  // App version (from package.json, via Electron app.getVersion())
  getAppVersion: () => ipcRenderer.invoke('se-app-version'),

  // Account roster (editable default-account TPID list)
  getAccountRoster: () => ipcRenderer.invoke('se-get-account-roster'),
  saveAccountRoster: (tpids) => ipcRenderer.invoke('se-save-account-roster', tpids),
  onAccountRosterChanged: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('se-account-roster-changed', handler);
    return () => ipcRenderer.removeListener('se-account-roster-changed', handler);
  },

  // Customer profile cache (local SQLite only)
  getCloudProfiles: () => ipcRenderer.invoke('se-cloud-profiles'),
  listAiAgents: () => ipcRenderer.invoke('se-agents-list'),
  getCustomerWorkspace: (profileId) => ipcRenderer.invoke('se-workspace-get', profileId),
  saveCustomerProfileWorkspace: (payload) => ipcRenderer.invoke('se-workspace-save-profile', payload),
  saveCustomerTodo: (payload) => ipcRenderer.invoke('se-workspace-save-todo', payload),
  deleteCustomerTodo: (payload) => ipcRenderer.invoke('se-workspace-delete-todo', payload),
  getTaskAssignmentOptions: () => ipcRenderer.invoke('se-task-assignment-options'),
  getMeetingTasks: (payload) => ipcRenderer.invoke('se-meeting-tasks-get', payload),
  createMeetingTasks: (payload) => ipcRenderer.invoke('se-meeting-tasks-create', payload),
  saveCustomerAsset: (payload) => ipcRenderer.invoke('se-workspace-save-asset', payload),
  deleteCustomerAsset: (payload) => ipcRenderer.invoke('se-workspace-delete-asset', payload),
  prepareCustomerMeeting: (payload) => ipcRenderer.invoke('se-workspace-prepare-meeting', payload),
  generateCustomerTechStack: (payload) => ipcRenderer.invoke('se-workspace-generate-tech-stack', payload),
  generateAcrAnalysis: (payload) => ipcRenderer.invoke('se-acr-analysis', payload),
  generateSalesAdvisor: (payload) => ipcRenderer.invoke('se-sales-advisor', payload),
  getCustomerResearchDossier: (payload) => ipcRenderer.invoke('se-customer-research-get', payload),
  openCustomerResearchDossier: (payload) => ipcRenderer.invoke('se-customer-research-open', payload),
  getCustomerInsights: (payload) => ipcRenderer.invoke('se-customer-insights', payload),
  generateCustomerAnalysis: (payload) => ipcRenderer.invoke('se-customer-analysis', payload),
  prepareMeetingBrief: (payload) => ipcRenderer.invoke('se-meeting-prep', payload),
  findMilestoneSignal: (payload) => ipcRenderer.invoke('se-milestone-signal', payload),
  getMilestoneSignalLinks: (payload) => ipcRenderer.invoke('se-milestone-signal-links', payload),
  deleteMilestoneSignalLink: (payload) => ipcRenderer.invoke('se-milestone-signal-unlink', payload),
  getMeetingMilestoneLinks: (payload) => ipcRenderer.invoke('se-meeting-milestone-links', payload),
  linkMeetingMilestone: (payload) => ipcRenderer.invoke('se-meeting-link-milestone', payload),
  unlinkMeetingMilestone: (payload) => ipcRenderer.invoke('se-meeting-unlink-milestone', payload),
  getMeetingNotes: (payload) => ipcRenderer.invoke('se-meeting-notes-get', payload),
  saveMeetingNotes: (payload) => ipcRenderer.invoke('se-meeting-notes-save', payload),
  fetchMeetingTranscript: (payload) => ipcRenderer.invoke('se-meeting-fetch-transcript', payload),
  summarizeMeetingTranscript: (payload) => ipcRenderer.invoke('se-meeting-summarize-transcript', payload),
  workloadSignalList: (payload) => ipcRenderer.invoke('se-workload-signal-list', payload),
  workloadSignalAssign: (payload) => ipcRenderer.invoke('se-workload-signal-assign', payload),
  workloadSignalUpdate: (payload) => ipcRenderer.invoke('se-workload-signal-update', payload),
  workloadSignalUnlink: (payload) => ipcRenderer.invoke('se-workload-signal-unlink', payload),
  suggestMilestoneComment: (payload) => ipcRenderer.invoke('se-milestone-comment-suggest', payload),
  suggestMilestoneHokActivity: (payload) => ipcRenderer.invoke('se-milestone-hok-suggest', payload),
  listSignals: (payload) => ipcRenderer.invoke('se-signals-list', payload),
  getSignalDetail: (payload) => ipcRenderer.invoke('se-signal-detail', payload),
  untagSignal: (payload) => ipcRenderer.invoke('se-signal-untag', payload),

  // My Org (org chart)
  orgGetTree: (payload) => ipcRenderer.invoke('org-get-tree', payload),
  orgGetReports: (payload) => ipcRenderer.invoke('org-get-reports', payload),
  orgSearchPeople: (payload) => ipcRenderer.invoke('org-search-people', payload),
  resolvePersonByEmail: (payload) => ipcRenderer.invoke('se-resolve-person-by-email', payload),
  orgCustomerTeam: (payload) => ipcRenderer.invoke('org-customer-team', payload),
  orgCustomerRelationships: (payload) => ipcRenderer.invoke('org-customer-relationships', payload),
  influenceMapGet: (payload) => ipcRenderer.invoke('influence-map-get', payload),
  influenceMapAnalyze: (payload) => ipcRenderer.invoke('influence-map-analyze', payload),
  influenceOverrideSet: (payload) => ipcRenderer.invoke('influence-override-set', payload),
  influenceAssessmentClear: (payload) => ipcRenderer.invoke('influence-assessment-clear', payload),
  orgProductSearch: (payload) => ipcRenderer.invoke('org-product-search', payload),
  orgPersonActivity: (payload) => ipcRenderer.invoke('org-person-activity', payload),
  orgGetSchedule: (payload) => ipcRenderer.invoke('org-get-schedule', payload),
  orgFindMeetingTimes: (payload) => ipcRenderer.invoke('org-find-meeting-times', payload),
  customerSearchDocuments: (payload) => ipcRenderer.invoke('customer-search-documents', payload),
  deleteTimelineEvent: (payload) => ipcRenderer.invoke('se-workspace-delete-timeline-event', payload),
  assistantChat: (payload) => ipcRenderer.invoke('se-assistant-chat', payload),
  secretaryScan: (payload) => ipcRenderer.invoke('se-secretary-scan', payload),
  workOutputOpen: (payload) => ipcRenderer.invoke('se-work-output-open', payload),
  workOutputGet: (payload) => ipcRenderer.invoke('se-work-output-get', payload),
  workOutputRun: (payload) => ipcRenderer.invoke('se-work-output-run', payload),
  workOutputCancel: (payload) => ipcRenderer.invoke('se-work-output-cancel', payload),
  workOutputTasks: (payload) => ipcRenderer.invoke('se-work-output-tasks', payload),
  workOutputReply: (payload) => ipcRenderer.invoke('se-work-output-reply', payload),
  workOutputList: (payload) => ipcRenderer.invoke('se-work-output-list', payload),
  workOutputRemove: (payload) => ipcRenderer.invoke('se-work-output-remove', payload),
  workOutputGapTriage: (payload) => ipcRenderer.invoke('se-work-output-gap-triage', payload),
  workOutputGapResearch: (payload) => ipcRenderer.invoke('se-work-output-gap-research', payload),
  emailSearch: (payload) => ipcRenderer.invoke('se-email-search', payload),
  emailDetail: (payload) => ipcRenderer.invoke('se-email-detail', payload),
  onWorkOutputProgress: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('se-work-output-progress', handler);
    return () => ipcRenderer.removeListener('se-work-output-progress', handler);
  },
  workAgentChat: (payload) => ipcRenderer.invoke('se-work-agent-chat', payload),
  workAgentCancel: (payload) => ipcRenderer.invoke('se-work-agent-cancel', payload),
  onWorkAgentProgress: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('se-work-agent-progress', handler);
    return () => ipcRenderer.removeListener('se-work-agent-progress', handler);
  },
  workloadTodoAdd: (payload) => ipcRenderer.invoke('se-workload-todo-add', payload),
  secretaryReplyDraft: (payload) => ipcRenderer.invoke('se-secretary-reply-draft', payload),

  // Seismic (DocCenter) content
  seismicStatus: () => ipcRenderer.invoke('seismic-status'),
  seismicSignIn: () => ipcRenderer.invoke('seismic-sign-in'),
  seismicSignOut: () => ipcRenderer.invoke('seismic-sign-out'),
  seismicSearch: (payload) => ipcRenderer.invoke('seismic-search', payload),

  // Azure Consumed Revenue (ACR) — MSX-I Power BI model
  acrAccountServices: (payload) => ipcRenderer.invoke('acr-account-services', payload),
  acrModels: (payload) => ipcRenderer.invoke('acr-models', payload),
  acrAnthropicSpend: (payload) => ipcRenderer.invoke('acr-anthropic-spend', payload),
  acrServiceHierarchy: (payload) => ipcRenderer.invoke('acr-service-hierarchy', payload),
  acrServiceValues: (payload) => ipcRenderer.invoke('acr-service-values', payload),
  acrPortfolio: (payload) => ipcRenderer.invoke('acr-portfolio', payload),
  acrQuery: (payload) => ipcRenderer.invoke('acr-query', payload),
  acrPeriods: () => ipcRenderer.invoke('acr-periods'),
  acrSnapshot: (payload) => ipcRenderer.invoke('acr-snapshot', payload),
  acrSnapshotStatus: () => ipcRenderer.invoke('acr-snapshot-status'),
  acrInsights: (payload) => ipcRenderer.invoke('acr-insights', payload),
  // Live ACR pull progress (start / rows-so-far / throttle countdown / done).
  onAcrProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('acr-progress', handler);
    return () => ipcRenderer.removeListener('acr-progress', handler);
  },

  // AI capacity allocation — Power BI portfolio and customer drilldown
  capacityPortfolio: (payload) => ipcRenderer.invoke('capacity-portfolio', payload),
  customerCapacity: (payload) => ipcRenderer.invoke('capacity-customer', payload),
  customerCapacitySubscriptions: (payload) => ipcRenderer.invoke('capacity-customer-subscriptions', payload),

  // Foundry Deep-Dives — rolling 90-day token usage
  foundryUsagePortfolio: (payload) => ipcRenderer.invoke('foundry-usage-portfolio', payload),
  foundryUsageCustomer: (payload) => ipcRenderer.invoke('foundry-usage-customer', payload),

  // Open URL in default browser (via main process)
  openExternal: (url) => ipcRenderer.invoke('se-open-external', url),

  copyMilestoneTeamsMessage: (payload) => ipcRenderer.invoke('se-copy-milestone-teams-message', payload),

  // Open a generated HTML file in the default browser (sandboxed to generated dir)
  openFile: (filePath) => ipcRenderer.invoke('se-open-file', filePath),

  // Fetch external URL via main process (bypasses webview CSP)
  fetchExternal: (url) => ipcRenderer.invoke('se-fetch-external', url),

  // Privacy: permanently delete all locally stored data (signs the user out)
  wipeLocalData: () => ipcRenderer.invoke('se-wipe-local-data'),

  // Utilities
  isElectron: true,
});
