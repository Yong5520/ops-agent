import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { TerminalWindowPage } from './pages/Terminal/TerminalWindowPage.js';
import { ActivityMirrorWindowPage } from './pages/Terminal/ActivityMirrorWindowPage.js';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found');
}

// Standalone terminal window (Feature 2): when loaded with a
// `#/terminal-window/:hostId` hash, render a single focused terminal directly,
// bypassing AppShell/HashRouter. The hash is set by createTerminalWindow in the
// main process; the hostId is URL-encoded there and decoded here.
const terminalWindowMatch = window.location.hash.match(/^#\/terminal-window\/(.+)$/);
const terminalWindowHostId = terminalWindowMatch
  ? decodeURIComponent(terminalWindowMatch[1])
  : null;

// v24 activity-mirror window: `#/activity-window` (optionally `?session=<id>`).
// The main process creates this window via createActivityMirrorWindow; the
// optional session id scopes the mirror to one agent session.
const activityWindowMatch = window.location.hash.match(/^#\/activity-window(?:\?session=(.+))?$/);
const activitySessionId = activityWindowMatch
  ? activityWindowMatch[1]
    ? decodeURIComponent(activityWindowMatch[1])
    : ''
  : null;

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      {terminalWindowHostId ? (
        <TerminalWindowPage hostId={terminalWindowHostId} />
      ) : activitySessionId !== null ? (
        <ActivityMirrorWindowPage sessionId={activitySessionId} />
      ) : (
        <HashRouter>
          <App />
        </HashRouter>
      )}
    </ErrorBoundary>
  </StrictMode>,
);
