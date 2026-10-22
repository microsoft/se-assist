import React from 'react';
import { createRoot } from 'react-dom/client';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { HashRouter, Routes, Route } from 'react-router-dom';
import Consumption from '../src/components/Consumption';
import ConsumptionAccount from '../src/components/ConsumptionAccount';
import '../src/index.css';

localStorage.setItem('acr.fiscalYears', JSON.stringify(['FY27']));
localStorage.setItem('acr.serviceLevel', '2');
if (!location.hash) location.hash = '#/consumption/1';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <FluentProvider theme={webLightTheme}>
      <HashRouter><Routes>
        <Route path="/consumption/:tpid" element={<ConsumptionAccount />} />
        <Route path="/consumption" element={<Consumption />} />
      </Routes></HashRouter>
    </FluentProvider>
  </React.StrictMode>,
);
