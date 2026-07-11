import { ipcMain, dialog, type BrowserWindow } from 'electron';
import * as pty from 'node-pty';
import { connectionPool } from '../ssh/index.js';
import { logger } from '../utils/logger.js';
import { uploadFile, downloadFile, listDir, getSftp } from '../ssh/sftp.js';
import type { DirEntry } from '../ssh/sftp.js';

// Terminal session manager - manages interactive SSH shell sessions and
// local cmd.exe sessions for the terminal page.

interface TerminalSession {
  sessionId: string;
  hostId: string;
  hostName: string;
  type: 'ssh' | 'local';
  stream: {
    write: (data: string) => void;
    end: () => void;
    destroy: () => void;
    on: (event: string, cb: (data: Buffer) => void) => void;
    removeAllListeners: (event?: string) => void;
    setWindow?: (rows: number, cols: number, height: number, width: number) => void;
  } | null;
  pty?: pty.IPty | null;
  closed: boolean;
}

// Active terminal sessions keyed by sessionId
const sessions = new Map<string, TerminalSession>();
// Active SFTP transfers keyed by transferId for cancel/pause support
const activeTransfers = new Map<string, AbortController>();
let mainWindow: BrowserWindow | null = null;

// Channel names for terminal IPC
const CHANNELS = {
  START: 'terminal:start',
  START_LOCAL: 'terminal:startLocal',
  INPUT: 'terminal:input',
  RESIZE: 'terminal:resize',
  KILL: 'terminal:kill',
  DATA: 'terminal:data',
  EXIT: 'terminal:exit',
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
} as const;

export function registerTerminalHandlers(win: BrowserWindow): void {
  mainWindow = win;

  // Start a new SSH terminal session on the specified host
  ipcMain.handle(CHANNELS.START, async (_e, hostId: string) => {
    const mgr = await connectionPool.get(hostId);
    const conn = mgr.getConnection();

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
        };
        sessions.set(sessionId, session);

        stream.on('data', (data: Buffer) => {
          if (mainWindow && !session.closed) {
            mainWindow.webContents.send(CHANNELS.DATA, sessionId, data.toString());
          }
        });

        stream.on('close', () => {
          session.closed = true;
          session.stream = null;
          sessions.delete(sessionId);
          if (mainWindow) {
            mainWindow.webContents.send(CHANNELS.EXIT, sessionId, {
              hostName,
              reason: 'Stream closed',
            });
          }
          logger.info(`[Terminal] Session ${sessionId} on ${hostName} closed`);
        });

        logger.info(`[Terminal] SSH session ${sessionId} started on ${hostName}`);
        resolve({ sessionId, hostName });
      });
    });
  });

  // Start a local terminal session using node-pty (true PTY, not pipe)
  // This provides proper character echo, line editing, and terminal control
  // sequences that cmd.exe/bash expect from a real terminal.
  ipcMain.handle(CHANNELS.START_LOCAL, async () => {
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
    };
    sessions.set(sessionId, session);

    // Forward pty output to renderer
    const dataDisposable = ptyProcess.onData((data: string) => {
      if (mainWindow && !session.closed) {
        mainWindow.webContents.send(CHANNELS.DATA, sessionId, data);
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
      if (mainWindow) {
        mainWindow.webContents.send(CHANNELS.EXIT, sessionId, {
          hostName: session.hostName,
          reason: `Process exited with code ${exitCode}`,
        });
      }
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
    if (session?.stream && !session.closed) {
      session.stream.write(data);
    }
  });

  // Resize the terminal PTY (both SSH shells and local pty)
  ipcMain.handle(CHANNELS.RESIZE, async (_e, sessionId: string, cols: number, rows: number) => {
    const session = sessions.get(sessionId);
    if (session?.closed) return;
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
      session.closed = true;
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
      logger.info(`[Terminal] Session ${sessionId} killed by user`);
    }
  });

  // ── SFTP handlers ──────────────────────────────────────────────────────

  ipcMain.handle(CHANNELS.SFTP_LIST, async (_e, hostId: string, remotePath: string) => {
    const mgr = await connectionPool.get(hostId);
    const entries = await listDir(mgr, remotePath);
    return entries as DirEntry[];
  });

  // Upload with cancel support
  ipcMain.handle(
    CHANNELS.SFTP_UPLOAD,
    async (_e, hostId: string, localPath: string, remotePath: string, transferId: string) => {
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
}

// Clean up all terminal sessions on app exit
export function closeAllTerminals(): void {
  for (const [id, session] of sessions) {
    try {
      session.closed = true;
      if (session.pty) {
        session.pty.kill();
      }
      session.stream?.destroy();
    } catch {
      // ignore
    }
    sessions.delete(id);
  }
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
