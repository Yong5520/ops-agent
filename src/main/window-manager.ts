import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { logger } from './utils/logger.js';

// Standalone terminal window manager (Feature 2).
//
// Creates a secondary BrowserWindow that hosts a single interactive terminal
// (TerminalWindowPage) for one host, so the user can run a terminal alongside
// the AI chat in the main window without switching tabs.
//
// The window loads the same renderer bundle but with a `#/terminal-window/:hostId`
// hash. The renderer entry (main.tsx) detects that hash and renders
// TerminalWindowPage directly (no AppShell/sidebar). That page calls
// `terminal.start(hostId)` on mount; terminal.ts captures the new window as the
// session owner via `event.sender`, so shell data/exit events route back here.
//
// Path logic mirrors electron/main.ts createWindow so dev (Vite URL) and prod
// (loadFile) both resolve correctly.

export function createTerminalWindow(hostId: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 920,
    height: 620,
    minWidth: 480,
    minHeight: 320,
    title: 'OpsAgent 终端',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const hostSegment = encodeURIComponent(hostId);
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/terminal-window/${hostSegment}`);
  } else {
    // loadFile's `hash` is appended after `#`, so include the leading slash so
    // the hash is `#/terminal-window/<id>` (matching the dev URL and the regex
    // the renderer entry uses to detect the standalone window).
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: `/terminal-window/${hostSegment}`,
    });
  }

  // External links (if any) open in the OS browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  logger.info(`[TerminalWindow] Created for hostId=${hostId}`);
  return win;
}
