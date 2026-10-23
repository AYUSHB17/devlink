import { contextBridge, ipcRenderer } from 'electron';

// Screen viewer / capture windows only get their own stream's controls. Which stream a window belongs to
// is decided in the main process from the window itself, never by the page.
contextBridge.exposeInMainWorld('screenApi', {
  hello: () => ipcRenderer.invoke('screen:hello'),
  signal: (data: unknown) => ipcRenderer.invoke('screen:signal', data),
  onSignal: (cb: (d: any) => void) => ipcRenderer.on('screen:signal', (_e, d) => cb(d)),
  onEnded: (cb: (reason: string) => void) => ipcRenderer.on('screen:ended', (_e, r) => cb(r)),
  source: () => ipcRenderer.invoke('screen:source'),
  live: () => ipcRenderer.invoke('screen:live'),
  stop: () => ipcRenderer.invoke('screen:stop'),
  mini: (on: boolean) => ipcRenderer.invoke('screen:mini', on),
});
