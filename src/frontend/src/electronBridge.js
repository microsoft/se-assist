/**
 * Electron bridge for SE Assist.
 * Wraps IPC calls to main process for SQLite, auth, CRM, and account settings.
 * Falls back to in-memory/localStorage if not in Electron.
 */

const isElectron = typeof window !== 'undefined' && window.seAssistAPI;
export const ACCOUNT_ROSTER_CHANGED_EVENT = 'se-assist:account-roster-changed';

export function onAccountRosterChanged(callback) {
  if (!isElectron) return () => {};
  if (!window.seAssistAPI.onAccountRosterChanged) throw new Error('Active-roster notifications are unavailable. Restart or update the desktop app.');
  return window.seAssistAPI.onAccountRosterChanged(callback);
}

// ── SQLite via IPC ──────────────────────────────────────────────────

export async function dbQuery(sql, params = []) {
  if (!isElectron) return [];
  return window.seAssistAPI.dbQuery(sql, params);
}

export async function dbRun(sql, params = []) {
  if (!isElectron) return { changes: 0 };
  return window.seAssistAPI.dbRun(sql, params);
}

export async function withCrmSync(work) {
  if (!isElectron || !window.seAssistAPI.beginCrmSync || !window.seAssistAPI.endCrmSync) {
    throw new Error('CRM sync requires an updated desktop app. Restart SE Assist before syncing.');
  }
  const token = await window.seAssistAPI.beginCrmSync();
  try {
    return await work();
  } finally {
    await window.seAssistAPI.endCrmSync(token);
  }
}

// ── Database backups ─────────────────────────────────────────────────
export async function dbBackupList() {
  if (!isElectron || !window.seAssistAPI.dbBackupList) return { ok: false, error: 'Not in Electron', backups: [] };
  return window.seAssistAPI.dbBackupList();
}

export async function dbBackupNow() {
  if (!isElectron || !window.seAssistAPI.dbBackupNow) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.dbBackupNow();
}

export async function dbBackupExport() {
  if (!isElectron || !window.seAssistAPI.dbBackupExport) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.dbBackupExport();
}

export async function dbBackupOpenFolder() {
  if (!isElectron || !window.seAssistAPI.dbBackupOpenFolder) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.dbBackupOpenFolder();
}

export async function dbBackupSettings(patch) {
  if (!isElectron || !window.seAssistAPI.dbBackupSettings) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.dbBackupSettings(patch);
}

export async function dbBackupRestore(payload) {
  if (!isElectron || !window.seAssistAPI.dbBackupRestore) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.dbBackupRestore(payload);
}

export async function workloadCreate(payload) {
  if (!isElectron || !window.seAssistAPI.workloadCreate) throw new Error('Workload creation requires the desktop app.');
  return window.seAssistAPI.workloadCreate(payload);
}

export async function workloadApplyTemplate(payload) {
  if (!isElectron || !window.seAssistAPI.workloadApplyTemplate) throw new Error('Workload templates require the desktop app.');
  return window.seAssistAPI.workloadApplyTemplate(payload);
}

export async function workloadSaveTemplate(payload) {
  if (!isElectron || !window.seAssistAPI.workloadSaveTemplate) throw new Error('Workload templates require the desktop app.');
  return window.seAssistAPI.workloadSaveTemplate(payload);
}

export async function workloadApproveSuggestion(payload) {
  if (!isElectron || !window.seAssistAPI.workloadApproveSuggestion) throw new Error('Approving a suggested workload requires the desktop app.');
  return window.seAssistAPI.workloadApproveSuggestion(payload);
}

export async function suggestWorkloads(payload) {
  if (!isElectron || !window.seAssistAPI.suggestWorkloads) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.suggestWorkloads(payload);
}

export async function workloadDiscover(payload) {
  if (!isElectron || !window.seAssistAPI.workloadDiscover) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.workloadDiscover(payload);
}

// ── Auth (shared with MSX) ──────────────────────────────────────────

export async function ensureAuth(options = {}) {
  if (!isElectron) return { error: 'Not in Electron' };
  return window.seAssistAPI.ensureAuth(options);
}

export async function getAuthStatus() {
  if (!isElectron) return { isAuthenticated: false };
  return window.seAssistAPI.getAuthStatus();
}

// In-app Microsoft (Entra ID) sign-in — the only auth path.
export async function entraSignIn(options = {}) {
  if (!isElectron || !window.seAssistAPI.entraSignIn) return { success: false, error: 'Not in Electron' };
  return window.seAssistAPI.entraSignIn(options);
}

export async function entraSignOut() {
  if (!isElectron || !window.seAssistAPI.entraSignOut) return { success: false, error: 'Not in Electron' };
  return window.seAssistAPI.entraSignOut();
}

export async function entraStatus() {
  if (!isElectron || !window.seAssistAPI.entraStatus) return { signedIn: false };
  return window.seAssistAPI.entraStatus();
}

// GitHub Copilot model provider — device-flow sign-in + status.
export async function githubSignInStart() {
  if (!isElectron || !window.seAssistAPI.githubSignInStart) return { error: 'Not in Electron' };
  return window.seAssistAPI.githubSignInStart();
}

export async function githubSignInWait(flowId) {
  if (!isElectron || !window.seAssistAPI.githubSignInWait) return { signedIn: false, error: 'Not in Electron' };
  return window.seAssistAPI.githubSignInWait(flowId);
}

export async function githubSignOut() {
  if (!isElectron || !window.seAssistAPI.githubSignOut) return { signedIn: false };
  return window.seAssistAPI.githubSignOut();
}

export async function githubStatus() {
  if (!isElectron || !window.seAssistAPI.githubStatus) return { signedIn: false };
  return window.seAssistAPI.githubStatus();
}

export async function copilotProbe() {
  if (!isElectron || !window.seAssistAPI.copilotProbe) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.copilotProbe();
}

export async function copilotListModels() {
  if (!isElectron || !window.seAssistAPI.copilotListModels) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.copilotListModels();
}

export async function copilotSetModel(modelId) {
  if (!isElectron || !window.seAssistAPI.copilotSetModel) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.copilotSetModel(modelId);
}

export async function copilotSetUtilityModel(modelId) {
  if (!isElectron || !window.seAssistAPI.copilotSetUtilityModel) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.copilotSetUtilityModel(modelId);
}

export async function modelProviderStatus() {
  if (!isElectron || !window.seAssistAPI.modelProviderStatus) return { active: null };
  return window.seAssistAPI.modelProviderStatus();
}

export async function modelActivityStatus() {
  if (!isElectron || !window.seAssistAPI.modelActivityStatus) {
    return { phase: 'idle', running: 0, queued: 0, cooldownUntil: null, requests: [] };
  }
  return window.seAssistAPI.modelActivityStatus();
}

export function onModelActivity(cb) {
  if (!isElectron || !window.seAssistAPI.onModelActivity) return () => {};
  return window.seAssistAPI.onModelActivity(cb);
}

// Owned-account detection (MSX) + customer-data ingestion (WorkIQ)
export async function deriveOwnedAccounts() {
  if (!isElectron || !window.seAssistAPI.deriveOwnedAccounts) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.deriveOwnedAccounts();
}

export async function applyOwnedAccounts(tpids) {
  if (!isElectron || !window.seAssistAPI.applyOwnedAccounts) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.applyOwnedAccounts(tpids);
}

export async function workiqStatus(opts) {
  if (!isElectron || !window.seAssistAPI.workiqStatus) return { ok: false, error: 'Not in Electron', connected: false, account: null };
  return window.seAssistAPI.workiqStatus(opts);
}

export async function workiqConnect() {
  if (!isElectron || !window.seAssistAPI.workiqConnect) return { success: false, error: 'Not in Electron' };
  return window.seAssistAPI.workiqConnect();
}

export async function workiqDisconnect() {
  if (!isElectron || !window.seAssistAPI.workiqDisconnect) return { success: false, error: 'Not in Electron' };
  return window.seAssistAPI.workiqDisconnect();
}

export async function m365IngestRun(payload) {
  if (!isElectron || !window.seAssistAPI.m365IngestRun) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.m365IngestRun(payload);
}

export async function m365IngestStatus() {
  if (!isElectron || !window.seAssistAPI.m365IngestStatus) return { running: false };
  return window.seAssistAPI.m365IngestStatus();
}

export async function m365AutoIngestSet(cfg) {
  if (!isElectron || !window.seAssistAPI.m365AutoIngestSet) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.m365AutoIngestSet(cfg);
}

export function onM365IngestProgress(cb) {
  if (!isElectron || !window.seAssistAPI.onM365IngestProgress) return () => {};
  return window.seAssistAPI.onM365IngestProgress(cb);
}

// ── Privacy ─────────────────────────────────────────────────────────
// Permanently deletes all locally stored data (SQLite tables, encrypted
// sign-in tokens, generated reports, Teams staging copies, prefs). Irreversible.
export async function wipeLocalData() {
  if (!isElectron || !window.seAssistAPI.wipeLocalData) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.wipeLocalData();
}

// ── CRM (shared with MSX) ───────────────────────────────────────────
// payload: { path, method?, query?, body? }
// Returns: { ok, status, data: { value: [...] } }

export async function crmRequest(payload) {
  if (!isElectron) return { ok: false, status: 0, data: { message: 'Not in Electron' } };
  return window.seAssistAPI.crmRequest(payload);
}

// ── MSX Settings (read default TPIDs and CRM config) ────────────────

export async function getMsxSettings() {
  if (!isElectron) return { accounts: [], crmUrl: '', tenantId: '' };
  return window.seAssistAPI.getMsxSettings();
}

// App version — live from package.json (Electron app.getVersion()).
export async function getAppVersion() {
  if (!isElectron || !window.seAssistAPI.getAppVersion) return null;
  try {
    return await window.seAssistAPI.getAppVersion();
  } catch {
    return null;
  }
}

// Dedicated AI agents catalog (Settings → About). Read-only self-description of
// every AI feature: its instruction focus, knowledge, tools, memory, and model.
export async function listAiAgents() {
  if (!isElectron || !window.seAssistAPI.listAiAgents) return [];
  try {
    return (await window.seAssistAPI.listAiAgents()) || [];
  } catch {
    return [];
  }
}

export async function getMsxTpids() {
  const settings = await getMsxSettings();
  return (settings.accounts || []).map(a => a.tpid || a.id).filter(Boolean);
}

// ── Account roster (editable default-account list) ──────────────────

export async function getAccountRoster() {
  if (!isElectron) return { tpids: [], isCustom: false };
  if (!window.seAssistAPI.getAccountRoster) throw new Error('Active-roster access is unavailable. Restart or update the desktop app.');
  return window.seAssistAPI.getAccountRoster();
}

export async function resolvePersonByEmail(payload) {
  if (!isElectron || !window.seAssistAPI.resolvePersonByEmail) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.resolvePersonByEmail(payload);
}

export async function saveAccountRoster(tpids) {
  if (!isElectron || !window.seAssistAPI.saveAccountRoster) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.saveAccountRoster(tpids);
}

// ── Customer profile cache (local SQLite only) ───────────────────────

export async function getCloudProfiles() {
  if (!isElectron || !window.seAssistAPI.getCloudProfiles) return [];
  return window.seAssistAPI.getCloudProfiles();
}

export async function getCustomerWorkspace(profileId) {
  if (!isElectron || !window.seAssistAPI.getCustomerWorkspace) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.getCustomerWorkspace(profileId);
}

export async function saveCustomerProfileWorkspace(payload) {
  if (!isElectron || !window.seAssistAPI.saveCustomerProfileWorkspace) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.saveCustomerProfileWorkspace(payload);
}

export async function saveCustomerTodo(payload) {
  if (!isElectron || !window.seAssistAPI.saveCustomerTodo) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.saveCustomerTodo(payload);
}

export async function deleteCustomerTodo(payload) {
  if (!isElectron || !window.seAssistAPI.deleteCustomerTodo) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.deleteCustomerTodo(payload);
}

export async function getTaskAssignmentOptions() {
  if (!isElectron || !window.seAssistAPI.getTaskAssignmentOptions) return { ok: false, error: 'Task assignments require the updated desktop app. Restart SE Assist.' };
  return window.seAssistAPI.getTaskAssignmentOptions();
}

export async function getMeetingTasks(payload) {
  if (!isElectron || !window.seAssistAPI.getMeetingTasks) return { ok: false, error: 'Meeting Tasks require the updated desktop app. Restart SE Assist.' };
  return window.seAssistAPI.getMeetingTasks(payload);
}

export async function createMeetingTasks(payload) {
  if (!isElectron || !window.seAssistAPI.createMeetingTasks) return { ok: false, error: 'Creating meeting Tasks requires the updated desktop app. Restart SE Assist.' };
  return window.seAssistAPI.createMeetingTasks(payload);
}

export async function saveCustomerAsset(payload) {
  if (!isElectron || !window.seAssistAPI.saveCustomerAsset) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.saveCustomerAsset(payload);
}

export async function deleteCustomerAsset(payload) {
  if (!isElectron || !window.seAssistAPI.deleteCustomerAsset) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.deleteCustomerAsset(payload);
}

export async function prepareCustomerMeeting(payload) {
  if (!isElectron || !window.seAssistAPI.prepareCustomerMeeting) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.prepareCustomerMeeting(payload);
}

export async function generateCustomerTechStack(payload) {
  if (!isElectron || !window.seAssistAPI.generateCustomerTechStack) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.generateCustomerTechStack(payload);
}

export async function deleteTimelineEvent(payload) {
  if (!isElectron || !window.seAssistAPI.deleteTimelineEvent) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.deleteTimelineEvent(payload);
}

// Seismic (DocCenter) content integration.
export async function seismicStatus() {
  if (!isElectron || !window.seAssistAPI.seismicStatus) return { signedIn: false };
  return window.seAssistAPI.seismicStatus();
}

export async function seismicSignIn() {
  if (!isElectron || !window.seAssistAPI.seismicSignIn) return { signedIn: false, error: 'Not in Electron' };
  return window.seAssistAPI.seismicSignIn();
}

export async function seismicSignOut() {
  if (!isElectron || !window.seAssistAPI.seismicSignOut) return { signedIn: false };
  return window.seAssistAPI.seismicSignOut();
}

export async function seismicSearch(payload) {
  if (!isElectron || !window.seAssistAPI.seismicSearch) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.seismicSearch(payload);
}

// ── Azure Consumed Revenue (ACR) — MSX-I Power BI model ──────────────
export async function acrAccountServices(payload) {
  if (!isElectron || !window.seAssistAPI.acrAccountServices) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.acrAccountServices(payload);
}

export async function acrModels(payload) {
  if (!isElectron || !window.seAssistAPI.acrModels) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.acrModels(payload);
}

export async function acrAnthropicSpend(payload) {
  if (!isElectron) return { ok: false, error: 'Anthropic spend requires the SE Assist desktop app.' };
  if (!window.seAssistAPI.acrAnthropicSpend) {
    return { ok: false, error: 'Restart SE Assist fully to load the Anthropic spend connection.' };
  }
  return window.seAssistAPI.acrAnthropicSpend(payload);
}

export async function acrServiceHierarchy(payload) {
  if (!isElectron || !window.seAssistAPI.acrServiceHierarchy) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.acrServiceHierarchy(payload);
}

export async function acrServiceValues(payload) {
  if (!isElectron || !window.seAssistAPI.acrServiceValues) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.acrServiceValues(payload);
}

export async function acrPortfolio(payload) {
  if (!isElectron || !window.seAssistAPI.acrPortfolio) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.acrPortfolio(payload);
}

export async function acrQuery(payload) {
  if (!isElectron || !window.seAssistAPI.acrQuery) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.acrQuery(payload);
}

// Subscribe to live ACR pull progress events. Returns an unsubscribe function
// (a no-op outside Electron). Mirrors onM365IngestProgress.
export function onAcrProgress(cb) {
  if (!isElectron || !window.seAssistAPI.onAcrProgress) return () => {};
  return window.seAssistAPI.onAcrProgress(cb);
}

export async function acrPeriods() {
  if (!isElectron || !window.seAssistAPI.acrPeriods) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.acrPeriods();
}

export async function acrSnapshot(payload) {
  if (!isElectron || !window.seAssistAPI.acrSnapshot) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.acrSnapshot(payload);
}

export async function acrSnapshotStatus() {
  if (!isElectron || !window.seAssistAPI.acrSnapshotStatus) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.acrSnapshotStatus();
}

export async function acrInsights(payload) {
  if (!isElectron || !window.seAssistAPI.acrInsights) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.acrInsights(payload);
}

export async function customerCapacity(payload) {
  if (!isElectron || !window.seAssistAPI.customerCapacity) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.customerCapacity(payload);
}

export async function capacityPortfolio(payload) {
  if (!isElectron || !window.seAssistAPI.capacityPortfolio) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.capacityPortfolio(payload);
}

export async function customerCapacitySubscriptions(payload) {
  if (!isElectron || !window.seAssistAPI.customerCapacitySubscriptions) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.customerCapacitySubscriptions(payload);
}

export async function foundryUsagePortfolio(payload) {
  if (!isElectron || !window.seAssistAPI.foundryUsagePortfolio) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.foundryUsagePortfolio(payload);
}

export async function foundryUsageCustomer(payload) {
  if (!isElectron || !window.seAssistAPI.foundryUsageCustomer) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.foundryUsageCustomer(payload);
}

export async function generateAcrAnalysis(payload) {
  if (!isElectron || !window.seAssistAPI.generateAcrAnalysis) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.generateAcrAnalysis(payload);
}

export async function generateSalesAdvisor(payload) {
  if (!isElectron || !window.seAssistAPI.generateSalesAdvisor) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.generateSalesAdvisor(payload);
}

export async function getCustomerResearchDossier(payload) {
  if (!isElectron || !window.seAssistAPI.getCustomerResearchDossier) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.getCustomerResearchDossier(payload);
}

export async function openCustomerResearchDossier(payload) {
  if (!isElectron || !window.seAssistAPI.openCustomerResearchDossier) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.openCustomerResearchDossier(payload);
}

export async function getCustomerInsights(payload) {
  if (!isElectron || !window.seAssistAPI.getCustomerInsights) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.getCustomerInsights(payload);
}

export async function generateCustomerAnalysis(payload) {
  if (!isElectron || !window.seAssistAPI.generateCustomerAnalysis) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.generateCustomerAnalysis(payload);
}

export async function prepareMeetingBrief(payload) {
  if (!isElectron || !window.seAssistAPI.prepareMeetingBrief) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.prepareMeetingBrief(payload);
}

export async function findMilestoneSignal(payload) {
  if (!isElectron || !window.seAssistAPI.findMilestoneSignal) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.findMilestoneSignal(payload);
}

export async function getMilestoneSignalLinks(payload) {
  if (!isElectron || !window.seAssistAPI.getMilestoneSignalLinks) return { ok: false, error: 'Not in Electron', links: [] };
  return window.seAssistAPI.getMilestoneSignalLinks(payload);
}

export async function deleteMilestoneSignalLink(payload) {
  if (!isElectron || !window.seAssistAPI.deleteMilestoneSignalLink) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.deleteMilestoneSignalLink(payload);
}

export async function getMeetingMilestoneLinks(payload) {
  if (!isElectron || !window.seAssistAPI.getMeetingMilestoneLinks) return { ok: false, error: 'Not in Electron', links: [] };
  return window.seAssistAPI.getMeetingMilestoneLinks(payload);
}

export async function linkMeetingMilestone(payload) {
  if (!isElectron || !window.seAssistAPI.linkMeetingMilestone) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.linkMeetingMilestone(payload);
}

export async function unlinkMeetingMilestone(payload) {
  if (!isElectron || !window.seAssistAPI.unlinkMeetingMilestone) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.unlinkMeetingMilestone(payload);
}

export async function getMeetingNotes(payload) {
  if (!isElectron || !window.seAssistAPI.getMeetingNotes) return { ok: false, error: 'Not in Electron', notes: null };
  return window.seAssistAPI.getMeetingNotes(payload);
}

export async function saveMeetingNotes(payload) {
  if (!isElectron || !window.seAssistAPI.saveMeetingNotes) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.saveMeetingNotes(payload);
}

export async function fetchMeetingTranscript(payload) {
  if (!isElectron || !window.seAssistAPI.fetchMeetingTranscript) return { ok: false, reason: 'not_electron', message: 'Not in Electron' };
  return window.seAssistAPI.fetchMeetingTranscript(payload);
}

export async function summarizeMeetingTranscript(payload) {
  if (!isElectron || !window.seAssistAPI.summarizeMeetingTranscript) return { ok: false, reason: 'not_electron', message: 'Not in Electron' };
  return window.seAssistAPI.summarizeMeetingTranscript(payload);
}

export async function workloadSignalList(payload) {
  if (!isElectron || !window.seAssistAPI.workloadSignalList) return { ok: false, error: 'Not in Electron', items: [] };
  return window.seAssistAPI.workloadSignalList(payload);
}

export async function workloadSignalAssign(payload) {
  if (!isElectron || !window.seAssistAPI.workloadSignalAssign) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.workloadSignalAssign(payload);
}

export async function workloadSignalUpdate(payload) {
  if (!isElectron || !window.seAssistAPI.workloadSignalUpdate) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.workloadSignalUpdate(payload);
}

export async function workloadSignalUnlink(payload) {
  if (!isElectron || !window.seAssistAPI.workloadSignalUnlink) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.workloadSignalUnlink(payload);
}

export async function listSignals(payload) {
  if (!isElectron || !window.seAssistAPI.listSignals) return { ok: false, error: 'Not in Electron', items: [] };
  return window.seAssistAPI.listSignals(payload);
}

export async function getSignalDetail(payload) {
  if (!isElectron || !window.seAssistAPI.getSignalDetail) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.getSignalDetail(payload);
}

export async function untagSignal(payload) {
  if (!isElectron || !window.seAssistAPI.untagSignal) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.untagSignal(payload);
}

export async function suggestMilestoneComment(payload) {
  if (!isElectron || !window.seAssistAPI.suggestMilestoneComment) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.suggestMilestoneComment(payload);
}

export async function suggestMilestoneHokActivity(payload) {
  if (!isElectron || !window.seAssistAPI.suggestMilestoneHokActivity) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.suggestMilestoneHokActivity(payload);
}

export async function orgGetTree(payload) {
  if (!isElectron || !window.seAssistAPI.orgGetTree) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.orgGetTree(payload);
}

export async function orgGetReports(payload) {
  if (!isElectron || !window.seAssistAPI.orgGetReports) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.orgGetReports(payload);
}

export async function orgSearchPeople(payload) {
  if (!isElectron || !window.seAssistAPI.orgSearchPeople) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.orgSearchPeople(payload);
}

export async function orgCustomerTeam(payload) {
  if (!isElectron || !window.seAssistAPI.orgCustomerTeam) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.orgCustomerTeam(payload);
}

export async function orgCustomerRelationships(payload) {
  if (!isElectron || !window.seAssistAPI.orgCustomerRelationships) {
    return { ok: false, error: 'Customer relationship data requires the desktop app.' };
  }
  return window.seAssistAPI.orgCustomerRelationships(payload);
}

// Stakeholder Influence Map. Each call fails explicitly outside the desktop app.
const INFLUENCE_DESKTOP_ONLY = 'The Stakeholder Influence Map requires the desktop app.';

function influenceCall(name, payload) {
  if (!isElectron || !window.seAssistAPI[name]) return Promise.resolve({ ok: false, error: INFLUENCE_DESKTOP_ONLY });
  return window.seAssistAPI[name](payload);
}

export const influenceMapGet = (payload) => influenceCall('influenceMapGet', payload);
export const influenceMapAnalyze = (payload) => influenceCall('influenceMapAnalyze', payload);
export const influenceOverrideSet = (payload) => influenceCall('influenceOverrideSet', payload);
export const influenceAssessmentClear = (payload) => influenceCall('influenceAssessmentClear', payload);

export async function orgProductSearch(payload) {
  if (!isElectron || !window.seAssistAPI.orgProductSearch) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.orgProductSearch(payload);
}

export async function orgPersonActivity(payload) {
  if (!isElectron || !window.seAssistAPI.orgPersonActivity) {
    return { ok: false, error: 'Customer activity requires the desktop app.' };
  }
  return window.seAssistAPI.orgPersonActivity(payload);
}

export async function orgGetSchedule(payload) {
  if (!isElectron || !window.seAssistAPI.orgGetSchedule) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.orgGetSchedule(payload);
}

export async function orgFindMeetingTimes(payload) {
  if (!isElectron || !window.seAssistAPI.orgFindMeetingTimes) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.orgFindMeetingTimes(payload);
}

export async function customerSearchDocuments(payload) {
  if (!isElectron || !window.seAssistAPI.customerSearchDocuments) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.customerSearchDocuments(payload);
}

export async function openGeneratedFile(filePath) {
  if (!isElectron || !window.seAssistAPI.openFile) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.openFile(filePath);
}

export async function assistantChat(payload) {
  if (!isElectron || !window.seAssistAPI.assistantChat) {
    return { ok: false, error: 'The AI assistant is only available in the desktop app.' };
  }
  return window.seAssistAPI.assistantChat(payload);
}

export async function secretaryScan(payload) {
  if (!isElectron || !window.seAssistAPI.secretaryScan) {
    return { ok: false, error: 'The Secretary is only available in the desktop app.' };
  }
  return window.seAssistAPI.secretaryScan(payload);
}

export async function workAgentChat(payload) {
  if (!isElectron) {
    return { ok: false, error: 'The Work Agent is only available in the desktop app.' };
  }
  if (!window.seAssistAPI.workAgentChat || !window.seAssistAPI.onWorkAgentProgress || !window.seAssistAPI.workAgentCancel) {
    return { ok: false, error: 'Restart SE Assist to load the Work Agent and its investigation tools.' };
  }
  return window.seAssistAPI.workAgentChat(payload);
}

async function invokeWorkOutput(method, payload) {
  if (!isElectron) return { ok: false, error: 'Work outputs are only available in the desktop app.' };
  if (!window.seAssistAPI[method] || !window.seAssistAPI.onWorkOutputProgress) {
    return { ok: false, error: 'Restart SE Assist to load independent work outputs and their saved research.' };
  }
  return window.seAssistAPI[method](payload);
}

export const workOutputOpen = payload => invokeWorkOutput('workOutputOpen', payload);
export const workOutputGet = payload => invokeWorkOutput('workOutputGet', payload);
export const workOutputRun = payload => invokeWorkOutput('workOutputRun', payload);
export const workOutputCancel = payload => invokeWorkOutput('workOutputCancel', payload);
export const workOutputTasks = payload => invokeWorkOutput('workOutputTasks', payload);
export const workOutputReply = payload => invokeWorkOutput('workOutputReply', payload);
export const workOutputList = payload => invokeWorkOutput('workOutputList', payload);
export const workOutputRemove = payload => invokeWorkOutput('workOutputRemove', payload);
export const workOutputGapTriage = payload => invokeWorkOutput('workOutputGapTriage', payload);
export const workOutputGapResearch = payload => invokeWorkOutput('workOutputGapResearch', payload);

async function invokeEmailSearch(method, payload) {
  if (!isElectron) return { ok: false, error: 'Email search is only available in the desktop app.' };
  if (!window.seAssistAPI[method]) return { ok: false, error: 'Restart SE Assist to load Deep Research email search.' };
  return window.seAssistAPI[method](payload);
}

export const emailSearch = payload => invokeEmailSearch('emailSearch', payload);
export const emailDetail = payload => invokeEmailSearch('emailDetail', payload);

export function onWorkOutputProgress(cb) {
  if (!isElectron || !window.seAssistAPI.onWorkOutputProgress) return () => {};
  return window.seAssistAPI.onWorkOutputProgress(cb);
}

export async function workAgentCancel(payload) {
  if (!isElectron || !window.seAssistAPI.workAgentCancel) {
    return { ok: false, error: 'Stopping the Work Agent requires the updated desktop app. Restart SE Assist.' };
  }
  return window.seAssistAPI.workAgentCancel(payload);
}

export function onWorkAgentProgress(cb) {
  if (!isElectron || !window.seAssistAPI.onWorkAgentProgress) return () => {};
  return window.seAssistAPI.onWorkAgentProgress(cb);
}

export async function workloadTodoAdd(payload) {
  if (!isElectron || !window.seAssistAPI.workloadTodoAdd) {
    return { ok: false, error: 'Adding a workload todo requires the desktop app.' };
  }
  return window.seAssistAPI.workloadTodoAdd(payload);
}

export async function secretaryReplyDraft(payload) {
  if (!isElectron || !window.seAssistAPI.secretaryReplyDraft) {
    return { ok: false, error: 'Drafting a reply requires the desktop app.' };
  }
  return window.seAssistAPI.secretaryReplyDraft(payload);
}

// ── Utilities ────────────────────────────────────────────────────────

export async function fetchExternal(url) {
  if (!isElectron) return { ok: false, error: 'Not in Electron' };
  return window.seAssistAPI.fetchExternal(url);
}

export function openExternal(url) {
  if (isElectron) return window.seAssistAPI.openExternal(url);
  window.open(url, '_blank');
}

export async function copyMilestoneTeamsMessage(payload) {
  if (!isElectron || typeof window.seAssistAPI.copyMilestoneTeamsMessage !== 'function') {
    throw new Error('Copying a formatted Teams message requires the updated desktop app. Restart SE Assist after updating.');
  }
  const result = await window.seAssistAPI.copyMilestoneTeamsMessage(payload);
  if (result?.ok !== true) {
    throw new Error(result?.error || 'Could not copy the formatted Teams message.');
  }
  return result;
}

export function inElectron() {
  return isElectron;
}
