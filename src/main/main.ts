import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, ipcMain, Notification, powerMonitor, safeStorage, shell } from 'electron';
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ClipboardAdapter } from './clipboard';
import { Core } from './core';
import { ControlBanner } from './control-banner';
import { EdgeStrips, stripPage } from './edge-strip';
import { findHelper, HelperProcess } from './input-helper';
import { cleanUrl } from './links';
import { parseArgv } from './jobs';
import { ScreenWindows } from './screen-windows';
import { SecretBox } from './store';
import { registerRemoteFsIpc } from './remotefs-ipc';
import { runInTerminal } from './shortcuts';

// Two instances on one machine (for testing): DEVLINK_PROFILE=b DEVLINK_PORT=47822 npm start
// Screen view runs WebRTC on the LAN without STUN/TURN. Chromium hides host IPs behind random .local mDNS
// names by default, which other machines often can't resolve (notably on Windows); DevLink's windows only
// load local pages, so use the real LAN addresses.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

const profile = process.env.DEVLINK_PROFILE;
if (profile) app.setPath('userData', path.join(app.getPath('userData'), '..', `DevLink-${profile}`));
if (!profile && !app.requestSingleInstanceLock()) app.quit();

const smoke = process.argv.includes('--smoke');
let win: BrowserWindow | null = null;
let core: Core;
let strips: EdgeStrips | null = null;
let banner: ControlBanner | null = null;
let screenWins: ScreenWindows | null = null;

/** Documents/media "Send & open" may open directly; anything else (scripts, apps…) is only shown in its folder. */
const OPEN_OK = new Set(['.pdf', '.txt', '.md', '.log', '.csv', '.json', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.mp4', '.mov', '.mp3', '.wav', '.m4a', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.rtf', '.odt', '.ods', '.odp', '.pages', '.numbers', '.key']);
function openReceived(p: string, files: number): void {
  // received files are already marked as downloaded (see files.ts markFromNetwork)
  if (files === 1 && OPEN_OK.has(path.extname(p).toLowerCase()) && fs.existsSync(p) && fs.statSync(p).isFile()) void shell.openPath(p);
  else shell.showItemInFolder(p);
}

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => execFile(cmd, args, { timeout: 3000 }, (e, out) => (e ? reject(e) : resolve(String(out)))));
const CHROMIUM = ['Google Chrome', 'Google Chrome Canary', 'Microsoft Edge', 'Brave Browser', 'Arc', 'Chromium', 'Vivaldi', 'Opera'];

/** URL of the frontmost browser tab on macOS (asks for Automation permission once), else a link on the clipboard. */
async function frontTabUrl(): Promise<string | null> {
  if (process.platform === 'darwin') {
    try {
      const asn = (await run('lsappinfo', ['front'])).trim();
      const name = /"LSDisplayName"="([^"]+)"/.exec(await run('lsappinfo', ['info', '-only', 'name', asn]))?.[1] ?? '';
      const script = CHROMIUM.includes(name)
        ? `tell application "${name}" to get URL of active tab of front window`
        : name === 'Safari'
          ? 'tell application "Safari" to get URL of front document'
          : null;
      if (script) {
        const url = cleanUrl((await run('osascript', ['-e', script])).trim());
        if (url) return url;
      }
    } catch {
      /* fall back to the clipboard */
    }
  }
  return cleanUrl((await clipboard.readText()).trim());
}

async function sendFrontTab(notify: (title: string, body: string) => unknown): Promise<void> {
  const online = core.store.peers.filter((p) => core.sessions.has(p.id));
  const beside = online.filter((p) => core.store.settings.inputLayout?.[p.id]);
  const target = beside.length === 1 ? beside[0] : online.length === 1 ? online[0] : null;
  if (!target) return void notify('DevLink', online.length ? 'Several devices are connected; arrange one in the Screens tab' : 'No device is connected');
  const url = await frontTabUrl();
  if (!url) return void notify('DevLink', 'No browser tab found. Copy a link, then press the shortcut again.');
  try {
    core.links.send(target.id, [url]);
    notify('DevLink', `Sent to ${target.name}: ${url.slice(0, 80)}`);
  } catch (e: any) {
    notify('DevLink', e.message);
  }
}
const preloadPath = path.join(__dirname, '..', 'preload', 'preload.js');
const rendererDir = path.join(__dirname, '..', 'renderer');

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
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(rendererDir, 'index.html'));
  win.on('closed', () => {
    win = null;
    // the hidden edge strips are windows too; closing the main window still quits
    app.quit();
  });
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
  handle('peer:alt', (id: string, host: string, port: number) => {
    if (typeof id !== 'string' || typeof host !== 'string') throw new Error('bad request');
    core.setAltAddress(id, host, port);
  });
  handle('settings', (patch: Record<string, unknown>) => {
    const allowed = ['deviceName', 'clipboardSync', 'clipboardImages', 'acceptFiles', 'allowForwarding', 'listenPort'];
    const bools = ['inputSharing', 'allowRemoteInput', 'swapCmdCtrl', 'invertScroll', 'clipboardOnCross', 'edgeDrop', 'acceptLinks', 'openSentFiles', 'allowScreenView', 'allowJobs', 'browserBridge'];
    const clean: Record<string, unknown> = {};
    for (const k of allowed) if (k in patch) clean[k] = patch[k];
    for (const k of bools) if (typeof patch[k] === 'boolean') clean[k] = patch[k];
    const scale = Number(patch.pointerScale);
    if ('pointerScale' in patch && scale >= 0.25 && scale <= 4) clean.pointerScale = scale;
    core.store.updateSettings(clean);
    core.input.announce();
    core.screen.settingsChanged();
    core.jobs.settingsChanged();
    void core.bridge.reconcile();
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
  handle('files:pickOpen', async (peerId: string) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return 0;
    void core.files.sendPaths(peerId, r.filePaths, { open: true }).catch((e) => core.log(String(e)));
    return 1;
  });
  handle('links:send', (peerId: string, url: string) => core.links.send(String(peerId), [url]));
  handle('screen:request', (peerId: string) => void core.screen.request(String(peerId)));
  // answered in this machine's own window
  handle('screen:consent', (ok: boolean) => core.screen.answerConsent(ok === true));
  handle('screen:stopAll', () => core.screen.stopSharing());
  handle('screen:privacy', () => {
    if (process.platform === 'darwin') return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  });
  handle('jobs:workspaces', (peerId: string) => core.jobs.remoteWorkspaces(String(peerId)));
  handle('jobs:run', (peerId: string, ws: string, cwd: string, command: string) => {
    const argv = parseArgv(String(command));
    return core.jobs.run(String(peerId), { ws: String(ws), cwd: String(cwd || ''), argv }).id;
  });
  handle('jobs:cancel', (id: string) => core.jobs.cancel(String(id)));
  // approving a job happens in this machine's own window; Jobs ignores it while another device is driving this machine
  handle('jobs:answer', (id: string, decision: string) => core.jobs.answer(String(id), decision === 'session' ? 'session' : decision === 'once' ? 'once' : 'deny'));
  handle('jobs:stop', (id: string) => core.jobs.stop(String(id)));
  handle('jobs:addWorkspace', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return core.jobs.addWorkspace(r.filePaths[0]).name;
  });
  handle('jobs:removeWorkspace', (id: string) => core.jobs.removeWorkspace(String(id)));
  handle('bridge:newToken', () => {
    core.bridge.newToken();
    core.changed();
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
  handle('input:layout', (peerId: string, side: string | null) => {
    if (!core.store.getPeer(String(peerId))) throw new Error('unknown device');
    if (side !== null && !['left', 'right', 'top', 'bottom'].includes(side)) throw new Error('bad side');
    core.input.setLayout(String(peerId), side as any);
  });
  // must be answered on this machine; InputShare ignores it while this machine is being remote controlled
  handle('input:consent', (ok: boolean) => core.input.answerConsent(ok === true));
  handle('input:privacy', (pane: string) => {
    if (process.platform !== 'darwin') return;
    const anchor = pane === 'input' ? 'Privacy_ListenEvent' : 'Privacy_Accessibility';
    return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
  });
}

if (process.platform === 'win32') app.setAppUserModelId('in.optimist.devlink');

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
    openUrl: (u) => void shell.openExternal(u),
    inputBackend: new HelperProcess(
      findHelper(path.join(__dirname, '..', '..'), app.isPackaged ? process.resourcesPath : undefined),
      (m) => console.log(`[devlink] ${m}`),
    ),
  });
  core.on('changed', pushState);
  core.on('received', (t: { name: string; peerName: string; path?: string; open?: boolean; files: number }) => {
    if (t.open && t.path && core.store.settings.openSentFiles) openReceived(t.path, t.files);
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: `Received from ${t.peerName}`, body: t.name });
    n.on('click', () => t.path && shell.showItemInFolder(t.path));
    n.show();
  });
  strips = new EdgeStrips(core, path.join(__dirname, '..', 'preload', 'strip-preload.js'), stripPage(rendererDir));
  banner = new ControlBanner(core, rendererDir);
  screenWins = new ScreenWindows(core, path.join(__dirname, '..', 'preload', 'screen-preload.js'), rendererDir);
  const notify = (title: string, body: string) => Notification.isSupported() && new Notification({ title, body }).show();
  core.on('links-received', (e: { peerName: string; count: number; hosts: string[] }) =>
    notify(`${e.peerName} opened ${e.count} link(s)`, e.hosts.slice(0, 4).join(', ') + (e.hosts.length > 4 ? ', …' : '')));
  // lock screen ends screen sharing (control already ends when the local mouse/keyboard is used)
  powerMonitor.on('lock-screen', () => core.screen.stopSharing());
  powerMonitor.on('suspend', () => core.screen.stopSharing());
  core.on('links-failed', (e: { peerName: string; reason?: string }) => notify(`Couldn't open links on ${e.peerName}`, e.reason ?? ''));
  core.screen.on('consent', (peerName: string) => {
    // ask for attention without stealing focus: a peer must not be able to pull this window forward
    if (process.platform === 'darwin') app.dock?.bounce('informational');
    else win?.flashFrame(true);
    notify('DevLink', `${peerName} wants to view this screen – answer in DevLink`);
  });
  core.jobs.on('consent', (peerName: string) => {
    // ask for attention without stealing focus: a peer must not be able to pull this window forward
    if (process.platform === 'darwin') app.dock?.bounce('informational');
    else win?.flashFrame(true);
    notify('DevLink', `${peerName} wants to run a program here – answer in DevLink`);
  });
  // "send this tab": the front browser tab (macOS) or a link on the clipboard, to the device beside this one
  const hotkey = 'CommandOrControl+Alt+Shift+L';
  if (!globalShortcut.register(hotkey, () => void sendFrontTab(notify))) core.log(`could not register ${hotkey}`);
  core.on('send-failed', (t: { name: string; peerName: string; error?: string }) => {
    if (Notification.isSupported()) new Notification({ title: `Couldn't send to ${t.peerName}`, body: `${t.name}: ${t.error ?? 'failed'}` }).show();
  });
  core.input.on('consent', (peerName: string) => {
    // ask for attention without stealing focus: a peer must not be able to pull this window forward
    if (process.platform === 'darwin') app.dock?.bounce('informational');
    else win?.flashFrame(true);
    if (Notification.isSupported()) new Notification({ title: 'DevLink', body: `${peerName} wants to control this machine – answer in DevLink` }).show();
  });
  // visible "being controlled" indicator: window title, plus the Dock badge on macOS
  let lastMode = '';
  core.on('changed', () => {
    const snap = core.input.snapshot();
    const mode = `${snap.mode}:${snap.peer ?? ''}`;
    if (mode === lastMode) return;
    lastMode = mode;
    const label = snap.mode === 'following' ? `controlled by ${snap.peer}` : snap.mode === 'leading' ? `controlling ${snap.peer}` : '';
    win?.setTitle('DevLink' + (profile ? ` (${profile})` : '') + (label ? ` – ${label}` : ''));
    if (process.platform === 'darwin') app.dock?.setBadge(snap.mode === 'following' ? '⌨' : '');
  });
  registerIpc();
  const remoteEdit = registerRemoteFsIpc(core, { ipcMain, dialog, shell, win: () => win, editDir: path.join(app.getPath('userData'), 'devlink-edit') });
  app.on('before-quit', () => remoteEdit.stopAll());
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
app.on('before-quit', () => {
  strips?.destroy();
  banner?.destroy();
  screenWins?.closeAll();
  globalShortcut.unregisterAll();
  void core?.stop();
});
app.on('activate', () => {
  if (!win) createWindow();
});
