import { useEffect, useRef, useState } from 'react';
import { TerminalView } from './TerminalView.js';
import { Button } from '../../components/Button.js';
import { resolveExitAction } from '../../lib/terminal-exit.js';

interface TerminalWindowPageProps {
  hostId: string;
}

type ConnStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

// Standalone terminal window (Feature 2). Rendered directly by main.tsx when
// the window's URL hash is `#/terminal-window/:hostId` (bypasses AppShell).
//
// On mount it calls `terminal.start(hostId)`; terminal.ts captures THIS window
// as the session owner (via event.sender), so shell data/exit events route
// back here. Closing the window is handled in the main process, which kills
// the session to avoid SSH shell leaks.
export function TerminalWindowPage({ hostId }: TerminalWindowPageProps) {
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [hostName, setHostName] = useState<string>('');
  const [error, setError] = useState<string>('');
  // Track the session we started so we can kill it if the component unmounts
  // before the window-close handler in the main process runs.
  const sessionRef = useRef<string | null>(null);

  const startSession = async () => {
    setStatus('connecting');
    setError('');
    try {
      const result = await window.opsAgent.terminal.start(hostId);
      sessionRef.current = result.sessionId;
      setSessionId(result.sessionId);
      setHostName(result.hostName);
      setStatus('connected');
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.opsAgent.terminal.start(hostId);
        if (cancelled) {
          // Window closed mid-start - clean up the session we just opened.
          window.opsAgent.terminal.kill(result.sessionId).catch(() => {});
          return;
        }
        sessionRef.current = result.sessionId;
        setSessionId(result.sessionId);
        setHostName(result.hostName);
        setStatus('connected');
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          setStatus('error');
        }
      }
    })();

    // Listen for stream exit / reconnect to drive the reconnect button. These
    // are separate from TerminalView's own listeners (the preload supports
    // multiple subscribers).
    const offExit = window.opsAgent.terminal.onExit((sid, info) => {
      if (sid !== sessionRef.current) return;
      if (resolveExitAction(info.reason) === 'close-tab') {
        // The user exited the shell (exit/logout/Ctrl+D) - close the window
        // (its 'closed' handler in the main process kills the session).
        window.close();
        return;
      }
      if (info.reason === 'reconnecting') {
        setStatus('connecting');
      } else {
        setStatus('disconnected');
      }
    });
    const offReconnect = window.opsAgent.terminal.onReconnect((sid) => {
      if (sid === sessionRef.current) setStatus('connected');
    });

    return () => {
      cancelled = true;
      offExit();
      offReconnect();
      const sid = sessionRef.current;
      if (sid) {
        window.opsAgent.terminal.kill(sid).catch(() => {
          // ignore - window-close handler in main also kills
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);

  const handleReconnect = async () => {
    // Kill the old session (if any) and start a fresh one.
    if (sessionRef.current) {
      await window.opsAgent.terminal.kill(sessionRef.current).catch(() => {});
      sessionRef.current = null;
      setSessionId(null);
    }
    await startSession();
  };

  const handleClose = () => {
    // Closing the window triggers the main-process 'closed' handler that kills
    // any sessions owned by this window.
    window.close();
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-[#0a0a0a]">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <span
            className={
              status === 'connected'
                ? 'text-emerald-400'
                : status === 'connecting'
                  ? 'text-amber-400'
                  : status === 'error'
                    ? 'text-red-400'
                    : 'text-zinc-500'
            }
          >
            ●
          </span>
          <span className="font-medium text-zinc-200">{hostName || '终端'}</span>
          <span className="text-zinc-600">{status}</span>
        </div>
        <div className="flex items-center gap-2">
          {status === 'disconnected' && (
            <Button size="sm" variant="primary" onClick={handleReconnect}>
              重连
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={handleClose}>
            关闭窗口
          </Button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {status === 'connecting' && !sessionId ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-amber-400" />
          </div>
        ) : status === 'error' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <p className="text-sm text-red-400">连接失败: {error}</p>
            <Button size="sm" variant="primary" onClick={handleReconnect}>
              重试
            </Button>
          </div>
        ) : sessionId ? (
          <TerminalView
            sessionId={sessionId}
            hostName={hostName}
            hostId={hostId}
            isActive={true}
            onOpenFileTransfer={() => {}}
            onToggleAiBar={() => {}}
          />
        ) : null}
      </div>
    </div>
  );
}
