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
});
