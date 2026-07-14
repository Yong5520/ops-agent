import { app, BrowserWindow, shell, dialog } from 'electron';
import { join } from 'node:path';
import { registerIpcHandlers, cleanupTerminalSessions } from '../src/main/ipc/handlers.js';
import { initDatabase } from '../src/main/storage/database.js';
import { cleanupOldResults, setResultsBaseDir } from '../src/main/agent/tool-results.js';
import { logger } from '../src/main/utils/logger.js';

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'OpsAgent',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return mainWindow;
}

app.whenReady().then(() => {
  try {
    initDatabase();
    setResultsBaseDir(join(app.getPath('userData'), 'tool-results'));
    cleanupOldResults(7);
  } catch (err) {
    logger.error('Startup failed:', err);
    dialog.showErrorBox(
      'OpsAgent 启动失败',
      `初始化失败，应用无法继续运行。\n\n` +
        `错误: ${err instanceof Error ? err.message : String(err)}\n\n` +
        `请截图此错误并反馈给开发者。\n` +
        `路径: ${app.getPath('userData')}`,
    );
    app.quit();
    return;
  }

  try {
    createWindow();
    if (mainWindow) {
      registerIpcHandlers(mainWindow);
    }
  } catch (err) {
    logger.error('Window creation failed:', err);
    dialog.showErrorBox(
      'OpsAgent 窗口创建失败',
      `窗口创建失败。\n\n错误: ${err instanceof Error ? err.message : String(err)}`,
    );
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  cleanupTerminalSessions();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  dialog.showErrorBox(
    'OpsAgent 发生异常',
    `应用遇到未捕获的异常。\n\n错误: ${err.message}\n\n堆栈:\n${err.stack ?? '(无)'}`,
  );
  app.quit();
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
  dialog.showErrorBox(
    'OpsAgent 发生异常',
    `应用遇到未处理的 Promise 拒绝。\n\n原因: ${reason instanceof Error ? reason.message : String(reason)}`,
  );
  app.quit();
});
