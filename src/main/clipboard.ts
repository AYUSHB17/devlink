import * as crypto from 'crypto';
import type { Core } from './core';

/** Thin wrapper so the core can run (and be tested) without Electron. */
export interface ClipboardAdapter {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  /** PNG bytes if the clipboard currently holds an image, else null */
  readImagePng(): Promise<Buffer | null>;
  writeImagePng(png: Buffer): Promise<void>;
}

export interface ClipEntry {
  ts: number;
  dir: 'in' | 'out';
  peer: string;
  kind: 'text' | 'image';
  preview: string;
}

const MAX_TEXT = 2 * 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
const hash = (b: Buffer | string) => crypto.createHash('sha1').update(b).digest('hex');

/**
 * Polls the local clipboard and mirrors changes to every connected peer.
 * Content received from a peer is remembered by hash so it is never echoed back.
 */
export class ClipboardSync {
  readonly log: ClipEntry[] = [];
  private timer?: NodeJS.Timeout;
  private lastHash = '';
  private tick = 0;
  private busy = false;

  constructor(private core: Core, private cb: ClipboardAdapter, private pollMs = 700) {
    core.onJson('clip', (peerId, msg) => void this.onMessage(peerId, msg).catch((e) => core.log(`clipboard: ${e.message}`)));
  }

  start(): void {
    void this.currentHash().then((h) => (this.lastHash = h));
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      this.poll()
        .catch((e) => this.core.log(`clipboard: ${e.message}`))
        .finally(() => (this.busy = false));
    }, this.pollMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async currentHash(): Promise<string> {
    try {
      const t = await this.cb.readText();
      if (t) return hash(t);
      const img = await this.cb.readImagePng();
      return img ? hash(img) : '';
    } catch {
      return '';
    }
  }

  private peerName(id: string): string {
    return this.core.store.getPeer(id)?.name ?? 'device';
  }

  private record(e: ClipEntry): void {
    this.log.unshift(e);
    this.log.length = Math.min(this.log.length, 30);
    this.core.changed();
  }

  private async poll(): Promise<void> {
    const s = this.core.store.settings;
    if (!s.clipboardSync) {
      this.lastHash = await this.currentHash();
      return;
    }
    const text = await this.cb.readText();
    if (text) {
      const h = hash(text);
      if (h === this.lastHash) return;
      this.lastHash = h;
      if (text.length > MAX_TEXT || !this.core.sessions.size) return;
      this.core.broadcast({ t: 'clip', kind: 'text', data: text });
      this.record({ ts: Date.now(), dir: 'out', peer: 'all devices', kind: 'text', preview: preview(text) });
      return;
    }
    // images are more expensive to read, check them less often
    if (!s.clipboardImages || ++this.tick % 3 !== 0) return;
    const png = await this.cb.readImagePng();
    if (!png) return;
    const h = hash(png);
    if (h === this.lastHash) return;
    this.lastHash = h;
    if (png.length > MAX_IMAGE || !this.core.sessions.size) return;
    this.core.broadcast({ t: 'clip', kind: 'image', data: png.toString('base64') });
    this.record({ ts: Date.now(), dir: 'out', peer: 'all devices', kind: 'image', preview: `image (${Math.round(png.length / 1024)} KB)` });
  }

  /** Push whatever is on the clipboard right now, even when sync is switched off. */
  async pushNow(peerId?: string): Promise<boolean> {
    const text = await this.cb.readText();
    const png = text ? null : await this.cb.readImagePng();
    const msg = text ? { t: 'clip', kind: 'text', data: text, force: true } : png ? { t: 'clip', kind: 'image', data: png.toString('base64'), force: true } : null;
    if (!msg) return false;
    if (peerId) this.core.send(peerId, msg);
    else this.core.broadcast(msg);
    this.record({ ts: Date.now(), dir: 'out', peer: peerId ? this.peerName(peerId) : 'all devices', kind: text ? 'text' : 'image', preview: text ? preview(text) : 'image' });
    return true;
  }

  private async onMessage(peerId: string, msg: any): Promise<void> {
    const s = this.core.store.settings;
    if (!s.clipboardSync && !msg.force) return;
    if (msg.kind === 'text' && typeof msg.data === 'string' && msg.data.length <= MAX_TEXT) {
      const h = hash(msg.data);
      if (h === this.lastHash) return;
      this.lastHash = h;
      await this.cb.writeText(msg.data);
      this.record({ ts: Date.now(), dir: 'in', peer: this.peerName(peerId), kind: 'text', preview: preview(msg.data) });
      this.core.broadcast(msg, peerId);
    } else if (msg.kind === 'image' && typeof msg.data === 'string' && (s.clipboardImages || msg.force)) {
      const png = Buffer.from(msg.data, 'base64');
      if (png.length > MAX_IMAGE) return;
      const h = hash(png);
      if (h === this.lastHash) return;
      this.lastHash = h;
      await this.cb.writeImagePng(png);
      this.record({ ts: Date.now(), dir: 'in', peer: this.peerName(peerId), kind: 'image', preview: `image (${Math.round(png.length / 1024)} KB)` });
      this.core.broadcast(msg, peerId);
    }
  }
}

function preview(t: string): string {
  const one = t.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? one.slice(0, 80) + '…' : one;
}
