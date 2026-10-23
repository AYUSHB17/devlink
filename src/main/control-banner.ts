import { BrowserWindow, ipcMain, screen } from 'electron';
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
    // one-click stop from the banner itself, while this screen is being viewed
    ipcMain.handle('banner:stop', (e) => {
      if (this.win && !this.win.isDestroyed() && e.sender.id === this.win.webContents.id) core.screen.stopSharing();
    });
  }

  private update(): void {
    const snap = this.core.input.snapshot();
    const controlledBy = snap.mode === 'following' ? snap.peer : null;
    const viewedBy = this.core.screen.isSharing();
    const peer = controlledBy ?? viewedBy;
    // controlled and viewed at once: keep the viewing cue and its Stop button visible
    const mode = controlledBy && viewedBy ? 'both' : controlledBy ? 'control' : 'view';
    const key = peer ? `${mode}:${peer}:${viewedBy ?? ''}` : null;
    if (key === this.shownFor || this.destroyed) return;
    this.shownFor = key;
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
        webPreferences: {
          preload: path.join(__dirname, '..', 'preload', 'banner-preload.js'),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      // keep the banner out of screen captures (and out of the other machine's view of this screen)
      this.win.setContentProtection(true);
      this.win.setAlwaysOnTop(true, 'screen-saver');
      this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    } else this.win.setBounds(bounds);
    // while controlled the banner is click-through; while viewed it carries a Stop button
    this.win.setIgnoreMouseEvents(mode === 'control');
    void this.win.loadFile(path.join(this.rendererDir, 'banner.html'), { query: { name: peer, mode, viewer: viewedBy ?? '' } });
    this.win.showInactive();
  }

  destroy(): void {
    // the app is quitting; later state changes (e.g. from core.stop) must not touch the window
    this.destroyed = true;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}
