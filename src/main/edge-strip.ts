import { BrowserWindow, ipcMain, screen } from 'electron';
import * as path from 'path';
import type { Core } from './core';
import type { ScreenSide } from './store';

const THICKNESS = 40;
/** a strip never stays up longer than this, even if the drag's mouse-up was missed */
const MAX_VISIBLE_MS = 15_000;

/**
 * Slim always-on-top drop targets along the screen edges that face paired devices.
 * Shown only while a drag is in progress (reported by the input helper), so they never block clicks.
 */
export class EdgeStrips {
  private strips = new Map<ScreenSide, BrowserWindow>();
  private hideTimer?: NodeJS.Timeout;
  private maxTimer?: NodeJS.Timeout;
  /** strip webContents id -> the peer that strip sends to */
  private peerOf = new Map<number, string>();

  constructor(private core: Core, private preload: string, private page: string) {
    core.input.on('drag', (active: boolean) => (active ? this.show() : this.scheduleHide()));
    ipcMain.handle('strip:drop', (e, paths: unknown) => {
      const peerId = this.peerOf.get(e.sender.id);
      if (!peerId || !Array.isArray(paths)) return { ok: false, error: 'not a drop strip' };
      const clean = paths.filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, 1000);
      if (!clean.length) return { ok: false, error: 'nothing to send' };
      void this.core.files.sendPaths(peerId, clean).catch((err) => this.core.log(`edge drop: ${err.message}`));
      this.scheduleHide();
      return { ok: true };
    });
    // a link or browser tab URL dropped on the edge opens on the device on that side
    ipcMain.handle('strip:links', (e, urls: unknown) => {
      const peerId = this.peerOf.get(e.sender.id);
      if (!peerId || !Array.isArray(urls)) return { ok: false, error: 'not a drop strip' };
      try {
        this.core.links.send(peerId, urls.slice(0, 50));
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
      this.scheduleHide();
      return { ok: true };
    });
  }

  private targets(): { side: ScreenSide; peerId: string; name: string }[] {
    const s = this.core.store.settings;
    if (!s.edgeDrop) return [];
    return Object.entries(s.inputLayout ?? {})
      .filter(([peerId]) => this.core.sessions.has(peerId))
      .map(([peerId, side]) => ({ side, peerId, name: this.core.store.getPeer(peerId)?.name ?? 'device' }));
  }

  private bounds(side: ScreenSide): Electron.Rectangle {
    // work areas leave the Dock / taskbar / menu bar alone, so a drop meant for them isn't swallowed
    const displays = screen.getAllDisplays().map((d) => d.workArea);
    const pick = (key: (b: Electron.Rectangle) => number, max: boolean) =>
      displays.reduce((a, b) => ((max ? key(b) > key(a) : key(b) < key(a)) ? b : a));
    switch (side) {
      case 'right': {
        const b = pick((r) => r.x + r.width, true);
        return { x: b.x + b.width - THICKNESS, y: b.y, width: THICKNESS, height: b.height };
      }
      case 'left': {
        const b = pick((r) => r.x, false);
        return { x: b.x, y: b.y, width: THICKNESS, height: b.height };
      }
      case 'top': {
        const b = pick((r) => r.y, false);
        return { x: b.x, y: b.y, width: b.width, height: THICKNESS };
      }
      case 'bottom': {
        const b = pick((r) => r.y + r.height, true);
        return { x: b.x, y: b.y + b.height - THICKNESS, width: b.width, height: THICKNESS };
      }
    }
  }

  private show(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    for (const t of this.targets()) {
      let w = this.strips.get(t.side);
      if (!w || w.isDestroyed()) {
        w = new BrowserWindow({
          ...this.bounds(t.side),
          frame: false,
          transparent: true,
          resizable: false,
          movable: false,
          focusable: false,
          skipTaskbar: true,
          hasShadow: false,
          alwaysOnTop: true,
          show: false,
          webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
        });
        w.setAlwaysOnTop(true, 'screen-saver');
        w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        w.webContents.on('will-navigate', (e) => e.preventDefault());
        this.strips.set(t.side, w);
      } else {
        w.setBounds(this.bounds(t.side));
      }
      this.peerOf.set(w.webContents.id, t.peerId);
      void w.loadFile(this.page, { query: { name: t.name, side: t.side } });
      w.showInactive();
    }
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = setTimeout(() => this.scheduleHide(), MAX_VISIBLE_MS);
  }

  private scheduleHide(): void {
    // give the drop event a moment to arrive before the window disappears
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      for (const w of this.strips.values()) if (!w.isDestroyed()) w.hide();
    }, 700);
  }

  destroy(): void {
    for (const w of this.strips.values()) if (!w.isDestroyed()) w.destroy();
    this.strips.clear();
  }
}

export const stripPage = (rendererDir: string) => path.join(rendererDir, 'strip.html');
