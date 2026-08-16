import { useEffect } from 'react';
import { AiActivityTerminal } from '../Chat/AiActivityTerminal.js';
import { useActivityMirrorStore } from '../../store/activityMirrorStore.js';
import { useHostStore } from '../../store/hostStore.js';

interface ActivityMirrorWindowPageProps {
  /** Session id to scope the mirror to ('' = every session). URL-decoded by main.tsx. */
  sessionId: string;
}

// Standalone AI activity-terminal window (v24). Rendered directly by main.tsx
// when the window's URL hash is `#/activity-window` (bypasses AppShell). The
// main process fans agent/mirror events out to this window via
// mirrorEventTargets; this page just hosts the read-only xterm mirror.
export function ActivityMirrorWindowPage({ sessionId }: ActivityMirrorWindowPageProps) {
  const setSession = useActivityMirrorStore((s) => s.setSession);
  const loadHosts = useHostStore((s) => s.load);

  useEffect(() => {
    setSession(sessionId);
    loadHosts();
  }, [sessionId, setSession, loadHosts]);

  return (
    <div className="flex h-screen w-screen flex-col bg-[#0a0a0a]">
      <AiActivityTerminal sessionId={sessionId} onClose={() => window.close()} />
    </div>
  );
}
