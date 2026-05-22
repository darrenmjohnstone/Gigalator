const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // File system operations
  readTextFile: (relPath) => ipcRenderer.invoke('fs:readTextFile', relPath),
  writeTextFile: (relPath, text) => ipcRenderer.invoke('fs:writeTextFile', relPath, text),
  readBinaryFile: (relPath) => ipcRenderer.invoke('fs:readBinaryFile', relPath),
  writeBinaryFile: (relPath, buffer) => ipcRenderer.invoke('fs:writeBinaryFile', relPath, buffer),
  deleteFile: (relPath) => ipcRenderer.invoke('fs:deleteFile', relPath),
  fileExists: (relPath) => ipcRenderer.invoke('fs:fileExists', relPath),
  ensureDir: (relPath) => ipcRenderer.invoke('fs:ensureDir', relPath),
  getGigalatorPath: () => ipcRenderer.invoke('fs:getGigalatorPath'),

  // File picker (uses Electron's native dialog)
  pickFile: (filters) => ipcRenderer.invoke('dialog:pickFile', filters),

  // Git deploy (commit + push everything)
  gitDeploy: () => ipcRenderer.invoke('git:deploy'),

  // API key (Anthropic) — stored in api/.env, used by the local AI server
  getApiKey: () => ipcRenderer.invoke('settings:getApiKey'),
  setApiKey: (key) => ipcRenderer.invoke('settings:setApiKey', key),
  hasApiKey: () => ipcRenderer.invoke('settings:hasApiKey'),

  // Audio processing (Mono / Normalise) for the Settings modal
  audioStatus: () => ipcRenderer.invoke('audio:status'),
  audioMonoAll: () => ipcRenderer.invoke('audio:monoAll'),
  audioNormaliseAll: () => ipcRenderer.invoke('audio:normaliseAll'),
  audioRemoveNormalise: () => ipcRenderer.invoke('audio:removeNormalise'),
  audioRemoveMono: () => ipcRenderer.invoke('audio:removeMono'),
  audioGetParams: () => ipcRenderer.invoke('audio:getParams'),
  audioSetParams: (partial) => ipcRenderer.invoke('audio:setParams', partial),
  audioGetTrackParams: (relPath) => ipcRenderer.invoke('audio:getTrackParams', relPath),
  audioSetTrackParams: (relPath, overrideOrNull) => ipcRenderer.invoke('audio:setTrackParams', relPath, overrideOrNull),
  audioPreviewTrack: (relPath, params) => ipcRenderer.invoke('audio:previewTrack', relPath, params),
  audioNormaliseOne: (relPath, params) => ipcRenderer.invoke('audio:normaliseOne', relPath, params),
  onAudioProgress: (cb) => {
    const wrapped = (_e, payload) => cb(payload);
    ipcRenderer.on('audio:progress', wrapped);
    return () => ipcRenderer.removeListener('audio:progress', wrapped);
  },
});
