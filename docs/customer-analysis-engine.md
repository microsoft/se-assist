# Customer analysis engine

SE Assist customer analysis has two layers:

1. a deterministic engine that computes traceable facts from local data
2. a dedicated AI agent that turns those facts into a concise account narrative

The deterministic layer is the factual contract. The model does not replace account resolution, CRM joins, consumption math, source status, or coverage reporting.

## Entry points

| Capability | IPC | Agent |
|---|---|---|
| Comprehensive relationship summary | `se-workspace-generate-summary` | `comprehensive-summary` |
| Technology stack | `se-workspace-generate-tech-stack` | `tech-stack` |
| Customer analysis | `se-customer-analysis` | `customer-analysis` |
| Sales play advisor | `se-sales-advisor` | `sales-advisor` |
| Meeting prep | `se-meeting-prep` / workspace meeting preparation | `meeting-prep` |
| Azure consumption analysis | `se-acr-analysis` | `acr-analysis` |

The catalog in `desktop/services/agents/catalog.js` is authoritative for agent names, grounding tools, memory, model role, and budgets. `desktop/app-ipc.js` supplies the concrete grounding and persistence behavior.

## Deterministic customer insights

`desktop/services/customer-insights.js` exports `computeCustomerInsights()`. It is a pure, unit-tested function that accepts optional signals:

- customer identity
- parsed research-dossier topics
- MSX opportunities
- MSX milestones
- per-account Azure consumption
- consumption source metadata
- open questions and action items from recent communication profiles

It returns:

- `priorities`
- `opportunityAreas`
- prioritized `suggestions`
- normalized `signals`
- `dataCoverage`
- overall `confidence`
- explicit `notes` for missing or cached inputs

### Consumption analysis

Per-account consumption uses the same momentum math as the portfolio ACR engine:

- latest and previous month
- month-over-month dollar and percentage movement
- largest services
- rising and eroding services
- newly active workloads
- Azure AI consumption presence

When account consumption is served from a local cache, `acrMeta.source` is `local-cache`, the cache timestamp is carried into `dataCoverage`, and the output notes that the figures are not live.

### Research dossier topics

The engine recognizes selected dossier sections as structured signals:

- account snapshot
- financial and strategic priorities
- AI and data initiatives
- regulatory posture
- current triggers
- Microsoft pitch mapping

Missing dossier content lowers coverage and creates an explicit suggestion to generate or add research. It is not replaced with an invented external profile.

### CRM facts

Opportunities are normalized to name, sales play, close date, owner, and open state. `state_code = 0` is active; a missing state is treated as active because older cached rows may not carry it.

Milestones are normalized to name, workload, status, and monthly use.

The engine can identify:

- active pursuits by sales play
- in-flight delivery focus
- open opportunities within 90 days of close or overdue
- the highest-value milestone by monthly use

### Cross-signal recommendations

Recommendations are created from explicit joins, for example:

- research trigger plus open opportunity
- rising service plus expansion motion
- eroding service plus health review
- AI initiative plus no recorded Azure AI consumption
- near-close opportunity plus prioritization
- open communication thread plus follow-up

The engine sorts these by priority and includes a rationale naming the intersecting facts.

### Confidence

Confidence depends on source coverage:

- **high**: dossier, ACR, and CRM delivery/pipeline signal
- **medium**: at least two primary source classes
- **low**: fewer than two

Low confidence is not upgraded by model phrasing.

## Grounding assembly

The main process resolves the profile/customer before running an agent. Depending on the feature, grounding may include:

- cached customer workspace
- account and opportunity contacts
- account team
- opportunities and milestones
- WorkIQ-derived email, meeting, and Teams profiles
- recent communication excerpts
- ACR and AI-capacity data
- research dossier topics
- deterministic customer-insight output

Every source is optional only when the feature can still produce an honestly qualified result. A broken required query fails; it must not be converted into an empty source.

## Model execution

The runtime resolves the selected provider for each request:

- connected GitHub Copilot is primary
- connected-but-failing Copilot returns an error
- Foundry is used only when Copilot is not connected and Foundry is fully configured
- neither provider produces the standard “No AI model provider is configured” error

The default reasoning effort is `high`. Customer-analysis agents use the primary model role.

The shared model-request scheduler supplies pacing, priority, cancellation, safe in-flight coalescing, cooldown handling, and activity reporting.

## Output and persistence

Agents return text or structured content. HTML report presentation is rendered locally through `desktop/services/html-render.js`:

1. escape model content
2. convert the supported markdown subset to HTML
3. add deterministic report styling and source/model metadata
4. write the artifact under the Electron user-data `generated` directory
5. store the artifact path in the related timeline metadata

There is no second formatting-only model call and no model-generated HTML requirement.

`writeHtmlArtifact()` treats the browser artifact as a convenience; persistence of the underlying analysis is the important operation. A missing artifact path must not be reported as a successful open action.

## Failure behavior

- Missing provider: explicit configuration error.
- Copilot connected but unavailable: explicit Copilot error, no Foundry substitution.
- Authentication or remote query failure: preserve the source-specific error.
- Missing optional source: record coverage and notes.
- ACR cache used: label source and timestamp.
- Invalid model output: fail parsing or validation; do not create a success-shaped report.
- Empty required database query caused by schema failure: throw; do not say the customer has no data.

## Verification

Relevant tests include:

```powershell
cd desktop
node --test services\__tests__\customer-insights.test.js services\__tests__\html-render.test.js services\__tests__\prompts.test.js services\__tests__\agents.test.js
```
