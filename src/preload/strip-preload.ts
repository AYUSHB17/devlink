import { contextBridge, ipcRenderer, webUtils } from 'electron';

// The edge drop strip gets only what it needs. The target device is decided in the main process
// from which strip window sent the drop, never by the page.
contextBridge.exposeInMainWorld('strip', {
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  drop: (paths: string[]) => ipcRenderer.invoke('strip:drop', paths),
  dropLinks: (urls: string[]) => ipcRenderer.invoke('strip:links', urls),
});
