"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Electron shell — starts the embedded SafeStream server and opens the dashboard.
 * Uses a fixed default port so Google OAuth redirect URIs stay stable (add the shown URI in Cloud Console).
 */
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const index_1 = __importDefault(require("./index"));
const DEFAULT_PORT = 38421;
let mainWindow = null;
let safeStreamInstance = null;
let windowIpcBound = false;
function sendMaximizedState() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ss-maximized-changed', mainWindow.isMaximized());
    }
}
function setupWindowIpc() {
    if (windowIpcBound)
        return;
    windowIpcBound = true;
    electron_1.ipcMain.on('ss-window-minimize', () => {
        if (mainWindow && !mainWindow.isDestroyed())
            mainWindow.minimize();
    });
    electron_1.ipcMain.on('ss-window-toggle-maximize', () => {
        if (!mainWindow || mainWindow.isDestroyed())
            return;
        if (mainWindow.isMaximized())
            mainWindow.unmaximize();
        else
            mainWindow.maximize();
        sendMaximizedState();
    });
    electron_1.ipcMain.on('ss-window-close', () => {
        if (mainWindow && !mainWindow.isDestroyed())
            mainWindow.close();
    });
}
setupWindowIpc();
electron_1.ipcMain.handle('ss-get-api-token', () => {
    return safeStreamInstance?.getApiToken?.() ?? '';
});
function isSafeNavigationUrl(url) {
    if (!url || url.startsWith('about:'))
        return true;
    try {
        const u = new URL(url);
        const isLocal = u.protocol === 'http:' &&
            (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
        const isGoogle = u.protocol === 'https:' &&
            (u.hostname === 'accounts.google.com' ||
                u.hostname.endsWith('.google.com'));
        return isLocal || isGoogle;
    }
    catch {
        return false;
    }
}
let localCspHookRegistered = false;
function registerLocalServerCspHook() {
    if (localCspHookRegistered)
        return;
    localCspHookRegistered = true;
    electron_1.session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const fromApp = details.url.startsWith('http://127.0.0.1') ||
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
    const userData = electron_1.app.getPath('userData');
    process.env.SAFESTREAM_ELECTRON = '1';
    process.env.SAFESTREAM_USER_DATA = userData;
    process.env.SAFESTREAM_TOKEN_PATH = path_1.default.join(userData, 'tokens.json');
    process.env.SAFESTREAM_DATA_DIR = path_1.default.join(userData, 'data');
    const port = parseInt(process.env.SAFESTREAM_PORT ||
        process.env.YTCHATGUARD_PORT ||
        String(DEFAULT_PORT), 10);
    process.env.PORT = String(port);
}
async function startBackend() {
    applyElectronEnv();
    safeStreamInstance = new index_1.default();
    await safeStreamInstance.initialize({
        electron: true,
        port: parseInt(process.env.PORT ?? `${DEFAULT_PORT}`, 10),
        oauthHost: '127.0.0.1'
    });
}
async function createWindow() {
    try {
        if (!safeStreamInstance) {
            await startBackend();
        }
    }
    catch (err) {
        console.error('Failed to start SafeStream:', err);
        safeStreamInstance = null;
        const msg = err instanceof Error ? err.message : String(err ?? 'Unknown error');
        electron_1.dialog.showErrorBox('SafeStream', `Could not start the server: ${msg}\n\nIf port ${DEFAULT_PORT} is in use, set SAFESTREAM_PORT (or legacy YTCHATGUARD_PORT) and add the matching OAuth redirect in Google Cloud.`);
        electron_1.app.quit();
        return;
    }
    const ss = safeStreamInstance;
    const port = ss.getListenPort();
    const url = `http://127.0.0.1:${port}/`;
    const preloadPath = path_1.default.join(__dirname, 'electron-preload.js');
    const isMac = process.platform === 'darwin';
    mainWindow = new electron_1.BrowserWindow({
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
            sandbox: true
        }
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
        if (!isSafeNavigationUrl(targetUrl))
            event.preventDefault();
    });
    mainWindow.loadURL(url);
    mainWindow.webContents.once('did-finish-load', sendMaximizedState);
    mainWindow.once('ready-to-show', () => {
        if (mainWindow)
            mainWindow.show();
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
        }
        catch (e) {
            console.error('Shutdown error:', e);
        }
        safeStreamInstance = null;
    }
}
void electron_1.app.whenReady().then(() => {
    registerLocalServerCspHook();
    createWindow().catch(console.error);
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
electron_1.app.on('activate', () => {
    if (electron_1.BrowserWindow.getAllWindows().length === 0) {
        createWindow().catch(console.error);
    }
});
electron_1.app.on('before-quit', async (e) => {
    if (isQuitting)
        return;
    isQuitting = true;
    e.preventDefault();
    await shutdownBackend();
    electron_1.app.exit(0);
});
//# sourceMappingURL=electron-main.js.map