# Repository guide for coding agents

SE Assist is a local-first Windows Electron application for Solution Engineers. Read `README.md` first, then `docs/customer-workspace.md` for process boundaries and data flows.

## Current architecture

- `desktop/`: Electron main process, privileged IPC, SQLite, authentication, integrations, agents, and services
- `src/frontend/`: React/Vite/Fluent UI renderer
- `desktop/se-assist-preload.js`: context-isolated bridge
- `desktop/migrations/`: authoritative SQLite schema history; current version 36
- `tools/`: Python ingestion and developer utilities
- `vault/`: research-dossier and Obsidian knowledge content

There is no active application cloud backend. `infra/` is a historical backend experiment and is not part of the current runtime.

## Required product contracts

- Fail loudly. Do not turn auth, provider, query, schema, permission, or missing-capability failures into empty or successful results.
- Never silently switch provider, identity, data source, target, or action.
- Connected GitHub Copilot is an explicit AI provider choice. If it fails, do not fall back to Foundry. Foundry is eligible only when Copilot is not connected and Foundry is fully configured.
- Keep privileged access in the Electron main process and expose it through narrow preload/renderer wrappers.
- Preserve local-first data ownership. Workloads, Tasks, notes, transcripts, manual links, dismissals, and Work Outputs are durable local state.
- Treat the saved User Home TPIDs as the only active roster. Off-roster accounts are archived in place, never deleted or silently reactivated by discovery, sync, ingestion, or cached-account unions. Read through `active_*` views; validate account-bound writes and work with `desktop/account-roster.js`.
- Use deterministic code for persistence, account resolution, joins, dates, calculations, validation, and rendering. Use AI only where interpretation or synthesis adds value.
- Label cached or degraded data honestly, including source and freshness.
- Use the shared model-request scheduler for every model call, including desktop-launched external AI work.
- Preserve opportunity-to-milestone gating: a milestone can be selected only after its parent opportunity.

## Canonical files

- routes and surfaces: `src/frontend/src/App.jsx`
- sidebar: `src/frontend/src/lib/navConfig.js`
- renderer bridge: `src/frontend/src/electronBridge.js`
- preload API: `desktop/se-assist-preload.js`
- application orchestration: `desktop/app-ipc.js`
- database lifecycle and workload IPC: `desktop/sqlite-ipc.js`
- AI catalog: `desktop/services/agents/catalog.js`
- AI scheduling: `desktop/services/model-request-scheduler.js`
- Copilot provider: `desktop/services/copilot-provider.js`
- WorkIQ ingestion: `desktop/services/m365-ingest.js`
- backups: `desktop/services/db-backup.js`
- workload UI: `src/frontend/src/components/WorkloadManagement.jsx`
- user setup: `src/frontend/src/components/Settings.jsx`
- in-app guide: `src/frontend/src/components/Documentation.jsx`

## Validation

Use the narrowest relevant command, then escalate if needed:

```powershell
cd desktop
npm test

cd src\frontend
npm run build

python -m pytest tools\tests
```

Keep README, focused docs, and in-app documentation consistent when changing user-visible behavior, provider rules, data ownership, setup, or recovery.
