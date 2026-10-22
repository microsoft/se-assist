// The default account roster is intentionally EMPTY. Each user maintains their own
// roster in the app (Settings → Default Accounts), persisted locally in the tpid_config
// table of their own SQLite DB. Shipping a personal account list here would push one
// user's accounts onto everyone else, so there are no built-in defaults.
const CUSTOMER_PROFILE_TPIDS = Object.freeze([]);

const EMAIL_SNIPPET_MAX_LENGTH = 512;

const SYNC_ENTITY_TYPES = Object.freeze([
  'customer_profiles',
  'customer_timeline_events',
  'customer_assets',
  'customer_todos',
  'ai_extractions',
]);

const DATA_SOURCE_STATUS = Object.freeze({
  notConfigured: 'not_configured',
  ready: 'ready',
  degraded: 'degraded',
  disabled: 'disabled',
});

module.exports = {
  CUSTOMER_PROFILE_TPIDS,
  DATA_SOURCE_STATUS,
  EMAIL_SNIPPET_MAX_LENGTH,
  SYNC_ENTITY_TYPES,
};
