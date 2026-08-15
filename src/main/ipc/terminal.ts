import { ipcMain, dialog, BrowserWindow } from 'electron';
import * as pty from 'node-pty';
import { connectionPool } from '../ssh/index.js';
import { markTerminalActive, unmarkTerminalActive } from '../ssh/active-terminals.js';
import {
  getReconnectDelay,
  MAX_RECONNECT_ATTEMPTS,
  shouldAttemptReconnect,
} from '../ssh/reconnect.js';
import { generateCommand } from '../agent/ai-command.js';
import { logger } from '../utils/logger.js';
import { uploadFile, downloadFile, listDir, getSftp } from '../ssh/sftp.js';
import type { DirEntry } from '../ssh/sftp.js';
import { createTerminalWindow } from '../window-manager.js';
import { sendToOwner, killSessionsForWindow } from './terminal-routing.js';
import { hostsStore } from '../storage/hosts.js';
import { serialPool } from '../serial/index.js';
import type { SerialConnectionManager } from '../serial/index.js';

// Terminal session manager - manages interactive SSH shell sessions and
// local cmd.exe sessions for the terminal page.

interface TerminalSession {
  sessionId: string;
  hostId: string;
  hostName: string;
  type: 'ssh' | 'local' | 'serial';
  // The BrowserWindow that owns this session and should receive its data/exit
  // events. For terminals opened inside the main window this is `mainWindow`;
  // for terminals opened in a standalone terminal window (Feature 2) it is that
  // window. Captured from the calling renderer via `event.sender` so events are
  // always routed back to the window that started the session. Nullable in
  // type (mainWindow can be null at the type level); sendToOwner guards null.
  ownerWindow: BrowserWindow | null;
  stream: {
    write: (data: string) => void;
    end: () => void;
    destroy: () => void;
    on: (event: string, cb: (data: Buffer) => void) => void;
    removeAllListeners: (event?: string) => void;
    setWindow?: (rows: number, cols: number, height: number, width: number) => void;
  } | null;
  pty?: pty.IPty | null;
  // Serial sessions: the shared port manager + the raw-output subscription
  // feeding this terminal. The port itself stays open (owned by serialPool)
  // after the terminal closes - the idle sweeper reclaims it.
  serialManager?: SerialConnectionManager | null;
  serialUnsubscribe?: (() => void) | null;
  closed: boolean;
  reconnecting: boolean;
  lastCols: number;
  lastRows: number;
}

// Active terminal sessions keyed by sessionId
const sessions = new Map<string, TerminalSession>();
// Active SFTP transfers keyed by transferId for cancel/pause support
const activeTransfers = new Map<string, AbortController>();
let mainWindow: BrowserWindow | null = null;

// Multi-window routing helpers (sendToOwner / killSessionsForWindow) live in
// terminal-routing.ts so they can be unit-tested without importing electron.
// BrowserWindow satisfies OwnerWindowLike structurally.

// Channel names for terminal IPC
const CHANNELS = {
  START: 'terminal:start',
  START_LOCAL: 'terminal:startLocal',
  INPUT: 'terminal:input',
  RESIZE: 'terminal:resize',
  KILL: 'terminal:kill',
  OPEN_WINDOW: 'terminal:openWindow',
  DATA: 'terminal:data',
  EXIT: 'terminal:exit',
  RECONNECT: 'terminal:reconnect',
  // SFTP channels
  SFTP_LIST: 'sftp:list',
  SFTP_UPLOAD: 'sftp:upload',
  SFTP_DOWNLOAD: 'sftp:download',
  SFTP_REALPATH: 'sftp:realpath',
  SFTP_PROGRESS: 'sftp:progress',
  SFTP_CANCEL: 'sftp:cancel',
  // Native dialog channels
  DIALOG_SAVE: 'dialog:saveFile',
  DIALOG_OPEN: 'dialog:openFile',
  DIALOG_OPEN_DIRECTORY: 'dialog:openDirectory',
  // AI command generation
  AI_GENERATE_COMMAND: 'ai:generateCommand',
  // Serial console support: enumerate local serial ports for the host config UI
  SERIAL_LIST_PORTS: 'serial:listPorts',
  // Serial console support: immediately release the port a serial host is
  // holding in the pool (and terminate any active terminal session on it), so
  // the user can free a stuck/busy COM port without waiting for the idle
  // timeout or restarting the app.
  SERIAL_RELEASE_PORT: 'serial:releasePort',
} as const;

/**
 * Serial sessions don't auto-reconnect (a replugged/unplugged COM port needs
 * the user to re-open it): just clean up and notify the owner window.
 */
function terminateSerialSession(session: TerminalSession, reason: string): void {
  session.closed = true;
  session.serialUnsubscribe?.();
  session.serialUnsubscribe = null;
  session.serialManager = null;
  sessions.delete(session.sessionId);
  unmarkTerminalActive(session.hostId);
  sendToOwner(session, CHANNELS.EXIT, session.sessionId, {
    hostName: session.hostName,
    reason,
  });
}

/**
 * Start an interactive terminal session on a serial host. The port is owned by
 * serialPool (ports can't be opened twice); this session is just a subscriber
 * to the manager's raw output, and its input is passed straight through.
 */
async function startSerialTerminalSession(
  hostId: string,
  hostName: string,
  ownerWindow: BrowserWindow | null,
): Promise<{ sessionId: string; hostName: string }> {
  const mgr = await serialPool.get(hostId);
  const sessionId = `serial-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session: TerminalSession = {
    sessionId,
    hostId,
    hostName,
    type: 'serial' as const,
    ownerWindow,
    stream: null,
    serialManager: mgr,
    serialUnsubscribe: mgr.subscribe((data) => {
      if (!session.closed) {
        sendToOwner(session, CHANNELS.DATA, sessionId, data);
      }
    }),
    closed: false,
    reconnecting: false,
    lastCols: 80,
    lastRows: 24,
  };
  // Unexpected port closure (unplug / port stolen) ends the session; our own
  // kill() path never triggers this (closeRequested guards it).
  mgr.setOnPortClosed(() => {
    if (sessions.has(sessionId)) {
      logger.warn(`[Terminal] Serial port for ${hostName} closed unexpectedly`);
      terminateSerialSession(session, '串口已断开（设备拔出或端口被占用）');
    }
  });
  sessions.set(sessionId, session);
  markTerminalActive(hostId);
  logger.info(`[Terminal] Serial session ${sessionId} started on ${hostName} (${hostId})`);
  return { sessionId, hostName };
}

/** SFTP only works over SSH: reject serial hosts with a clear error. */
function ensureSftpCapable(hostId: string): void {
  const host = hostsStore.get(hostId);
  if (host?.connectionType === 'serial') {
    throw new Error(`主机 ${host.name} 是串口连接，不支持 SFTP 文件传输`);
  }
}

// Attempt to reconnect an SSH terminal session after an unexpected stream close.
// Tries up to MAX_RECONNECT_ATTEMPTS times with backoff (1s, 3s, 10s).
// On success: replaces the session's stream and sends terminal:reconnect event.
// On failure: sends terminal:exit with reason='reconnect-failed'.
async function attemptReconnect(session: TerminalSession): Promise<void> {
  if (session.reconnecting) return;
  session.reconnecting = true;

  // Notify renderer that we're attempting to reconnect
  sendToOwner(session, CHANNELS.EXIT, session.sessionId, {
    hostName: session.hostName,
    reason: 'reconnecting',
  });

  for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
    if (!shouldAttemptReconnect(session.closed, attempt)) {
      break;
    }

    const delay = getReconnectDelay(attempt);
    logger.info(
      `[Terminal] Reconnect attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} for ${session.hostName} in ${delay}ms`,
    );

    await new Promise((r) => setTimeout(r, delay));

    // User may have closed the tab while we were waiting
    if (session.closed) {
      session.reconnecting = false;
      return;
    }

    try {
      const mgr = await connectionPool.get(session.hostId);
      const conn = mgr.getConnection();

      const reconnected = await new Promise<boolean>((resolve) => {
        conn.shell(
          { term: 'xterm-256color', cols: session.lastCols, rows: session.lastRows },
          (err, stream) => {
            if (err) {
              logger.warn(
                `[Terminal] Reconnect shell failed on ${session.hostName}: ${err.message}`,
              );
              resolve(false);
              return;
            }

            session.stream = {
              write: (data: string) => stream.write(data),
              end: () => stream.end(),
              destroy: () => {
                stream.removeAllListeners();
                stream.end();
                try {
                  (stream as unknown as { destroy?: () => void }).destroy?.();
                } catch {
                  // ignore
                }
              },
              on: (event: string, cb: (data: Buffer) => void) => stream.on(event, cb),
              removeAllListeners: (event?: string) => stream.removeAllListeners(event),
              setWindow: (rows: number, cols: number, height: number, width: number) =>
                stream.setWindow(rows, cols, height, width),
            };
            session.reconnecting = false;

            stream.on('data', (data: Buffer) => {
              if (!session.closed) {
                sendToOwner(session, CHANNELS.DATA, session.sessionId, data.toString());
              }
            });

            stream.on('close', () => {
              if (session.closed) {
                session.stream = null;
                sessions.delete(session.sessionId);
                unmarkTerminalActive(session.hostId);
                sendToOwner(session, CHANNELS.EXIT, session.sessionId, {
                  hostName: session.hostName,
                  reason: 'Stream closed',
                });
                logger.info(
                  `[Terminal] Session ${session.sessionId} on ${session.hostName} closed by user`,
                );
                return;
              }
              session.stream = null;
              attemptReconnect(session);
            });

            resolve(true);
          },
        );
      });

      if (reconnected) {
        logger.info(
          `[Terminal] Reconnected session ${session.sessionId} on ${session.hostName} (attempt ${attempt + 1})`,
        );
        sendToOwner(session, CHANNELS.RECONNECT, session.sessionId, {
          hostName: session.hostName,
          attempt: attempt + 1,
        });
        return;
      }
    } catch (err) {
      logger.warn(
        `[Terminal] Reconnect attempt ${attempt + 1} failed for ${session.hostName}: ${(err as Error).message}`,
      );
    }
  }

  // All attempts exhausted
  session.reconnecting = false;
  sessions.delete(session.sessionId);
  unmarkTerminalActive(session.hostId);
  sendToOwner(session, CHANNELS.EXIT, session.sessionId, {
    hostName: session.hostName,
    reason: 'reconnect-failed',
  });
  logger.error(`[Terminal] All reconnect attempts failed for ${session.hostName}`);
}

export function registerTerminalHandlers(win: BrowserWindow): void {
  mainWindow = win;

  // Start a new SSH terminal session on the specified host
  ipcMain.handle(CHANNELS.START, async (_e, hostId: string) => {
    // Serial hosts take a dedicated session type (shared port from serialPool,
    // no SSH stream, no auto-reconnect).
    const host = hostsStore.get(hostId);
    if (host?.connectionType === 'serial') {
      const ownerWindow = BrowserWindow.fromWebContents(_e.sender) ?? mainWindow;
      return startSerialTerminalSession(hostId, host.name, ownerWindow);
    }

    const mgr = await connectionPool.get(hostId);
    const conn = mgr.getConnection();

    // Capture the calling window as the session owner so data/exit events are
    // routed back to it (main window for the Terminal page, or a standalone
    // terminal window for Feature 2). Falls back to mainWindow defensively.
    const ownerWindow = BrowserWindow.fromWebContents(_e.sender) ?? mainWindow;
    const sessionId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const hostName = mgr.hostName;

    return new Promise<{ sessionId: string; hostName: string }>((resolve, reject) => {
      conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
        if (err) {
          logger.error(`[Terminal] Failed to open shell on ${hostName}: ${err.message}`);
          reject(new Error(`SSH shell failed: ${err.message}`));
          return;
        }

        const session: TerminalSession = {
          sessionId,
          hostId,
          hostName,
          type: 'ssh' as const,
          ownerWindow,
          stream: {
            write: (data: string) => stream.write(data),
            end: () => stream.end(),
            destroy: () => {
              stream.removeAllListeners();
              stream.end();
              // Also destroy the underlying socket to force-close the PTY
              try {
                (stream as unknown as { destroy?: () => void }).destroy?.();
              } catch {
                // ignore
              }
            },
            on: (event: string, cb: (data: Buffer) => void) => stream.on(event, cb),
            removeAllListeners: (event?: string) => stream.removeAllListeners(event),
            setWindow: (rows: number, cols: number, height: number, width: number) =>
              stream.setWindow(rows, cols, height, width),
          },
          closed: false,
          reconnecting: false,
          lastCols: 80,
          lastRows: 24,
        };
        sessions.set(sessionId, session);
        markTerminalActive(hostId);

        stream.on('data', (data: Buffer) => {
          if (!session.closed) {
            sendToOwner(session, CHANNELS.DATA, sessionId, data.toString());
          }
        });

        stream.on('close', () => {
          // User-initiated close (via terminal:kill) -> clean exit, no reconnect
          if (session.closed) {
            session.stream = null;
            sessions.delete(sessionId);
            unmarkTerminalActive(hostId);
            sendToOwner(session, CHANNELS.EXIT, sessionId, {
              hostName,
              reason: 'Stream closed',
            });
            logger.info(`[Terminal] Session ${sessionId} on ${hostName} closed by user`);
            return;
          }
          // Unexpected close -> attempt auto-reconnect
          session.stream = null;
          attemptReconnect(session);
        });

        logger.info(`[Terminal] SSH session ${sessionId} started on ${hostName}`);
        resolve({ sessionId, hostName });
      });
    });
  });

  // Start a local terminal session using node-pty (true PTY, not pipe)
  // This provides proper character echo, line editing, and terminal control
  // sequences that cmd.exe/bash expect from a real terminal.
  ipcMain.handle(CHANNELS.START_LOCAL, async (_e) => {
    const ownerWindow = BrowserWindow.fromWebContents(_e.sender) ?? mainWindow;
    const sessionId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const isWin = process.platform === 'win32';
    const shellCmd = isWin ? 'cmd.exe' : 'bash';
    const shellArgs = isWin ? [] : ['-l'];

    const ptyProcess = pty.spawn(shellCmd, shellArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.env.USERPROFILE || process.env.HOME || process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      useConpty: true,
    });

    const session: TerminalSession = {
      sessionId,
      hostId: 'local',
      hostName: isWin ? '本地 CMD' : '本地 Shell',
      type: 'local' as const,
      ownerWindow,
      stream: {
        write: (data: string) => ptyProcess.write(data),
        end: () => {
          // no-op for pty; kill handles cleanup
        },
        destroy: () => {
          try {
            ptyProcess.kill();
          } catch {
            // ignore - process may already be dead
          }
        },
        on: () => {},
        removeAllListeners: () => {},
      },
      pty: ptyProcess,
      closed: false,
      reconnecting: false,
      lastCols: 80,
      lastRows: 24,
    };
    sessions.set(sessionId, session);

    // Forward pty output to the owning renderer
    const dataDisposable = ptyProcess.onData((data: string) => {
      if (!session.closed) {
        sendToOwner(session, CHANNELS.DATA, sessionId, data);
      }
    });

    // Handle pty exit
    const exitDisposable = ptyProcess.onExit(({ exitCode }) => {
      session.closed = true;
      session.stream = null;
      session.pty = null;
      sessions.delete(sessionId);
      dataDisposable.dispose();
      exitDisposable.dispose();
      sendToOwner(session, CHANNELS.EXIT, sessionId, {
        hostName: session.hostName,
        reason: `Process exited with code ${exitCode}`,
      });
      logger.info(`[Terminal] Local session ${sessionId} exited with code ${exitCode}`);
    });

    logger.info(
      `[Terminal] Local PTY session ${sessionId} started (${shellCmd}, pid=${ptyProcess.pid})`,
    );
    return { sessionId, hostName: session.hostName };
  });

  // Write user input to the shell
  ipcMain.handle(CHANNELS.INPUT, async (_e, sessionId: string, data: string) => {
    const session = sessions.get(sessionId);
    if (session?.closed) return;
    if (session?.stream && !session.closed) {
      session.stream.write(data);
    } else if (session?.type === 'serial' && session.serialManager) {
      session.serialManager.write(data);
    }
  });

  // Resize the terminal PTY (both SSH shells and local pty)
  ipcMain.handle(CHANNELS.RESIZE, async (_e, sessionId: string, cols: number, rows: number) => {
    const session = sessions.get(sessionId);
    if (session?.closed) return;
    if (session) {
      session.lastCols = cols;
      session.lastRows = rows;
    }
    // SSH shell uses setWindow
    if (session?.stream?.setWindow) {
      session.stream.setWindow(rows, cols, rows * 16, cols * 8);
    }
    // Local pty uses resize
    if (session?.pty) {
      try {
        session.pty.resize(cols, rows);
      } catch {
        // ignore resize errors
      }
    }
  });

  // Kill a terminal session (force-close the shell stream / pty process)
  ipcMain.handle(CHANNELS.KILL, async (_e, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.closed = true; // Mark as user-initiated close so stream 'close' won't reconnect
      // Serial: detach from the shared port (the pool's idle sweeper closes
      // the port later) and notify the owner - no close event will fire.
      if (session.type === 'serial') {
        session.serialUnsubscribe?.();
        session.serialUnsubscribe = null;
        session.serialManager = null;
        sessions.delete(sessionId);
        unmarkTerminalActive(session.hostId);
        serialPool.touch(session.hostId);
        sendToOwner(session, CHANNELS.EXIT, sessionId, {
          hostName: session.hostName,
          reason: '串口会话已关闭',
        });
        logger.info(`[Terminal] Serial session ${sessionId} closed by user`);
        return;
      }
      // For local pty: kill the pty process
      if (session.pty) {
        try {
          session.pty.kill();
        } catch {
          // ignore
        }
      }
      // For SSH stream: destroy to force-close the PTY channel
      try {
        session.stream?.destroy();
      } catch {
        // ignore
      }
      session.stream = null;
      session.pty = null;
      sessions.delete(sessionId);
      if (session.type === 'ssh') {
        unmarkTerminalActive(session.hostId);
      }
      logger.info(`[Terminal] Session ${sessionId} killed by user`);
    }
  });

  // Open a standalone terminal window for a host (Feature 2). Creates a new
  // BrowserWindow loading the `#/terminal-window/:hostId` route; that window's
  // renderer calls `terminal:start` on mount, and the session is owned by the
  // new window (captured via event.sender) so data flows back to it rather than
  // the main window. Closing the window kills its sessions to avoid leaks.
  ipcMain.handle(CHANNELS.OPEN_WINDOW, async (_e, hostId: string) => {
    const ownerWindow = createTerminalWindow(hostId);
    ownerWindow.on('closed', () => {
      // Kill sessions owned by this window so SSH shells don't leak. Pass the
      // live `sessions` map and `unmarkTerminalActive` so idle-close can resume.
      killSessionsForWindow(ownerWindow, sessions, unmarkTerminalActive);
    });
    return { ok: true };
  });

  // ── SFTP handlers ──────────────────────────────────────────────────────

  ipcMain.handle(CHANNELS.SFTP_LIST, async (_e, hostId: string, remotePath: string) => {
    ensureSftpCapable(hostId);
    const mgr = await connectionPool.get(hostId);
    const entries = await listDir(mgr, remotePath);
    return entries as DirEntry[];
  });

  // Upload with cancel support
  ipcMain.handle(
    CHANNELS.SFTP_UPLOAD,
    async (_e, hostId: string, localPath: string, remotePath: string, transferId: string) => {
      ensureSftpCapable(hostId);
      const mgr = await connectionPool.get(hostId);
      const controller = new AbortController();
      activeTransfers.set(transferId, controller);

      try {
        const result = await uploadFile(mgr, localPath, remotePath, {
          signal: controller.signal,
          pool: connectionPool,
          hostId,
          onProgress: (transferred, total) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(CHANNELS.SFTP_PROGRESS, {
                direction: 'upload' as const,
                hostId,
                remotePath,
                transferred,
                total,
                transferId,
              });
            }
          },
        });
        logger.info(
          `[SFTP] Uploaded ${localPath} -> ${remotePath} (${result.bytesTransferred} bytes)`,
        );
        return result;
      } finally {
        activeTransfers.delete(transferId);
      }
    },
  );

  // Download with cancel support
  ipcMain.handle(
    CHANNELS.SFTP_DOWNLOAD,
    async (_e, hostId: string, remotePath: string, localPath: string, transferId: string) => {
      ensureSftpCapable(hostId);
      const mgr = await connectionPool.get(hostId);
      const controller = new AbortController();
      activeTransfers.set(transferId, controller);

      try {
        const result = await downloadFile(mgr, remotePath, localPath, {
          signal: controller.signal,
          pool: connectionPool,
          hostId,
          onProgress: (transferred, total) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(CHANNELS.SFTP_PROGRESS, {
                direction: 'download' as const,
                hostId,
                remotePath,
                localPath,
                transferred,
                total,
                transferId,
              });
            }
          },
        });
        logger.info(
          `[SFTP] Downloaded ${remotePath} -> ${localPath} (${result.bytesTransferred} bytes)`,
        );
        return result;
      } finally {
        activeTransfers.delete(transferId);
      }
    },
  );

  // Cancel an active SFTP transfer
  ipcMain.handle(CHANNELS.SFTP_CANCEL, async (_e, transferId: string) => {
    const controller = activeTransfers.get(transferId);
    if (controller) {
      controller.abort();
      activeTransfers.delete(transferId);
      logger.info(`[SFTP] Transfer ${transferId} cancelled by user`);
      return true;
    }
    return false;
  });

  // Resolve the home directory of the SSH user
  ipcMain.handle(CHANNELS.SFTP_REALPATH, async (_e, hostId: string) => {
    ensureSftpCapable(hostId);
    const mgr = await connectionPool.get(hostId);
    const sftp = await getSftp(mgr);
    return new Promise<string>((resolve, reject) => {
      sftp.realpath('.', (err, absPath) => {
        if (err) {
          reject(new Error(`realpath failed: ${err.message}`));
        } else {
          resolve(absPath);
        }
      });
    });
  });

  // ── Native dialog handlers ──────────────────────────────────────────────

  ipcMain.handle(CHANNELS.DIALOG_SAVE, async (_e, defaultName: string, title: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: title || '保存文件',
      defaultPath: defaultName,
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  ipcMain.handle(CHANNELS.DIALOG_OPEN, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择文件',
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(CHANNELS.DIALOG_OPEN_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择文件夹',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // ── AI command generation ────────────────────────────────────────────────

  ipcMain.handle(
    CHANNELS.AI_GENERATE_COMMAND,
    async (_e, naturalLanguage: string, hostId?: string) => {
      const result = await generateCommand({ naturalLanguage, hostId });
      return result;
    },
  );

  // ── Serial console handlers ─────────────────────────────────────────────

  // Enumerate local serial ports (COMx / ttyUSB*) for the host-config picker.
  // Lazy-require so vitest never loads serialport's native binding.
  ipcMain.handle(CHANNELS.SERIAL_LIST_PORTS, async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SerialPort } = require('serialport') as {
      SerialPort: { list: () => Promise<Array<Record<string, unknown>>> };
    };
    const ports = await SerialPort.list();
    return ports.map((p) => ({
      path: String(p.path ?? ''),
      manufacturer: typeof p.manufacturer === 'string' ? p.manufacturer : undefined,
      serialNumber: typeof p.serialNumber === 'string' ? p.serialNumber : undefined,
      friendlyName: typeof p.friendlyName === 'string' ? p.friendlyName : undefined,
    }));
  });

  // Immediately release the serial port a host is holding in the pool. Also
  // terminates any active terminal session on that host: the pool's close()
  // sets closeRequested (so the port 'close' event won't fire and the terminal
  // wouldn't otherwise learn the port is gone), so we surface an EXIT here.
  // Use case: free a stuck/busy COM port without waiting for the idle timeout
  // or restarting the app (e.g. another tool needs the port, or a reconnect
  // is failing with Access denied because the pool still holds the port).
  ipcMain.handle(CHANNELS.SERIAL_RELEASE_PORT, async (_e, hostId: string) => {
    for (const session of sessions.values()) {
      if (session.type === 'serial' && session.hostId === hostId) {
        terminateSerialSession(session, '串口已手动释放');
      }
    }
    serialPool.invalidate(hostId);
    logger.info(`[Terminal] Serial port released for host ${hostId}`);
    return { ok: true };
  });
}

// Clean up all terminal sessions on app exit
export function closeAllTerminals(): void {
  for (const [id, session] of sessions) {
    try {
      session.closed = true;
      if (session.pty) {
        session.pty.kill();
      }
      if (session.type === 'serial') {
        session.serialUnsubscribe?.();
        session.serialManager = null;
      }
      session.stream?.destroy();
    } catch {
      // ignore
    }
    sessions.delete(id);
  }
  // Serial ports are shared singletons - close them all on shutdown.
  serialPool.closeAll();
  // Cancel all active transfers
  for (const [, controller] of activeTransfers) {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }
  activeTransfers.clear();
  logger.info('[Terminal] All terminal sessions closed');
}

// Export channel names for preload
export const TERMINAL_CHANNELS = CHANNELS;
