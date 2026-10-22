# Standalone MSX / Dynamics developer CLI

`tools\msx\msx-cli.js` is a maintenance and diagnostics utility for direct Dataverse Web API access.

It is **not required for normal SE Assist use**. The desktop application has its own Microsoft sign-in, token cache, CRM requests, roster detection, and sync UI. Use **User Home → Microsoft 365 sign-in** and **MSX Dynamics Sync** for the product workflow.

## When to use this tool

- verify that a developer account can reach MSX
- inspect raw Dataverse responses while diagnosing schema or permission issues
- test an OData path
- inspect the createable engagement-milestone fields

Do not use it as a second application sync path or as a replacement for the in-app account and error handling.

## Requirements

Install desktop dependencies first. The CLI resolves `@azure/msal-node` from `desktop\node_modules`.

```powershell
cd desktop
npm install
cd ..
```

## Commands

Run from the repository root:

```powershell
node tools\msx\msx-cli.js login
node tools\msx\msx-cli.js status
node tools\msx\msx-cli.js whoami
node tools\msx\msx-cli.js get "msp_engagementmilestones?$top=1"
node tools\msx\msx-cli.js create-fields
node tools\msx\msx-cli.js logout
```

`login` uses an interactive system-browser flow by default so managed Windows device state can satisfy Conditional Access. `login --device-code` is available for diagnostics but may be rejected by a compliant-device policy.

`token` prints a raw access token and should be used only in a controlled local terminal. Do not paste it into issues, logs, chat, or committed files.

## Authentication files

The CLI keeps its own files under `tools\msx\`:

- `.msx-token-cache.json`
- `.msx-account.json`

They are separate from the desktop application's encrypted Electron `safeStorage` cache. The CLI cache contains refresh-token material, is gitignored, and must never be committed. `logout` deletes both files.

Because this is a developer utility, its file cache does not have the desktop application's operating-system encryption guarantee.

## Configuration

Optional environment overrides:

| Variable | Purpose |
|---|---|
| `SEASSIST_CRM_URL` | Dynamics/Dataverse base URL |
| `SEASSIST_TENANT_ID` | Entra tenant |
| `SEASSIST_ENTRA_CLIENT_ID` | Public-client application ID |

Defaults mirror the desktop application's standard MSX connection.

## Output artifacts

`create-fields` writes `tools\msx\milestone-create-fields.json`. `dump-milestone-options.js` and that JSON file are schema-investigation aids, not runtime inputs to the desktop product.
