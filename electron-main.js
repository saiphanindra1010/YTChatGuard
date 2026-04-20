/**
 * Electron shell — starts the embedded YTChatGuard server and opens the dashboard.
 * Uses a fixed default port so Google OAuth redirect URIs stay stable (add the shown URI in Cloud Console).
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const DEFAULT_PORT = 38421;

let mainWindow = null;
let ytGuardInstance = null;

function sendMaximizedState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ycg-maximized-changed', mainWindow.isMaximized());
  }
}

/** Register once — safe if createWindow runs again */
function setupWindowIpc() {
  if (setupWindowIpc._done) return;
  setupWindowIpc._done = true;
  ipcMain.on('ycg-window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });
  ipcMain.on('ycg-window-toggle-maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    sendMaximizedState();
  });
  ipcMain.on('ycg-window-close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
}
setupWindowIpc();

function applyElectronEnv() {
  const userData = app.getPath('userData');
  process.env.YTCHATGUARD_ELECTRON = '1';
  process.env.YTCHATGUARD_USER_DATA = userData;
  process.env.YTCHATGUARD_TOKEN_PATH = path.join(userData, 'tokens.json');
  process.env.YTCHATGUARD_DATA_DIR = path.join(userData, 'data');
  const port = parseInt(process.env.YTCHATGUARD_PORT || String(DEFAULT_PORT), 10);
  process.env.PORT = String(port);
}

async function startBackend() {
  applyElectronEnv();
  // eslint-disable-next-line global-require
  const YTChatGuard = require('./index.js');
  ytGuardInstance = new YTChatGuard();
  await ytGuardInstance.initialize({
    electron: true,
    port: parseInt(process.env.PORT, 10),
    oauthHost: '127.0.0.1'
  });
  return ytGuardInstance;
}

async function createWindow() {
  try {
    if (!ytGuardInstance) {
      await startBackend();
    }
  } catch (err) {
    console.error('Failed to start YTChatGuard:', err);
    ytGuardInstance = null;
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'YTChatGuard',
      `Could not start the server: ${err.message}\n\nIf port ${DEFAULT_PORT} is in use, set YTCHATGUARD_PORT and add the matching OAuth redirect in Google Cloud.`
    );
    app.quit();
    return;
  }

  const port = ytGuardInstance.getListenPort
    ? ytGuardInstance.getListenPort()
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
      contextIsolation: true
    }
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
  if (ytGuardInstance && typeof ytGuardInstance.shutdown === 'function') {
    try {
      await ytGuardInstance.shutdown();
    } catch (e) {
      console.error('Shutdown error:', e);
    }
    ytGuardInstance = null;
  }
}

app.whenReady().then(() => {
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
