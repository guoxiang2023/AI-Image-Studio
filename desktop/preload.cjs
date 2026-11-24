// Minimal, whitelisted bridge. The renderer never receives a filesystem API:
// it can only ask the main process to open a native directory picker, and gets
// back the path the user actually chose.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumaDesktop', {
  pickDirectory: () => ipcRenderer.invoke('luma:pick-directory'),
  platform: process.platform,
});