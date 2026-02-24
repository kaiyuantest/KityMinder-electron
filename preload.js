// preload.js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    getDeviceId: () => ipcRenderer.invoke("get-device-id"),
    checkActivation: () => ipcRenderer.invoke("check-activation"),
    openNewWindow: (noteNumber) => ipcRenderer.invoke('open-new-window', noteNumber),
    activate: (km) => ipcRenderer.invoke("activate", km),
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    saveLocalImage: (arrayBuffer, filename) => ipcRenderer.invoke('save-local-image', arrayBuffer, filename),
    saveImageToLocal: (data) => ipcRenderer.invoke('save-image-to-local', data)
});