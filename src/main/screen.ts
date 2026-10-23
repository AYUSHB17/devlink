import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import type { Core } from './core';
import type { Session } from './protocol';

const MAX_SIGNAL = 64 * 1024;
const MAX_SHARES = 3;
const SID = /^[0-9a-f]{12}$/;

interface Stream {
  sid: string;
  peerId: string;
  role: 'viewer' | 'sharer';
  state: 'waiting' | 'live';
}

/**
 * Live screen view between paired devices. This class is the policy and the signalling relay; the
 * capture and video (WebRTC, inside Electron windows) live in screen-windows.ts.
 *
 * - The machine being viewed must have "Allow paired devices to view this screen" on, and the local user
 *   approves each connection (in memory only; asked again after a reconnect or restart).
 * - WebRTC offers/answers/ICE travel only over the authenticated DevLink session, so the DTLS fingerprints
 *   in the SDP can't be swapped by anyone else on the network.
 *
 * Events: 'view-open' (sid, peerName), 'share-start' (sid, peerId), 'signal' (sid, data), 'stopped' (sid, reason).
 */
export class ScreenShare extends EventEmitter {
  private streams = new Map<string, Stream>();
  private consent = new Map<string, { session: Session; ok: boolean }>();
  private prompt: { peerId: string; session: Session; sids: string[] } | null = null;
  /** reasons why sharing can't work here right now (e.g. macOS Screen Recording permission) */
  canShare: () => string | null = () => null;

  constructor(private core: Core) {
    super();
    core.onJson('screen', (peerId, msg) => this.onMessage(peerId, msg));
    core.onPeerDown((peerId) => {
      this.consent.delete(peerId);
      if (this.prompt?.peerId === peerId) this.prompt = null;
      for (const s of [...this.streams.values()]) if (s.peerId === peerId) this.end(s.sid, 'connection lost', false);
      this.core.changed();
    });
  }

  private peerName(id: string): string {
    return this.core.store.getPeer(id)?.name ?? 'device';
  }

  /** Viewer side: ask `peerId` to show its screen. */
  request(peerId: string): string {
    if (!this.core.sessions.has(peerId)) throw new Error('that device is offline');
    const sid = crypto.randomBytes(6).toString('hex');
    this.streams.set(sid, { sid, peerId, role: 'viewer', state: 'waiting' });
    this.core.send(peerId, { t: 'screen-req', sid });
    this.emit('view-open', sid, this.peerName(peerId));
    this.core.changed();
    return sid;
  }

  /** Either side: stop one stream (window closed, Stop pressed). */
  stop(sid: string): void {
    this.end(sid, '', true);
  }

  private end(sid: string, reason: string, tellPeer: boolean): void {
    const s = this.streams.get(sid);
    if (!s) return;
    this.streams.delete(sid);
    if (tellPeer) this.core.send(s.peerId, { t: 'screen-stop', sid });
    this.emit('stopped', sid, reason);
    this.core.changed();
  }

  /** Data from a local capture/viewer window for the other side. */
  relay(sid: string, data: unknown): void {
    const s = this.streams.get(sid);
    if (!s) return;
    const json = JSON.stringify(data ?? null);
    if (json.length > MAX_SIGNAL) return;
    this.core.send(s.peerId, { t: 'screen-sig', sid, data: JSON.parse(json) });
  }

  /** Mark a stream live once video flows (for the UI and the sharing banner). */
  setLive(sid: string): void {
    const s = this.streams.get(sid);
    if (s && s.state !== 'live') {
      s.state = 'live';
      this.core.changed();
    }
  }

  answerConsent(ok: boolean): void {
    const p = this.prompt;
    if (!p) return;
    // while another device drives this machine, a click on "Allow" could be theirs
    if (this.core.input.mode.mode === 'following') return;
    this.prompt = null;
    if (p.session === this.core.sessions.get(p.peerId)) {
      this.consent.set(p.peerId, { session: p.session, ok });
      for (const sid of p.sids) (ok ? this.startSharing(p.peerId, sid) : this.core.send(p.peerId, { t: 'screen-deny', sid, reason: 'declined on that device' }));
    }
    this.core.changed();
  }

  /** Call after allowScreenView is switched off: ends everything being shared. */
  settingsChanged(): void {
    if (this.core.store.settings.allowScreenView) return;
    for (const s of [...this.streams.values()]) if (s.role === 'sharer') this.end(s.sid, 'screen sharing was turned off', true);
    this.prompt = null;
    this.core.changed();
  }

  private hasConsent(peerId: string): 'yes' | 'no' | 'unknown' {
    const c = this.consent.get(peerId);
    if (!c || c.session !== this.core.sessions.get(peerId)) return 'unknown';
    return c.ok ? 'yes' : 'no';
  }

  private startSharing(peerId: string, sid: string): void {
    if (!this.core.sessions.has(peerId)) return;
    this.streams.set(sid, { sid, peerId, role: 'sharer', state: 'waiting' });
    this.core.send(peerId, { t: 'screen-ok', sid });
    this.emit('share-start', sid, peerId);
    this.core.changed();
  }

  private onMessage(peerId: string, msg: any): void {
    const sid = typeof msg.sid === 'string' && SID.test(msg.sid) ? msg.sid : null;
    if (!sid) return;
    const s = this.streams.get(sid);
    switch (msg.t) {
      case 'screen-req': {
        const deny = (reason: string) => void this.core.send(peerId, { t: 'screen-deny', sid, reason });
        if (this.streams.has(sid)) return;
        if (!this.core.store.settings.allowScreenView) return deny('screen viewing is turned off on that device');
        const blocked = this.canShare();
        if (blocked) return deny(blocked);
        if ([...this.streams.values()].filter((x) => x.role === 'sharer').length >= MAX_SHARES) return deny('that device is already sharing its screen');
        const c = this.hasConsent(peerId);
        if (c === 'no') return deny('declined on that device');
        if (c === 'yes') return this.startSharing(peerId, sid);
        const session = this.core.sessions.get(peerId);
        if (!session) return;
        if (this.prompt && this.prompt.peerId !== peerId) return deny('that device is answering another request');
        if (this.prompt) this.prompt.sids.push(sid);
        else {
          this.prompt = { peerId, session, sids: [sid] };
          this.emit('consent', this.peerName(peerId));
        }
        this.core.changed();
        break;
      }
      case 'screen-ok':
        if (s?.role === 'viewer' && s.peerId === peerId) this.core.changed();
        break;
      case 'screen-deny':
        if (s?.role === 'viewer' && s.peerId === peerId) this.end(sid, String(msg.reason ?? 'refused').slice(0, 200), false);
        break;
      case 'screen-sig':
        if (s && s.peerId === peerId) this.emit('signal', sid, msg.data);
        break;
      case 'screen-stop':
        if (s && s.peerId === peerId) this.end(sid, s.role === 'viewer' ? 'the other device stopped sharing' : '', false);
        break;
    }
  }

  snapshot() {
    const list = [...this.streams.values()];
    return {
      sharingTo: list.filter((s) => s.role === 'sharer').map((s) => ({ sid: s.sid, peer: this.peerName(s.peerId), live: s.state === 'live' })),
      viewing: list.filter((s) => s.role === 'viewer').map((s) => ({ sid: s.sid, peer: this.peerName(s.peerId), live: s.state === 'live' })),
      prompt: this.prompt ? { name: this.peerName(this.prompt.peerId) } : null,
    };
  }

  isSharing(): string | null {
    for (const s of this.streams.values()) if (s.role === 'sharer') return this.peerName(s.peerId);
    return null;
  }

  stopAll(): void {
    for (const sid of [...this.streams.keys()]) this.end(sid, '', true);
  }
}
