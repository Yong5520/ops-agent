import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AppShell } from './components/AppShell.js';
import { DashboardPage } from './pages/Dashboard/DashboardPage.js';
import { ChatPage } from './pages/Chat/ChatPage.js';
import { SettingsPage } from './pages/Settings/SettingsPage.js';
import { AuditPage } from './pages/AuditLog/AuditPage.js';
import { TerminalPage } from './pages/Terminal/TerminalPage.js';

// TerminalPage is kept always mounted to preserve xterm.js instances and
// SSH shell sessions when the user navigates to other pages.
// If we let React Router unmount it, term.dispose() fires and all scroll
// history is lost.  Instead we render it outside <Routes> and toggle
// visibility via CSS based on the current route.
export function App() {
  const location = useLocation();
  const isTerminal = location.pathname.startsWith('/terminal');

  return (
    <AppShell>
      {/* Terminal page stays mounted at all times; hidden when not active */}
      <div className={isTerminal ? 'flex flex-1 min-h-0' : 'hidden'}>
        <TerminalPage />
      </div>

      {/* Other pages are routed normally (unmount on navigation) */}
      {!isTerminal && (
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:sessionId" element={<ChatPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      )}
    </AppShell>
  );
}
