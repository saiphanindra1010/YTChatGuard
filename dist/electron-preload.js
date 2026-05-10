"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Preload: safe bridge for custom window chrome (minimize / maximize / close).
 */
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('safestream', {
    platform: process.platform,
    getApiToken: () => electron_1.ipcRenderer.invoke('ss-get-api-token'),
    minimizeWindow: () => electron_1.ipcRenderer.send('ss-window-minimize'),
    toggleMaximize: () => electron_1.ipcRenderer.send('ss-window-toggle-maximize'),
    closeWindow: () => electron_1.ipcRenderer.send('ss-window-close'),
    onMaximizedChange: (fn) => {
        const handler = (_e, isMax) => {
            try {
                fn(Boolean(isMax));
            }
            catch (err) {
                console.error(err);
            }
        };
        electron_1.ipcRenderer.on('ss-maximized-changed', handler);
        return () => electron_1.ipcRenderer.removeListener('ss-maximized-changed', handler);
    }
});
//# sourceMappingURL=electron-preload.js.map