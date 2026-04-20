/**
 * Preload: safe bridge for custom window chrome (minimize / maximize / close).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ytchatguard', {
  platform: process.platform,
  minimizeWindow: () => ipcRenderer.send('ycg-window-minimize'),
  toggleMaximize: () => ipcRenderer.send('ycg-window-toggle-maximize'),
  closeWindow: () => ipcRenderer.send('ycg-window-close'),
  onMaximizedChange: (fn) => {
    const handler = (_e, isMax) => {
      try {
        fn(Boolean(isMax));
      } catch (err) {
        console.error(err);
      }
    };
    ipcRenderer.on('ycg-maximized-changed', handler);
    return () => ipcRenderer.removeListener('ycg-maximized-changed', handler);
  }
});
