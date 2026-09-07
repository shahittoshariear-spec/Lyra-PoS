const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tally', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  exportBackup: () => ipcRenderer.invoke('data:exportBackup'),
  importBackup: () => ipcRenderer.invoke('data:importBackup'),
  importProductsFile: () => ipcRenderer.invoke('data:importProductsFile'),
  resetAllData: () => ipcRenderer.invoke('data:resetAll'),
  resetSalesStock: () => ipcRenderer.invoke('data:resetSalesStock'),
  printReceipt: (html, deviceName) => ipcRenderer.invoke('receipt:print', html, deviceName),
  listPrinters: () => ipcRenderer.invoke('printer:list')
});
