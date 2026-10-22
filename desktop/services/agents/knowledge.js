// Shared knowledge blocks for SE Assist AI agents.
//
// A "knowledge" block is a named, reusable piece of domain instruction that one or
// more agents ground themselves in. Centralizing them here means the persona, the
// no-fabrication contract, and the HTML presentation rules are defined once and
// referenced by every agent that needs them — instead of being copy-pasted across
// a dozen prompt builders. Each agent declares the block ids it uses (see catalog.js)
// so the agent registry is self-describing.
//
// The exact text is intentionally byte-identical to the strings that previously lived
// inline in the prompt builders, so composing an agent's system prompt from these
// blocks reproduces the historical model behavior exactly.

'use strict';

const KNOWLEDGE = {
  // The core identity shared by the customer-facing analysis agents.
  'se-assist-persona': {
    id: 'se-assist-persona',
    title: 'SE Assist persona',
    text: 'You are SE Assist, an internal Microsoft assistant for a financial-services solution engineer.',
  },

  // The honesty contract every grounded agent must honor.
  'grounding-contract': {
    id: 'grounding-contract',
    title: 'Grounding / no-fabrication contract',
    text: 'Ground every claim in the supplied context — never invent customers, people, products, consumption numbers, opportunities, or figures. Reason only from what is provided; when the data is thin, say so plainly and give the safest high-value guidance rather than generic filler.',
  },

  // The Microsoft solution families an FSI SE should map recommendations to.
  'microsoft-solution-families': {
    id: 'microsoft-solution-families',
    title: 'Microsoft solution families',
    text: 'Prefer Microsoft solutions (Azure, Microsoft 365, Security, Data & AI, Fabric, GitHub, Power Platform) and tie each recommendation to a concrete signal — a workload, a growing or declining service, a whitespace in their stack, an open opportunity, or an FSI driver such as risk, compliance, or modernization.',
  },

  // Legacy rules retained for the exported presentation prompt helpers. The runtime
  // no longer invokes those formatting-only prompts; completed markdown is rendered
  // locally so report formatting does not consume another model request.
  'presentation-html-rules': {
    id: 'presentation-html-rules',
    title: 'Self-contained HTML presentation rules',
    text: [
      '- Output ONLY the HTML document. Start with <!doctype html>. No markdown, no code fences, no commentary.',
      '- Fully self-contained: ALL CSS inline in one <style> tag. No external stylesheets, fonts, scripts, images, or CDNs.',
      '  Use only system fonts and inline Unicode/emoji icons (no <img>, no <link>, no <script src>). Avoid JavaScript.',
      '- Light theme that matches the app: background #ffffff, text #1f2333, accent blue #4c63d2, purple #8b5cf0,',
      '  yellow #a97b09, green #2f8f52, red/pink #d6336c, card surface #f2f4f8, borders #dbe0e8. Add a clean @media print rule.',
    ].join(' '),
  },
};

// Compose the text of the given knowledge block ids in order, joined by `sep`.
// Unknown ids throw so a mis-typed agent definition fails loudly at registration
// time rather than silently dropping instruction.
function composeKnowledge(ids = [], sep = ' ') {
  return ids
    .map((id) => {
      const block = KNOWLEDGE[id];
      if (!block) throw new Error(`Unknown knowledge block: ${id}`);
      return block.text;
    })
    .join(sep);
}

// Return the title of a knowledge block (used by describeAgents / the runtime).
function knowledgeTitle(id) {
  return KNOWLEDGE[id]?.title || id;
}

module.exports = { KNOWLEDGE, composeKnowledge, knowledgeTitle };
