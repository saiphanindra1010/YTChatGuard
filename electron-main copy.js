/**
 * Electron shell — starts the embedded SafeStream server and opens the dashboard.
 * Uses a fixed default port so Google OAuth redirect URIs stay stable (add the shown URI in Cloud Console).
 */
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');

const DEFAULT_PORT = 38421;

let mainWindow = null;
let safeStreamInstance = null;

function sendMaximizedState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ss-maximized-changed', mainWindow.isMaximized());
  }
}

/** Register once — safe if createWindow runs again */
function setupWindowIpc() {
  if (setupWindowIpc._done) return;
  setupWindowIpc._done = true;
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

function isSafeNavigationUrl(url) {
  if (!url || url.startsWith('about:')) return true;
  try {
    const u = new URL(url);
    const isLocal =
      u.protocol === 'http:' &&
      (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
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
function registerLocalServerCspHook() {
  if (localCspHookRegistered) return;
  localCspHookRegistered = true;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const fromApp =
      details.url.startsWith('http://127.0.0.1') ||
      details.url.startsWith('http://localhost');
    if (!fromApp) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self' https://accounts.google.com https://*.google.com",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob:",
      "connect-src 'self' http://127.0.0.1:* http://localhost:* https://fonts.googleapis.com https://fonts.gstatic.com"
    ].join('; ');
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    });
  });
}

function applyElectronEnv() {
  const userData = app.getPath('userData');
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

async function startBackend() {
  applyElectronEnv();
  // eslint-disable-next-line global-require
  const SafeStream = require('./index.js');
  safeStreamInstance = new SafeStream();
  await safeStreamInstance.initialize({
    electron: true,
    port: parseInt(process.env.PORT, 10),
    oauthHost: '127.0.0.1'
  });
  return safeStreamInstance;
}

async function createWindow() {
  try {
    if (!safeStreamInstance) {
      await startBackend();
    }
  } catch (err) {
    console.error('Failed to start SafeStream:', err);
    safeStreamInstance = null;
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'SafeStream',
      `Could not start the server: ${err.message}\n\nIf port ${DEFAULT_PORT} is in use, set SAFESTREAM_PORT (or legacy YTCHATGUARD_PORT) and add the matching OAuth redirect in Google Cloud.`
    );
    app.quit();
    return;
  }

  const port = safeStreamInstance.getListenPort
    ? safeStreamInstance.getListenPort()
    : parseInt(process.env.PORT, 10);
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
    // hiddenInset keeps traffic lights slightly inset; still need renderer padding-left for custom chrome.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 12, y: 10 } } : {}),
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
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

async function shutdownBackend() {
  if (safeStreamInstance && typeof safeStreamInstance.shutdown === 'function') {
    try {
      await safeStreamInstance.shutdown();
    } catch (e) {
      console.error('Shutdown error:', e);
    }
    safeStreamInstance = null;
  }
}

app.whenReady().then(() => {
  registerLocalServerCspHook();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', async (e) => {
  if (isQuitting) return;
  isQuitting = true;
  e.preventDefault();
  await shutdownBackend();
  app.exit(0);
});
