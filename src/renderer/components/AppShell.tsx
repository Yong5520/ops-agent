import { NavLink, useLocation } from 'react-router-dom';
import { useEffect, useRef, type ReactNode } from 'react';
import { ConfirmDialog } from './ConfirmDialog.js';
import { AskUserDialog } from './AskUserDialog.js';
import { useUiStore } from '../store/uiStore.js';

interface AppShellProps {
  children: ReactNode;
}

const NAV_ITEMS = [
  { to: '/dashboard', label: '仪表盘', icon: 'dashboard' },
  { to: '/chat', label: '对话', icon: 'chat' },
  { to: '/terminal', label: '终端', icon: 'terminal' },
  { to: '/settings', label: '设置', icon: 'settings' },
  { to: '/audit', label: '审计', icon: 'audit' },
];

function NavIcon({ name }: { name: string }) {
  const common = 'h-4 w-4';
  switch (name) {
    case 'dashboard':
      return (
        <svg
          className={common}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      );
    case 'chat':
      return (
        <svg
          className={common}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case 'settings':
      return (
        <svg
          className={common}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case 'audit':
      return (
        <svg
          className={common}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="16" y2="17" />
        </svg>
      );
    case 'terminal':
      return (
        <svg
          className={common}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      );
    default:
      return null;
  }
}

export function AppShell({ children }: AppShellProps) {
  const location = useLocation();
  const { askUser } = useUiStore();
  const askUserRef = useRef(askUser);
  askUserRef.current = askUser;

  // Subscribe to ask-user requests from the agent (P1-4)
  useEffect(() => {
    const unsubscribe = window.opsAgent.agent.onAskUserRequest(async (event) => {
      const answers = await askUserRef.current(event.sessionId, event.questions);
      window.opsAgent.agent.respondAskUser({
        sessionId: event.sessionId,
        answers,
        dismissed: answers.some((a) => a.answer === '(用户取消)'),
      });
    });
    return unsubscribe;
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <aside className="flex w-14 flex-col items-center border-r border-zinc-800 bg-zinc-900 py-4">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={`mb-2 flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
              location.pathname.startsWith(item.to)
                ? 'bg-zinc-700 text-white'
                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
            title={item.label}
          >
            <NavIcon name={item.icon} />
          </NavLink>
        ))}
      </aside>
      <main className="flex flex-1 min-h-0 flex-col overflow-hidden">{children}</main>
      <ConfirmDialog />
      <AskUserDialog />
    </div>
  );
}
