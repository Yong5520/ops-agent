import { Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './components/AppShell.js';
import { ChatPage } from './pages/Chat/ChatPage.js';
import { SettingsPage } from './pages/Settings/SettingsPage.js';
import { AuditPage } from './pages/AuditLog/AuditPage.js';

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:sessionId" element={<ChatPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
    </AppShell>
  );
}
