/**
 * Electron shell — starts the embedded SafeStream server and opens the dashboard.
 * Uses a fixed default port so Google OAuth redirect URIs stay stable (add the shown URI in Cloud Console).
 */
import { app, BrowserWindow, ipcMain, session, dialog } from 'electron';
import path from 'path';
import SafeStream from './index';

const DEFAULT_PORT = 38421;

let mainWindow: BrowserWindow | null = null;
let safeStreamInstance: SafeStream | null = null;
let windowIpcBound = false;

function sendMaximizedState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(
      'ss-maximized-changed',
      mainWindow.isMaximized()
    );
  }
}

function setupWindowIpc(): void {
  if (windowIpcBound) return;
  windowIpcBound = true;

  ipcMain.on('ss-window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });
  ipcMain.on('ss-window-toggle-maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    sendMaximizedState();
  });
  ipcMain.on('ss-window-close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
}
setupWindowIpc();

ipcMain.handle('ss-get-api-token', () => {
  return safeStreamInstance?.getApiToken?.() ?? '';
});

function isSafeNavigationUrl(url: string): boolean {
  if (!url || url.startsWith('about:')) return true;
  try {
    const u = new URL(url);
    const isLocal =
      u.protocol === 'http:' &&
      (u.hostname === '127.0.0.1' ||
        u.hostname === 'localhost' ||
        u.hostname === '::1');
    const isGoogle =
      u.protocol === 'https:' &&
      (u.hostname === 'accounts.google.com' ||
        u.hostname.endsWith('.google.com'));
    return isLocal || isGoogle;
  } catch {
    return false;
  }
}

let localCspHookRegistered = false;

function registerLocalServerCspHook(): void {
  if (localCspHookRegistered) return;
  localCspHookRegistered = true;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const fromApp =
      details.url.startsWith('http://127.0.0.1') ||
      details.url.startsWith('http://localhost') ||
      details.url.startsWith('http://[::1]');
    if (!fromApp) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "form-action 'self' https://accounts.google.com https://*.google.com",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob:",
      "connect-src 'self' http://127.0.0.1:* http://localhost:* http://[::1]:* https://fonts.googleapis.com https://fonts.gstatic.com"
    ].join('; ');
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    });
  });
}

function applyElectronEnv(userData: string): void {
  process.env.SAFESTREAM_ELECTRON = '1';
  process.env.SAFESTREAM_USER_DATA = userData;
  process.env.SAFESTREAM_TOKEN_PATH = path.join(userData, 'tokens.json');
  process.env.SAFESTREAM_DATA_DIR = path.join(userData, 'data');
  const port = parseInt(
    process.env.SAFESTREAM_PORT ||
      process.env.YTCHATGUARD_PORT ||
      String(DEFAULT_PORT),
    10
  );
  process.env.PORT = String(port);
}

async function startBackend(): Promise<void> {
  const userData = app.getPath('userData');
  applyElectronEnv(userData);
  safeStreamInstance = new SafeStream({ storageDirectory: userData });
  await safeStreamInstance.initialize({
    electron: true,
    packaged: app.isPackaged,
    port: parseInt(process.env.PORT ?? `${DEFAULT_PORT}`, 10),
    oauthHost: '127.0.0.1'
  });
}

async function createWindow(): Promise<void> {
  try {
    if (!safeStreamInstance) {
      await startBackend();
    }
  } catch (err: unknown) {
    console.error('Failed to start SafeStream:', err);
    safeStreamInstance = null;
    const msg =
      err instanceof Error ? err.message : String(err ?? 'Unknown error');
    dialog.showErrorBox(
      'SafeStream',
      `Could not start the server: ${msg}\n\nIf port ${DEFAULT_PORT} is in use, set SAFESTREAM_PORT (or legacy YTCHATGUARD_PORT) and add the matching OAuth redirect in Google Cloud.`
    );
    app.quit();
    return;
  }

  const ss = safeStreamInstance!;
  const port = ss.getListenPort();
  const url = `http://127.0.0.1:${port}/`;
  const preloadPath = path.join(__dirname, 'electron-preload.js');

  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 12, y: 10 } } : {}),
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isSafeNavigationUrl(targetUrl)) event.preventDefault();
  });

  mainWindow.loadURL(url);
  mainWindow.webContents.once('did-finish-load', sendMaximizedState);
  mainWindow.once('ready-to-show', () => {
    if (mainWindow) mainWindow.show();
  });
  mainWindow.on('maximize', sendMaximizedState);
  mainWindow.on('unmaximize', sendMaximizedState);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

let isQuitting = false;

async function shutdownBackend(): Promise<void> {
  if (safeStreamInstance && typeof safeStreamInstance.shutdown === 'function') {
    try {
      await safeStreamInstance.shutdown();
    } catch (e: unknown) {
      console.error('Shutdown error:', e);
    }
    safeStreamInstance = null;
  }
}

void app.whenReady().then(() => {
  registerLocalServerCspHook();
  createWindow().catch(console.error);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch(console.error);
  }
});

app.on('before-quit', async (e) => {
  if (isQuitting) return;
  isQuitting = true;
  e.preventDefault();
  await shutdownBackend();
  app.exit(0);
});
