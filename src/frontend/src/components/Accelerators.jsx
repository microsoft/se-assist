import { useState } from 'react';
import { Button } from '@fluentui/react-components';
import { OpenRegular, BotRegular, SlideTextRegular, PlugConnectedRegular } from '@fluentui/react-icons';
import { openExternal } from '../electronBridge';

// Featured solution cards — curated assets surfaced prominently at the top of the page. A card
// either links out to an external doc (`url`) or opens an in-app setup guide (`guide` = a key into
// SOLUTION_GUIDES). We never put a fabricated URL behind an "Open" button.
const FEATURED_SOLUTIONS = [
  {
    name: 'Azure SRE Agent',
    category: 'Azure product',
    description: 'AI agent for site reliability engineering on Azure — helps triage, diagnose, and respond to production incidents across your resources.',
    icon: BotRegular,
    url: 'https://microsoft.seismic.com/apps/doccenter/3f9143fb-130e-4457-a60d-1d76227908f8/doc/%25252Fdd88ee878d-53b6-f0c8-0b4c-ed12362266a0%25252Fdd07339b2b-3446-0719-61ed-1ff63381af82%25252FdfYTZjNDRiZDMtMzEwZS1kNWZkLTNjOGEtNjliYWJjMjhmMmUw%25252CPT0%25253D%25252CUHJvZHVjdCBQYWdl%25252Flfcf82d7ea-9bc4-45bf-a489-9e0715f6b87b//?mode=view&searchId=6c1c8778-2a46-410f-830e-a4be467e9705&anchorId=c9d18a32-ab2e-44d0-a16c-552259d820ed',
  },
  {
    name: 'Project Perception Discussion Deck',
    category: 'Discussion deck · L200',
    description: 'Level 200 customer discussion deck for Project Perception.',
    icon: SlideTextRegular,
    url: 'https://microsoft.seismic.com/apps/doccenter/3f9143fb-130e-4457-a60d-1d76227908f8/doc/%25252Fdd88ee878d-53b6-f0c8-0b4c-ed12362266a0%25252Fdd07339b2b-3446-0719-61ed-1ff63381af82%25252FdfYTZjNDRiZDMtMzEwZS1kNWZkLTNjOGEtNjliYWJjMjhmMmUw%25252CPT0%25253D%25252CR2VuZXJhbCBBdmFpbGFiaWxpdHkgQ29tbXVuaWNhdGlvbg%25253D%25253D%25252Flf9b18c408-65a8-4ee0-bb39-56a3419a1e75//?mode=view&searchId=4692d2da-e2db-48d8-b610-b33da777df0b',
  },
  {
    name: 'Claude Code + Foundry Models',
    category: 'Setup guide · Dev tooling',
    description: 'Use Claude Code as your terminal front end with Microsoft Foundry models as the LLM brain.',
    icon: PlugConnectedRegular,
    guide: 'claude-foundry',
  },
];

const OTHER_ACCELERATORS = [
  { label: 'Internal Link', name: 'MCAPS Accelerators', url: 'https://mcaps.accelerators.ms/' },
  { label: 'Solution Accelerators', name: 'accelerators.ms', url: 'https://accelerators.ms/' },
  { label: 'Microsoft Foundry Templates', name: 'Solution Templates', url: 'https://ai.azure.com/nextgen/r/imc6-9hYSpekkCYlOW0UhA,rg-semantic-workbench,,partner-community-models,Amplifier-Innovators/Discover/solutiontemplates' },
  { label: 'Marketplace', name: 'Marketplace Development Templates', url: 'https://marketing.partner.microsoft.com/marketplace-rewards/quick-start-development-toolkit' },
  { label: 'Azure Verified Module', name: 'aka.ms/avm', url: 'https://aka.ms/avm' },
  { label: 'Azure AI Landing Zone', name: 'aka.ms/ai-lz', url: 'https://aka.ms/ai-lz' },
];

// In-app setup guide for wiring Claude Code (terminal front end) to Microsoft Foundry models
// (the LLM backend). Rendered inside a popup. General guidance — exact endpoint/model formats
// evolve, so it also points to the authoritative docs to confirm current details.
function ClaudeFoundryGuide() {
  return (
    <div className="sol-guide">
      <p className="sol-guide-lead">
        <strong>Claude Code</strong> is the front end — the terminal coding agent you drive.
        <strong> Microsoft Foundry</strong> supplies the model — the “brain.” Claude Code speaks the
        Anthropic Messages API and lets you retarget it at any compatible endpoint with a few
        environment variables, so you can point it at a Foundry-served model.
      </p>

      <h4>How the pieces fit</h4>
      <ul className="sol-guide-list">
        <li><strong>Front end:</strong> Claude Code in your terminal / editor.</li>
        <li><strong>Brain:</strong> a model deployed from the Azure AI Foundry catalog.</li>
        <li><strong>Bridge:</strong> Claude Code’s <code>ANTHROPIC_BASE_URL</code> / <code>ANTHROPIC_AUTH_TOKEN</code> / <code>ANTHROPIC_MODEL</code> overrides point it at Foundry (directly for Foundry-hosted Claude models, or via a small gateway for other model families).</li>
      </ul>

      <h4>Option A — Foundry-hosted Claude model (direct)</h4>
      <p className="sol-guide-note">
        If you deploy an Anthropic Claude model from the Foundry catalog, Claude Code can talk to it
        directly — same API shape, just a different endpoint and key.
      </p>
      <pre className="sol-guide-code">{`export ANTHROPIC_BASE_URL="https://<your-foundry-endpoint>"
export ANTHROPIC_AUTH_TOKEN="<foundry-key-or-entra-token>"
export ANTHROPIC_MODEL="<your-foundry-deployment-name>"
claude`}</pre>

      <h4>Option B — Any Foundry model via a gateway</h4>
      <p className="sol-guide-note">
        Non-Anthropic Foundry models (e.g. GPT-4o) speak the OpenAI-compatible API, so run a small
        LLM gateway (such as LiteLLM) that exposes an Anthropic-compatible <code>/v1/messages</code>
        endpoint and forwards to your Foundry deployment. Then point Claude Code at the gateway:
      </p>
      <pre className="sol-guide-code">{`# 1) Gateway config points at your Foundry endpoint + key + deployment
# 2) Run the gateway, then:
export ANTHROPIC_BASE_URL="http://localhost:4000"
export ANTHROPIC_AUTH_TOKEN="<gateway-key>"
export ANTHROPIC_MODEL="<model-alias>"
claude`}</pre>

      <h4>Good practice</h4>
      <ul className="sol-guide-list">
        <li>Keep keys in your shell profile or a secrets manager — never in code.</li>
        <li>Prefer Microsoft Entra ID auth to Foundry where supported.</li>
        <li>This mirrors how SE Assist itself runs behind one provider interface (GitHub Copilot / Azure AI Foundry).</li>
      </ul>

      <p className="sol-guide-disclaimer">
        General setup guidance — confirm the current endpoint format, model names, and supported
        auth against the official Claude Code and Azure AI Foundry documentation, which evolve.
      </p>
      <div className="sol-guide-links">
        <Button size="small" appearance="subtle" icon={<OpenRegular />} onClick={() => openExternal('https://docs.anthropic.com/en/docs/claude-code')}>
          Claude Code docs
        </Button>
        <Button size="small" appearance="subtle" icon={<OpenRegular />} onClick={() => openExternal('https://ai.azure.com/')}>
          Azure AI Foundry
        </Button>
      </div>
    </div>
  );
}

const SOLUTION_GUIDES = {
  'claude-foundry': { title: 'Claude Code + Foundry Models', body: <ClaudeFoundryGuide /> },
};

function SolutionGuideModal({ guide, onClose }) {
  return (
    <div className="eng-detail-backdrop" onMouseDown={onClose}>
      <div className="eng-detail-card eng-detail-card-wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="eng-detail-head">
          <span className="eng-detail-kind">Setup guide</span>
          <div className="eng-detail-head-actions">
            <button className="eng-detail-close" title="Close" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="eng-detail-title"><span>{guide.title}</span></div>
        {guide.body}
      </div>
    </div>
  );
}

export default function Accelerators() {
  const [openGuide, setOpenGuide] = useState(null); // guide key | null

  return (
    <div>
      <div className="page-header">
        <h2>Solutions</h2>
        <Button
          size="small"
          appearance="subtle"
          icon={<OpenRegular />}
          onClick={() => openExternal('https://accelerators.ms/')}
        >
          accelerators.ms
        </Button>
      </div>

      <div className="sol-featured-grid">
        {FEATURED_SOLUTIONS.map((sol) => {
          const Icon = sol.icon;
          return (
            <article key={sol.name} className="sol-card">
              <div className="sol-card-head">
                <span className="sol-card-icon"><Icon /></span>
                <div className="sol-card-heading">
                  <span className="sol-card-name">{sol.name}</span>
                  <span className="sol-card-category">{sol.category}</span>
                </div>
              </div>
              <p className="sol-card-desc">{sol.description}</p>
              <div className="sol-card-actions">
                {sol.url ? (
                  <Button
                    size="small"
                    appearance="primary"
                    icon={<OpenRegular />}
                    onClick={() => openExternal(sol.url)}
                  >
                    Open in Seismic
                  </Button>
                ) : (
                  <Button
                    size="small"
                    appearance="primary"
                    icon={<PlugConnectedRegular />}
                    onClick={() => setOpenGuide(sol.guide)}
                  >
                    View setup guide
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-body-custom" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {OTHER_ACCELERATORS.map((link) => (
              <div key={link.url} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ minWidth: 200, fontSize: 13, color: 'var(--text-muted)', fontWeight: 600 }}>{link.label}:</span>
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<OpenRegular />}
                  onClick={() => openExternal(link.url)}
                  style={{ color: 'var(--accent)' }}
                >
                  {link.name}
                </Button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {openGuide && SOLUTION_GUIDES[openGuide] ? (
        <SolutionGuideModal guide={SOLUTION_GUIDES[openGuide]} onClose={() => setOpenGuide(null)} />
      ) : null}
    </div>
  );
}
