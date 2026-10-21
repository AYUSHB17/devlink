import { contextBridge, ipcRenderer, webUtils } from 'electron';

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('devlink', {
  getState: () => invoke('state'),
  onState: (cb: (s: unknown) => void) => ipcRenderer.on('state', (_e, s) => cb(s)),
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  startPairing: () => invoke('pair:start'),
  stopPairing: () => invoke('pair:stop'),
  pairWith: (host: string, port: number) => invoke('pair:with', host, port),
  answerPair: (ok: boolean) => invoke('pair:answer', ok),
  unpair: (id: string) => invoke('unpair', id),
  updateSettings: (patch: Record<string, unknown>) => invoke('settings', patch),
  chooseDownloads: () => invoke('settings:downloads'),
  sendPaths: (peerId: string, paths: string[]) => invoke('files:send', peerId, paths),
  pickAndSend: (peerId: string, folders: boolean) => invoke('files:pick', peerId, folders),
  reveal: (p: string) => invoke('reveal', p),
  pushClipboard: (peerId?: string) => invoke('clip:push', peerId),
  addForward: (peerId: string, listenPort: number, remotePort: number) => invoke('fwd:add', peerId, listenPort, remotePort),
  removeForward: (id: string) => invoke('fwd:remove', id),
  toggleForward: (id: string, enabled: boolean) => invoke('fwd:toggle', id, enabled),
  openLocal: (port: number) => invoke('open-local', port),
  saveShortcut: (label: string, command: string) => invoke('shortcut:save', label, command),
  removeShortcut: (id: string) => invoke('shortcut:remove', id),
  runCommand: (command: string) => invoke('shortcut:run', command),
  copy: (text: string) => invoke('copy', text),
});
