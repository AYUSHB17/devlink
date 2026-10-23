import * as crypto from 'crypto';
import type { Core } from './core';

const MAX_URL = 4096;
const MAX_PER_SEND = 50;
/** a peer can't open more than this many links per minute here */
const MAX_PER_MINUTE = 60;

/** Only plain web links: no javascript:, file:, custom schemes, or embedded credentials. */
export function cleanUrl(u: unknown): string | null {
  if (typeof u !== 'string' || !u.trim() || u.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(u.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url.toString();
}

export interface LinkEntry {
  ts: number;
  dir: 'in' | 'out';
  peer: string;
  url: string;
  state: 'sent' | 'opened' | 'refused';
  note?: string;
}

/** Send browser tabs / links to a paired device, which opens them in its default browser. */
export class LinkShare {
  readonly log: LinkEntry[] = [];
  private opened: number[] = [];
  private pending = new Map<string, LinkEntry[]>();

  constructor(private core: Core, private opener: (url: string) => unknown) {
    core.onJson('link', (peerId, msg) => this.onMessage(peerId, msg));
  }

  private peerName(id: string): string {
    return this.core.store.getPeer(id)?.name ?? 'device';
  }

  private record(e: LinkEntry): void {
    this.log.unshift(e);
    this.log.length = Math.min(this.log.length, 40);
    this.core.changed();
  }

  /** Returns how many links were sent. */
  send(peerId: string, urls: unknown[]): number {
    if (!this.core.sessions.has(peerId)) throw new Error('that device is offline');
    const clean = urls.map(cleanUrl).filter((u): u is string => !!u).slice(0, MAX_PER_SEND);
    if (!clean.length) throw new Error('only web links (http/https) can be sent');
    const id = crypto.randomBytes(6).toString('hex');
    const entries = clean.map((url) => ({ ts: Date.now(), dir: 'out' as const, peer: this.peerName(peerId), url, state: 'sent' as const }));
    this.pending.set(id, entries);
    if (this.pending.size > 100) this.pending.delete(this.pending.keys().next().value!);
    for (const e of entries) this.record(e);
    this.core.send(peerId, { t: 'link-open', id, urls: clean });
    return clean.length;
  }

  private onMessage(peerId: string, msg: any): void {
    const id = typeof msg.id === 'string' && /^[0-9a-f]{1,32}$/.test(msg.id) ? msg.id : '';
    if (msg.t === 'link-open') {
      const reject = (reason: string) => this.core.send(peerId, { t: 'link-reject', id, reason });
      if (!this.core.store.settings.acceptLinks) return void reject(`opening links is turned off on ${this.core.store.settings.deviceName}`);
      if (!Array.isArray(msg.urls)) return;
      const now = Date.now();
      this.opened = this.opened.filter((t) => now - t < 60_000);
      let n = 0;
      const hosts = new Set<string>();
      for (const raw of msg.urls.slice(0, MAX_PER_SEND)) {
        const url = cleanUrl(raw);
        if (!url) continue;
        if (this.opened.length >= MAX_PER_MINUTE) {
          reject('too many links at once');
          break;
        }
        this.opened.push(now);
        this.opener(url);
        hosts.add(new URL(url).host);
        this.record({ ts: now, dir: 'in', peer: this.peerName(peerId), url, state: 'opened' });
        n++;
      }
      if (n) {
        this.core.send(peerId, { t: 'link-ok', id, n });
        this.core.emit('links-received', { peerName: this.peerName(peerId), count: n, hosts: [...hosts] });
      }
    } else if (msg.t === 'link-ok' || msg.t === 'link-reject') {
      const entries = this.pending.get(id);
      this.pending.delete(id);
      const refused = msg.t === 'link-reject';
      const note = refused ? String(msg.reason ?? 'refused').slice(0, 200) : undefined;
      for (const e of entries ?? []) {
        e.state = refused ? 'refused' : 'opened';
        e.note = note;
      }
      if (refused) this.core.emit('links-failed', { peerName: this.peerName(peerId), reason: note });
      this.core.changed();
    }
  }
}
