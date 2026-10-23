import { BrowserWindow, desktopCapturer, ipcMain, screen, systemPreferences } from 'electron';
import * as path from 'path';
import type { Core } from './core';

interface Win {
  win: BrowserWindow;
  role: 'viewer' | 'sender';
  name: string;
  hello: boolean;
  queue: unknown[];
  normalBounds?: Electron.Rectangle;
}

/**
 * Electron side of screen view: a visible viewer window per stream, and a hidden capture window on the
 * machine being viewed. Video flows peer-to-peer over WebRTC (LAN host candidates only, no STUN/TURN);
 * the offer/answer/ICE go through ScreenShare over the encrypted DevLink session.
 */
export class ScreenWindows {
  private bySid = new Map<string, Win>();
  private sidOf = new Map<number, string>();

  constructor(private core: Core, private preload: string, private rendererDir: string) {
    core.screen.canShare = () => {
      if (process.env.DEVLINK_FAKE_SCREEN || process.platform !== 'darwin') return null;
      const st = systemPreferences.getMediaAccessStatus('screen');
      return st === 'denied' || st === 'restricted'
        ? 'Screen Recording permission is off on that Mac (System Settings → Privacy & Security → Screen Recording → Electron)'
        : null;
    };
    core.screen.on('view-open', (sid: string, name: string) => this.open(sid, 'viewer', name));
    core.screen.on('share-start', (sid: string, peerId: string) => this.open(sid, 'sender', core.store.getPeer(peerId)?.name ?? 'device'));
    core.screen.on('signal', (sid: string, data: unknown) => this.deliver(sid, data));
    core.screen.on('stopped', (sid: string, reason: string) => this.ended(sid, reason));

    const own = (e: Electron.IpcMainInvokeEvent) => {
      const sid = this.sidOf.get(e.sender.id);
      const w = sid ? this.bySid.get(sid) : undefined;
      if (!sid || !w) throw new Error('not a screen window');
      return { sid, w };
    };
    ipcMain.handle('screen:hello', (e) => {
      const { sid, w } = own(e);
      w.hello = true;
      for (const d of w.queue.splice(0)) w.win.webContents.send('screen:signal', d);
      return { role: w.role, name: w.name };
    });
    ipcMain.handle('screen:signal', (e, data: unknown) => {
      const { sid } = own(e);
      this.core.screen.relay(sid, data);
    });
    ipcMain.handle('screen:live', (e) => this.core.screen.setLive(own(e).sid));
    ipcMain.handle('screen:stop', (e) => this.core.screen.stop(own(e).sid));
    ipcMain.handle('screen:source', async (e) => {
      const { w } = own(e);
      if (w.role !== 'sender') throw new Error('only the capture window can capture');
      if (process.env.DEVLINK_FAKE_SCREEN) return { fake: true };
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const primary = String(screen.getPrimaryDisplay().id);
      const src = sources.find((s) => s.display_id === primary) ?? sources[0];
      if (!src) throw new Error('no screen to capture (on macOS, allow Screen Recording for Electron)');
      return { id: src.id };
    });
    ipcMain.handle('screen:mini', (e, on: unknown) => {
      const { w } = own(e);
      if (w.role === 'viewer') this.setMini(w, on === true);
    });
  }

  private open(sid: string, role: 'viewer' | 'sender', name: string): void {
    const viewer = role === 'viewer';
    const win = new BrowserWindow({
      width: 1024,
      height: 640,
      minWidth: 240,
      minHeight: 150,
      title: viewer ? `${name} – screen` : 'DevLink screen capture',
      show: viewer,
      backgroundColor: '#000000',
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // the capture window is hidden; it must keep encoding at full rate
        backgroundThrottling: false,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    const entry: Win = { win, role, name, hello: false, queue: [] };
    const wcId = win.webContents.id;
    this.bySid.set(sid, entry);
    this.sidOf.set(wcId, sid);
    win.on('closed', () => {
      this.sidOf.delete(wcId);
      if (this.bySid.get(sid) === entry) {
        this.bySid.delete(sid);
        this.core.screen.stop(sid);
      }
    });
    void win.loadFile(path.join(this.rendererDir, viewer ? 'screen-view.html' : 'screen-send.html'));
  }

  private deliver(sid: string, data: unknown): void {
    const w = this.bySid.get(sid);
    if (!w || w.win.isDestroyed()) return;
    if (w.hello) w.win.webContents.send('screen:signal', data);
    else if (w.queue.length < 200) w.queue.push(data);
  }

  private ended(sid: string, reason: string): void {
    const w = this.bySid.get(sid);
    if (!w) return;
    this.bySid.delete(sid);
    if (w.win.isDestroyed()) return;
    if (w.role === 'sender') return void w.win.destroy();
    // keep the viewer window open with an explanation; closing it is up to the user
    w.win.webContents.send('screen:ended', reason || 'Screen sharing ended');
  }

  private setMini(w: Win, on: boolean): void {
    const win = w.win;
    if (on) {
      w.normalBounds = win.getBounds();
      const area = screen.getDisplayMatching(win.getBounds()).workArea;
      const width = 400;
      const height = 250;
      win.setAlwaysOnTop(true, 'floating');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setBounds({ x: area.x + area.width - width - 16, y: area.y + area.height - height - 16, width, height });
    } else {
      win.setAlwaysOnTop(false);
      win.setVisibleOnAllWorkspaces(false);
      if (w.normalBounds) win.setBounds(w.normalBounds);
    }
  }

  closeAll(): void {
    for (const w of this.bySid.values()) if (!w.win.isDestroyed()) w.win.destroy();
    this.bySid.clear();
  }
}
