import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { TerminalWindowPage } from './pages/Terminal/TerminalWindowPage.js';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found');
}

// Standalone terminal window (Feature 2): when loaded with a
// `#/terminal-window/:hostId` hash, render a single focused terminal directly,
// bypassing AppShell/HashRouter. The hash is set by createTerminalWindow in the
// main process; the hostId is URL-encoded there and decoded here.
const standaloneMatch = window.location.hash.match(/^#\/terminal-window\/(.+)$/);
const standaloneHostId = standaloneMatch ? decodeURIComponent(standaloneMatch[1]) : null;

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      {standaloneHostId ? (
        <TerminalWindowPage hostId={standaloneHostId} />
      ) : (
        <HashRouter>
          <App />
        </HashRouter>
      )}
    </ErrorBoundary>
  </StrictMode>,
);
