const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  activateModel: (id) => ipcRenderer.invoke('activate-model', id),
  addOrUpdateModel: (entry) => ipcRenderer.invoke('add-or-update-model', entry),
  deleteModel: (id) => ipcRenderer.invoke('delete-model', id),
});
