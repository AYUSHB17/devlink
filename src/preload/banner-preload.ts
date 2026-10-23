import { contextBridge, ipcRenderer } from 'electron';

// The banner can only do one thing: stop screen sharing on this machine.
contextBridge.exposeInMainWorld('banner', { stop: () => ipcRenderer.invoke('banner:stop') });
