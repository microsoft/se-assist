import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { FluentProvider, webLightTheme, webDarkTheme } from '@fluentui/react-components';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { TerritoryProvider } from './territoryContext';
import { getTheme, applyTheme, THEME_PREFS_EVENT } from './lib/themePrefs';
import './index.css';

// Apply the saved appearance to <html> before first paint so there is no flash of the
// wrong theme, then keep the Fluent base theme in sync when User Home changes it.
applyTheme(getTheme());

// Default landing page: open the Action Center on a fresh app start. A missing or bare hash
// ('', '#', or '#/') means no route was chosen yet — send the user to the Action Center home
// instead of the Excellence Metrics dashboard at '/'. This runs once, before React mounts, so
// the HashRouter initializes on /action-center; later real navigations (e.g. clicking
// Excellence Metrics, which routes to '#/') are unaffected, and '/' stays Excellence Metrics.
const initialHash = window.location.hash;
if (!initialHash || initialHash === '#' || initialHash === '#/') {
  window.location.hash = '#/action-center';
}

function Root() {
  const [theme, setThemeState] = useState(getTheme);

  useEffect(() => {
    const handler = () => setThemeState(getTheme());
    window.addEventListener(THEME_PREFS_EVENT, handler);
    return () => window.removeEventListener(THEME_PREFS_EVENT, handler);
  }, []);

  return (
    <FluentProvider
      theme={theme === 'dark' ? webDarkTheme : webLightTheme}
      className="app-root-provider"
    >
      <HashRouter>
        <TerritoryProvider>
          <App />
        </TerritoryProvider>
      </HashRouter>
    </FluentProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
