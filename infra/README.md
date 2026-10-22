# Historical Azure backend experiment

The files in this directory are **not part of the current SE Assist runtime or deployment path**.

They describe an earlier experiment using Azure Container Apps, PostgreSQL, Azure Container Registry, Foundry, Key Vault, Storage, and Application Insights. The corresponding `backend/` implementation is not present, and the Electron application does not call or synchronize with this infrastructure.

Current SE Assist is a local-first Electron application:

- local SQLite at `%APPDATA%\se-assist\seassist.db`
- in-app Microsoft, WorkIQ, GitHub Copilot, Power BI, and Seismic connections
- no hosted application API
- no PostgreSQL application database
- no cloud outbox or profile synchronization

Do not deploy `main.bicep` or `deploy-dev.ps1` as the SE Assist application. They are retained only as historical infrastructure code.

See `README.md` and `docs/customer-workspace.md` for the current architecture.
