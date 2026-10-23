import { BrowserWindow, screen } from 'electron';
import * as path from 'path';
import type { Core } from './core';

/**
 * Always-on-top, click-through banner shown while another device controls this machine,
 * so it's obvious even when DevLink's own window is hidden.
 */
export class ControlBanner {
  private win: BrowserWindow | null = null;
  private shownFor: string | null = null;
  private destroyed = false;

  constructor(private core: Core, private rendererDir: string) {
    core.on('changed', () => this.update());
  }

  private update(): void {
    const snap = this.core.input.snapshot();
    const peer = snap.mode === 'following' ? snap.peer : null;
    if (peer === this.shownFor || this.destroyed) return;
    this.shownFor = peer;
    if (!peer) {
      if (this.win && !this.win.isDestroyed()) this.win.hide();
      return;
    }
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(600, area.width - 32);
    const bounds = { x: Math.round(area.x + (area.width - width) / 2), y: area.y + 8, width, height: 44 };
    if (!this.win || this.win.isDestroyed()) {
      this.win = new BrowserWindow({
        ...bounds,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
        alwaysOnTop: true,
        show: false,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      this.win.setAlwaysOnTop(true, 'screen-saver');
      this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      this.win.setIgnoreMouseEvents(true); // never intercept clicks
      this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    } else this.win.setBounds(bounds);
    void this.win.loadFile(path.join(this.rendererDir, 'banner.html'), { query: { name: peer } });
    this.win.showInactive();
  }

  destroy(): void {
    // the app is quitting; later state changes (e.g. from core.stop) must not touch the window
    this.destroyed = true;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}
