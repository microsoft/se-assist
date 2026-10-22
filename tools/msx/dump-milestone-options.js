// One-off generator: pulls every option set the Milestone editor needs from live
// MSX metadata and writes src/frontend/src/components/milestoneOptions.js.
// Run: node tools/msx/dump-milestone-options.js
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLI = path.join(__dirname, 'msx-cli.js');

function cliGet(p) {
  const res = spawnSync(process.execPath, [CLI, 'get', p], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (res.stdout || '') + (res.stderr || '');
  const start = out.indexOf('{');
  if (start < 0) throw new Error(`No JSON for ${p}: ${out.slice(0, 200)}`);
  // Trim trailing non-JSON (assertion noise) by finding the matching last brace.
  const end = out.lastIndexOf('}');
  return JSON.parse(out.slice(start, end + 1));
}

function picklist(attr, kind = 'PicklistAttributeMetadata') {
  const d = cliGet(
    `EntityDefinitions(LogicalName='msp_engagementmilestone')/Attributes(LogicalName='${attr}')/Microsoft.Dynamics.CRM.${kind}?$select=LogicalName&$expand=OptionSet($select=Options)`
  );
  const opts = (d.OptionSet && d.OptionSet.Options) || [];
  return opts
    .map(o => ({
      value: o.Value,
      label: o.Label && o.Label.UserLocalizedLabel ? o.Label.UserLocalizedLabel.Label : String(o.Value),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

const sets = {
  MILESTONE_CATEGORY: picklist('msp_milestonecategory'),
  CUSTOMER_COMMITMENT: picklist('msp_commitmentrecommendation'),
  DELIVERED_BY: picklist('msp_deliveryspecifiedfield'),
  MILESTONE_STATUS: picklist('msp_milestonestatus'),
  MILESTONE_STATUS_REASON: picklist('msp_milestonestatusreason'),
  HELP_NEEDED: picklist('msp_helpneeded'),
  PREFERRED_AZURE_REGION: picklist('msp_milestonepreferredazureregion'),
  NON_RECURRING: picklist('msp_nonrecurring'),
  AZURE_CAPACITY_TYPE: picklist('msp_milestoneazurecapacitytype', 'MultiSelectPicklistAttributeMetadata'),
};

const header = `// AUTO-GENERATED from live MSX metadata by tools/msx/dump-milestone-options.js
// (msp_engagementmilestone option sets). Do not hand-edit — re-run the generator to refresh.
// Each entry: { value: <optionset int>, label: <display> }. Lists are label-sorted.
`;

let body = header + '\n';
for (const [name, arr] of Object.entries(sets)) {
  body += `export const ${name} = ${JSON.stringify(arr, null, 2)};\n\n`;
}

// Convenience value→label maps for the ones the app renders as badges/labels.
body += `// value→label maps for quick display lookups.\n`;
body += `export const MILESTONE_STATUS_MAP = Object.fromEntries(MILESTONE_STATUS.map(o => [o.value, o.label]));\n`;
body += `export const CUSTOMER_COMMITMENT_MAP = Object.fromEntries(CUSTOMER_COMMITMENT.map(o => [o.value, o.label]));\n`;
body += `export const MILESTONE_CATEGORY_MAP = Object.fromEntries(MILESTONE_CATEGORY.map(o => [o.value, o.label]));\n`;

const outPath = path.join(__dirname, '..', '..', 'src', 'frontend', 'src', 'components', 'milestoneOptions.js');
fs.writeFileSync(outPath, body, 'utf8');
console.log('Wrote', outPath);
for (const [name, arr] of Object.entries(sets)) console.log(`  ${name}: ${arr.length}`);
