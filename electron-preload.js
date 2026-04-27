/**
 * Preload: safe bridge for custom window chrome (minimize / maximize / close).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('safestream', {
  platform: process.platform,
  getApiToken: () => ipcRenderer.invoke('ss-get-api-token'),
  minimizeWindow: () => ipcRenderer.send('ss-window-minimize'),
  toggleMaximize: () => ipcRenderer.send('ss-window-toggle-maximize'),
  closeWindow: () => ipcRenderer.send('ss-window-close'),
  onMaximizedChange: (fn) => {
    const handler = (_e, isMax) => {
      try {
        fn(Boolean(isMax));
      } catch (err) {
        console.error(err);
      }
    };
    ipcRenderer.on('ss-maximized-changed', handler);
    return () => ipcRenderer.removeListener('ss-maximized-changed', handler);
  }
});
