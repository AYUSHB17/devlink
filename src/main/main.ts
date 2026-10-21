import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, safeStorage, shell } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ClipboardAdapter } from './clipboard';
import { Core } from './core';
import { SecretBox } from './store';
import { runInTerminal } from './shortcuts';

// Two instances on one machine (for testing): DEVLINK_PROFILE=b DEVLINK_PORT=47822 npm start
const profile = process.env.DEVLINK_PROFILE;
if (profile) app.setPath('userData', path.join(app.getPath('userData'), '..', `DevLink-${profile}`));
if (!profile && !app.requestSingleInstanceLock()) app.quit();

const smoke = process.argv.includes('--smoke');
let win: BrowserWindow | null = null;
let core: Core;

// Electron 45's clipboard is an async, Web-style API (Promise based).
const electronClipboard: ClipboardAdapter = {
  readText: () => clipboard.readText(),
  writeText: (t) => clipboard.writeText(t),
  readImagePng: async () => {
    if (!(await clipboard.has('image/png'))) return null;
    for (const item of await clipboard.read()) {
      if (item.types.includes('image/png')) return Buffer.from(await (await item.getType('image/png')).arrayBuffer());
    }
    return null;
  },
  writeImagePng: (png) =>
    clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]),
};

function secretBox(): SecretBox | undefined {
  if (process.env.DEVLINK_PLAINTEXT_KEY || !safeStorage.isEncryptionAvailable()) return undefined;
  return {
    encrypt: (s) => 'safe:' + safeStorage.encryptString(s).toString('base64'),
    decrypt: (s) => (s.startsWith('safe:') ? safeStorage.decryptString(Buffer.from(s.slice(5), 'base64')) : s.replace(/^plain:/, '')),
  };
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1020,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    title: 'DevLink' + (profile ? ` (${profile})` : ''),
    show: !smoke,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => (win = null));
}

let pending = false;
function pushState(): void {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    if (win && !win.isDestroyed()) win.webContents.send('state', core.state());
  }, 80);
}

function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e: any) {
      return { ok: false, error: e.reason ?? e.message ?? String(e) };
    }
  });
}

function registerIpc(): void {
  handle('state', () => core.state());
  handle('pair:start', () => core.startPairing());
  handle('pair:stop', () => core.stopPairing());
  handle('pair:with', async (host: string, port: number) => {
    if (typeof host !== 'string' || !Number.isInteger(port)) throw new Error('enter a host and a port');
    const peer = await core.pairWith(host.trim(), port);
    return peer.name;
  });
  handle('pair:answer', (ok: boolean) => core.answerPair(!!ok));
  handle('unpair', (id: string) => core.unpair(id));
  handle('settings', (patch: Record<string, unknown>) => {
    const allowed = ['deviceName', 'clipboardSync', 'clipboardImages', 'acceptFiles', 'allowForwarding', 'listenPort'];
    const clean: Record<string, unknown> = {};
    for (const k of allowed) if (k in patch) clean[k] = patch[k];
    core.store.updateSettings(clean);
    core.changed();
  });
  handle('settings:downloads', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    core.store.updateSettings({ downloadsDir: r.filePaths[0] });
    core.changed();
    return r.filePaths[0];
  });
  handle('files:send', (peerId: string, paths: string[]) => void core.files.sendPaths(peerId, paths.filter((p) => typeof p === 'string' && p)).catch((e) => core.log(String(e))));
  handle('files:pick', async (peerId: string, folders: boolean) => {
    const r = await dialog.showOpenDialog(win!, { properties: folders ? ['openDirectory'] : ['openFile', 'multiSelections'] });
    if (r.canceled) return 0;
    void core.files.sendPaths(peerId, r.filePaths).catch((e) => core.log(String(e)));
    return r.filePaths.length;
  });
  handle('reveal', (p: string) => {
    // only reveal paths inside the receive folder
    const root = path.resolve(core.store.settings.downloadsDir);
    const target = path.resolve(String(p));
    if (!target.startsWith(root + path.sep) && target !== root) throw new Error('not a received file');
    fs.mkdirSync(root, { recursive: true });
    if (fs.existsSync(target)) shell.showItemInFolder(target);
    else void shell.openPath(root);
  });
  handle('clip:push', async (peerId?: string) => {
    if (!(await core.clipboard.pushNow(peerId))) throw new Error('clipboard is empty');
  });
  handle('fwd:add', (peerId: string, l: number, r: number) => void core.forwards.add(peerId, Number(l), Number(r)));
  handle('fwd:remove', (id: string) => core.forwards.remove(id));
  handle('fwd:toggle', (id: string, on: boolean) => core.forwards.toggle(id, !!on));
  handle('open-local', (port: number) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad port');
    return shell.openExternal(`http://localhost:${port}`);
  });
  handle('shortcut:save', (label: string, command: string) => {
    if (!String(label).trim() || !String(command).trim()) throw new Error('label and command are required');
    core.store.setShortcuts([...core.store.shortcuts, { id: crypto.randomBytes(4).toString('hex'), label: String(label).trim(), command: String(command).trim() }]);
    core.changed();
  });
  handle('shortcut:remove', (id: string) => {
    core.store.setShortcuts(core.store.shortcuts.filter((s) => s.id !== id));
    core.changed();
  });
  // Only commands the user saved (or the suggested ssh lines built from paired devices) can be run.
  handle('shortcut:run', (command: string) => runInTerminal(String(command)));
  handle('copy', (text: string) => clipboard.writeText(String(text)));
}

app.whenReady().then(async () => {
  const port = process.env.DEVLINK_PORT ? Number(process.env.DEVLINK_PORT) : undefined;
  core = new Core({
    dir: path.join(app.getPath('userData'), 'devlink'),
    clipboard: electronClipboard,
    secretBox: secretBox(),
    defaults: {
      ...(port ? { listenPort: port } : {}),
      ...(process.env.DEVLINK_DOWNLOADS ? { downloadsDir: process.env.DEVLINK_DOWNLOADS } : {}),
      deviceName: (require('os').hostname() as string).replace(/\.local$/, '') + (profile ? `-${profile}` : ''),
    },
    log: (m) => console.log(`[devlink] ${m}`),
  });
  core.on('changed', pushState);
  registerIpc();
  await core.start();
  createWindow();
  if (smoke) {
    win!.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 800));
      const ok = await win!.webContents.executeJavaScript(`!!document.querySelector('#self-name') && document.querySelector('#self-name').textContent.length > 0`);
      console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAIL');
      app.exit(ok ? 0 : 1);
    });
  }
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => void core?.stop());
app.on('activate', () => {
  if (!win) createWindow();
});
