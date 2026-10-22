import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { HashRouter } from 'react-router-dom';
import WorkOutputsPanel from '../src/components/WorkOutputsPanel';
import SecretarySection from '../src/components/SecretarySection';
import '../src/index.css';

function Harness({ sourceId }) {
  const [visible, setVisible] = useState(true);
  const task = React.useMemo(() => ({
    title: `Output test ${sourceId}`, sourceMessageId: sourceId, subject: 'Synthetic alignment plan',
    account: 'Contoso', from: 'Test sender', webLink: 'https://outlook.office.com/mail/read/test',
    date: '2026-09-23T10:00:00Z',
  }), [sourceId]);
  return <FluentProvider theme={webLightTheme}>
    {sourceId === 'secretary-scan' ? <SecretarySection userName="Test user" /> : visible ? <WorkOutputsPanel task={task} userName="Test user" onBusyChange={() => {}} onClose={() => setVisible(false)} />
      : <button type="button" onClick={() => setVisible(true)}>Reopen saved outputs</button>}
  </FluentProvider>;
}

const root = createRoot(document.getElementById('root'));
window.selectOutputTestTask = sourceId => root.render(<React.StrictMode><HashRouter><Harness key={sourceId} sourceId={sourceId} /></HashRouter></React.StrictMode>);
window.selectOutputTestTask('source-main');
