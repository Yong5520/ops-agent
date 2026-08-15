import { logger } from '../utils/logger.js';

// Multi-window terminal session routing (Feature 2), extracted as pure logic
// so it can be unit-tested without importing electron / node-pty.
//
// The core reliability concern: a terminal opened in a standalone window must
// receive its shell data/exit events in THAT window, and closing that window
// must kill its SSH sessions so they don't leak (active-terminals would else
// keep the host connection alive forever). These two helpers implement exactly
// that, operating on minimal structural interfaces.

// Minimal structural shape for the owner window. Electron's BrowserWindow
// satisfies this; depending on the interface keeps the logic testable.
export interface OwnerWindowLike {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  };
}

// Minimal structural shape for a terminal session, as seen by the routing
// helpers. The full TerminalSession in terminal.ts satisfies this structurally.
export interface TerminalSessionLike {
  sessionId: string;
  hostId: string;
  hostName: string;
  type: 'ssh' | 'local' | 'serial';
  ownerWindow: OwnerWindowLike | null;
  stream: { destroy(): void } | null;
  pty?: { kill(): void } | null;
  closed: boolean;
}

// Send an event to the session's owning window. Guards against the window
// being destroyed (a send racing with window close) so we never throw into an
// SSH stream handler. This is what makes a standalone-window terminal actually
// receive output - without it, events would go to a hardcoded main window and
// the new window would stay blank.
export function sendToOwner(
  session: TerminalSessionLike,
  channel: string,
  ...args: unknown[]
): void {
  const win = session.ownerWindow;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, ...args);
}

// Kill every session owned by a window. Used when a standalone terminal window
// closes so its SSH shell streams don't leak. `map` and `onSshKilled` are
// injectable for unit testing; production passes the live sessions map and
// `unmarkTerminalActive`.
export function killSessionsForWindow(
  win: OwnerWindowLike,
  map: Map<string, TerminalSessionLike>,
  onSshKilled?: (hostId: string) => void,
): void {
  for (const [id, session] of map) {
    if (session.ownerWindow !== win) continue;
    session.closed = true;
    try {
      session.pty?.kill();
    } catch {
      // ignore - process may already be dead
    }
    try {
      session.stream?.destroy();
    } catch {
      // ignore
    }
    session.stream = null;
    session.pty = null;
    map.delete(id);
    if (session.type === 'ssh') {
      onSshKilled?.(session.hostId);
    }
    logger.info(`[Terminal] Session ${id} killed (owner window closed)`);
  }
}
