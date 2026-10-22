# Teams ingestion tools

The `tools.teams` Python package normalizes Teams chat inventory and messages into the local SE Assist SQLite database, links chats to customer TPIDs, maintains sync watermarks, and builds per-account Teams profiles.

## Normal product path

Users do not run this CLI manually.

In the application, **User Home → Microsoft 365 Copilot sign-in** connects WorkIQ and **WorkIQ Outlook and Teams Sync** starts ingestion. `desktop/services/m365-ingest.js`:

1. reads the Teams inventory and messages through WorkIQ
2. stages bounded JSON files
3. invokes this package
4. writes normalized rows and customer links to `seassist.db`
5. rebuilds account profiles
6. purges plaintext Teams staging copies

Packaged SE Assist includes this package and an embeddable Python runtime. Development runs use Python from `PATH`.

This CLI is a developer and maintenance surface for inspecting or repairing the local pipeline. It is not an alternate user authentication or export workflow.

## Stored data

The package works with:

- `teams_chats`
- `teams_chat_messages`
- `teams_chat_members`
- `teams_chat_customer_links`
- `teams_chat_sync`
- `teams_customer_profile`
- shared customer aliases, contacts, and link-review state

The default database is `%APPDATA%\se-assist\seassist.db`. Use `--db` only when intentionally operating on another database.

Customer links use exact/alias evidence, known contact/identity evidence, and optional AI review of uncertain candidates. Rejected AI candidates remain marked so they are not treated as customer evidence.

The public source includes no customer alias seeds or account roster. Aliases are derived from your saved active accounts and locally synced customer names; manual and curated aliases already stored in your database are preserved.

## CLI

Run from the repository root:

```powershell
python -m tools.teams.cli --help
```

Useful read-only commands:

```powershell
python -m tools.teams.cli report
python -m tools.teams.cli customer <tpid>
python -m tools.teams.cli unlinked
python -m tools.teams.cli diff
python -m tools.teams.cli fetch-manifest --limit 50
python -m tools.teams.cli show-profile <tpid>
```

Mutation commands:

```powershell
python -m tools.teams.cli aliases
python -m tools.teams.cli gen-aliases
python -m tools.teams.cli sync
python -m tools.teams.cli ingest-messages
python -m tools.teams.cli build-profile --all
python -m tools.teams.cli mark-pulled <chat-id>
```

`sync` is the one-shot chat-inventory path: build aliases, ingest staged chats, link by alias and identity, assign evidence tiers, and run optional AI verification.

`stage-raw` and the files under `exports\` are internal pipeline inputs. The desktop orchestrator creates and removes them. Do not retain or commit raw message exports.

## AI enrichment

Alias generation and weak-link verification can use the model environment injected by the desktop orchestrator:

- `SEASSIST_COPILOT_TOKEN`
- `SEASSIST_COPILOT_API`
- `SEASSIST_FAST_MODEL`

The application schedules the whole Python enrichment subprocess as background model work. If Copilot is unavailable, the deterministic exact-name baseline still runs and the application reports a degraded import. The tool does not silently switch to another provider.

Running the CLI directly without those variables skips unavailable AI enrichment.

## Tests

Shared model-adapter and resilience tests live under `tools\tests`:

```powershell
python -m pytest tools\tests
```
