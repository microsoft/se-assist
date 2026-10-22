import React from 'react';
import { createRoot } from 'react-dom/client';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { HashRouter } from 'react-router-dom';
import { CustomerGlanceModal } from '../src/components/CustomerActivity';
import { DetailCard } from '../src/components/Milestones';
import { openExternal } from '../src/electronBridge';
import '../src/index.css';

function Harness({ kind, name, ownerName, recordId, crmBaseUrl }) {
  if (kind === 'account') {
    return <CustomerGlanceModal
      selected={{ tpid: '1001', name }}
      sinceIso="2026-01-01T00:00:00Z"
      nowIso="2026-12-31T00:00:00Z"
      lookbackDays={30}
      navigate={() => {}}
      onClose={() => {}}
    />;
  }
  return <DetailCard
    detail={{
      type: kind === 'opportunity' ? 'opp' : 'ms',
      data: {
        name, owner: ownerName, owner_name: ownerName,
        crmId: recordId, milestone_id: recordId,
        opportunity_id: '99999999-8888-7777-6666-555555555555', opp_name: 'Linked opportunity',
        milestones: [], comments_json: '[]', deal_team_json: '[]',
        accountName: 'Contoso', customer_name: 'Contoso',
      },
    }}
    crmBaseUrl={crmBaseUrl}
    onOpenExternal={openExternal}
    onClose={() => {}}
    onSelect={() => {}}
  />;
}

const root = createRoot(document.getElementById('root'));
window.renderTeamsChatTest = props => root.render(
  <React.StrictMode><HashRouter><FluentProvider theme={webLightTheme}>
    <div data-test-case={props.caseId}>
      <Harness key={`${props.kind}:${props.mountKey || ''}`} {...props} />
    </div>
  </FluentProvider></HashRouter></React.StrictMode>,
);
