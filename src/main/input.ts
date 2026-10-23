import { EventEmitter } from 'events';
import type { Core } from './core';
import type { Session } from './protocol';
import type { ScreenSide } from './store';

// ---------------------------------------------------------------- helper protocol (JSON lines)

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type HelperEvent =
  | { ev: 'ready'; platform: string; screens: Rect[]; accessibility: boolean; inputMonitoring: boolean }
  | { ev: 'edge'; side: ScreenSide; pos: number; buttons: number }
  | { ev: 'move'; dx: number; dy: number }
  | { ev: 'button'; b: number; down: boolean }
  | { ev: 'wheel'; dx: number; dy: number }
  | { ev: 'key'; hid: number; down: boolean }
  | { ev: 'hotkey' }
  | { ev: 'released'; reason: string }
  | { ev: 'local_activity' }
  | { ev: 'drag'; active: boolean }
  | { ev: 'error'; msg: string }
  | { ev: 'notice'; msg: string }
  | { ev: 'log'; msg: string };

export type HelperCommand =
  | { cmd: 'config'; edges: ScreenSide[]; follower: boolean }
  | { cmd: 'capture'; on: boolean }
  | { cmd: 'enter'; side: ScreenSide; pos: number }
  | { cmd: 'move'; dx: number; dy: number }
  | { cmd: 'button'; b: number; down: boolean }
  | { cmd: 'wheel'; dx: number; dy: number }
  | { cmd: 'key'; hid: number; down: boolean }
  | { cmd: 'release_all' }
  | { cmd: 'ping' }
  | { cmd: 'quit' };

/** The native helper (or a fake in tests). Emits 'event' (HelperEvent) and 'exit'. */
export interface InputBackend extends EventEmitter {
  start(): void;
  stop(): void;
  send(c: HelperCommand): void;
  readonly running: boolean;
}

// ---------------------------------------------------------------- mapping helpers

const OPPOSITE: Record<ScreenSide, ScreenSide> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
export const oppositeSide = (s: ScreenSide) => OPPOSITE[s];
const SIDES = new Set<string>(['left', 'right', 'top', 'bottom']);

// HID usages for the modifier keys
const L_CTRL = 0xe0;
const L_GUI = 0xe3;
const R_CTRL = 0xe4;
const R_GUI = 0xe7;
const SWAP: Record<number, number> = { [L_CTRL]: L_GUI, [L_GUI]: L_CTRL, [R_CTRL]: R_GUI, [R_GUI]: R_CTRL };

type WireEvent = ['m', number, number] | ['b', number, 0 | 1] | ['w', number, number] | ['k', number, 0 | 1];

type Mode = { mode: 'local' } | { mode: 'leading'; peer: string; acked: boolean } | { mode: 'following'; peer: string };

const ACK_TIMEOUT = 1500;
const MOVE_FLUSH_MS = 8;
/** both sides send a heartbeat while control is active; silence for HB_DEAD_MS releases everything */
const HB_EVERY_MS = 500;
const HB_DEAD_MS = 2000;
const MAX_EVENTS_PER_SEC = 3000;
const MAX_HELD_KEYS = 32;

/**
 * Shared mouse & keyboard. Policy lives here; the native helper only detects edges, captures and injects.
 * See docs/INPUT_SHARING.md for the state machine.
 */
export class InputShare extends EventEmitter {
  private m: Mode = { mode: 'local' };
  private peerAllows = new Map<string, boolean>();
  private pendingMove: [number, number] = [0, 0];
  private moveTimer?: NodeJS.Timeout;
  private ackTimer?: NodeJS.Timeout;
  private frac: [number, number] = [0, 0];
  private helperInfo: Extract<HelperEvent, { ev: 'ready' }> | null = null;
  private helperError = '';
  private dragging = false;
  /** per-connection consent to be controlled; a new connection (or restart) asks again */
  private consent = new Map<string, { session: Session; ok: boolean }>();
  private consentPrompt: { peerId: string; session: Session } | null = null;
  /** layouts proposed by peers; only applied when the local user accepts */
  private layoutSuggestions = new Map<string, ScreenSide | null>();
  private hbTimer?: NodeJS.Timeout;
  private lastHb = 0;
  private rate = { windowStart: 0, n: 0 };
  private heldKeys = new Set<number>();
  notice = '';

  constructor(private core: Core, private backend: InputBackend | null) {
    super();
    core.onJson('input', (peerId, msg) => this.onMessage(peerId, msg));
    core.onPeerUp((peerId) => {
      if (this.m.mode !== 'local' && this.m.peer === peerId) this.release('', true);
      this.sendHello(peerId);
      this.reconfigure();
    });
    core.onPeerDown((peerId) => {
      this.peerAllows.delete(peerId);
      this.consent.delete(peerId);
      if (this.consentPrompt?.peerId === peerId) this.consentPrompt = null;
      if (this.m.mode !== 'local' && this.m.peer === peerId) this.release('connection lost', false);
      this.reconfigure();
    });
    backend?.on('event', (e: HelperEvent) => this.onHelper(e));
    backend?.on('exit', (why: string) => {
      this.helperError = why;
      if (this.m.mode !== 'local') this.release('helper stopped', true);
      this.core.changed();
    });
  }

  get mode(): Mode {
    return this.m;
  }

  private get settings() {
    return this.core.store.settings;
  }

  /** Start/stop/configure the helper after settings, layout or connections change. */
  reconfigure(): void {
    if (!this.backend) return;
    const s = this.settings;
    const wanted = s.inputSharing || s.allowRemoteInput || s.edgeDrop;
    const sides = this.onlineSides();
    if (!wanted || !sides.length) {
      if (this.m.mode !== 'local') this.release('disabled', true);
      if (this.backend.running) this.backend.stop();
      return;
    }
    if (!this.backend.running) this.backend.start();
    this.backend.send({ cmd: 'config', edges: sides, follower: this.m.mode === 'following' });
  }

  private onlineSides(): ScreenSide[] {
    const out = new Set<ScreenSide>();
    for (const [peerId, side] of Object.entries(this.settings.inputLayout ?? {}))
      if (this.core.sessions.has(peerId) && SIDES.has(side)) out.add(side);
    return [...out];
  }

  private peerOnSide(side: ScreenSide): string | undefined {
    for (const [peerId, s] of Object.entries(this.settings.inputLayout ?? {}))
      if (s === side && this.core.sessions.has(peerId)) return peerId;
    return undefined;
  }

  /** Put `peerId` on `side` of this machine, and tell the peer so it stores the mirror image. */
  setLayout(peerId: string, side: ScreenSide | null): void {
    this.layoutSuggestions.delete(peerId);
    const layout = { ...(this.settings.inputLayout ?? {}) };
    // one peer per side
    for (const [id, s] of Object.entries(layout)) if (side && s === side && id !== peerId) delete layout[id];
    if (side) layout[peerId] = side;
    else delete layout[peerId];
    this.core.store.updateSettings({ inputLayout: layout });
    this.core.send(peerId, { t: 'input-layout', side: side ? oppositeSide(side) : null });
    this.reconfigure();
    this.core.changed();
  }

  /** Call after allowRemoteInput changes. */
  announce(): void {
    for (const id of this.core.sessions.keys()) this.sendHello(id);
    if (!this.settings.allowRemoteInput && this.m.mode === 'following') this.release('control turned off', true);
    this.reconfigure();
  }

  private sendHello(peerId: string): void {
    this.core.send(peerId, { t: 'input-hello', allow: !!this.settings.allowRemoteInput });
  }

  private setNotice(msg: string): void {
    this.notice = msg;
    this.emit('notice', msg);
    this.core.changed();
  }

  private startHeartbeat(): void {
    this.lastHb = Date.now();
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => {
      if (this.m.mode === 'local') return this.stopHeartbeat();
      this.core.send(this.m.peer, { t: 'input-hb' });
      // network silently gone (cable, Wi-Fi): don't wait for the session's 35 s timeout
      if (Date.now() - this.lastHb > HB_DEAD_MS) this.release('lost contact with the other device', true);
    }, HB_EVERY_MS);
  }
  private stopHeartbeat(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = undefined;
  }

  private hasConsent(peerId: string): boolean {
    const c = this.consent.get(peerId);
    return !!c && c.ok && c.session === this.core.sessions.get(peerId);
  }

  /** The local user's answer to "Allow <peer> to control this machine?" (must come from this machine's UI). */
  answerConsent(ok: boolean): void {
    const p = this.consentPrompt;
    if (!p) return;
    // while someone is driving this machine, a click could be theirs, not the local user's
    if (this.m.mode === 'following') return;
    this.consentPrompt = null;
    if (p.session === this.core.sessions.get(p.peerId)) {
      this.consent.set(p.peerId, { session: p.session, ok });
      this.core.send(p.peerId, { t: 'input-consent', ok });
    }
    this.core.changed();
  }

  // ------------------------------------------------------------ helper events

  private onHelper(e: HelperEvent): void {
    switch (e.ev) {
      case 'ready':
        this.helperInfo = e;
        this.helperError = '';
        this.core.changed();
        break;
      case 'error':
        this.helperError = e.msg;
        this.core.log(`input helper: ${e.msg}`);
        this.core.changed();
        break;
      case 'log':
        this.core.log(`input helper: ${e.msg}`);
        break;
      case 'notice':
        this.setNotice(String(e.msg).slice(0, 300));
        break;
      case 'edge':
        this.onEdge(e.side, e.pos, e.buttons);
        break;
      case 'drag':
        this.dragging = e.active;
        this.emit('drag', e.active);
        break;
      case 'move':
        if (this.m.mode === 'leading') {
          this.pendingMove[0] += e.dx;
          this.pendingMove[1] += e.dy;
          if (!this.moveTimer) this.moveTimer = setTimeout(() => this.flushMoves(), MOVE_FLUSH_MS);
        }
        break;
      case 'button':
        this.forward(['b', e.b, e.down ? 1 : 0]);
        break;
      case 'wheel':
        this.forward(['w', e.dx, e.dy]);
        break;
      case 'key':
        this.forward(['k', e.hid, e.down ? 1 : 0]);
        break;
      case 'hotkey':
        if (this.m.mode === 'leading') {
          this.core.send(this.m.peer, { t: 'input-release' });
          this.release('released with hotkey', false);
        }
        break;
      case 'released':
        // the helper's watchdog already let go locally; bring the protocol state in line
        if (this.m.mode === 'leading') {
          this.core.send(this.m.peer, { t: 'input-release' });
          this.release(String(e.reason ?? 'released').slice(0, 300), false);
        } else if (this.m.mode === 'following') {
          this.core.send(this.m.peer, { t: 'input-takeback' });
          this.release(String(e.reason ?? 'released').slice(0, 300), true);
        }
        break;
      case 'local_activity':
        if (this.m.mode === 'following') {
          this.core.send(this.m.peer, { t: 'input-takeback' });
          this.release('', true);
        }
        break;
    }
  }

  private onEdge(side: ScreenSide, pos: number, buttons: number): void {
    pos = clamp01(pos);
    if (this.m.mode === 'local') {
      if (buttons) return; // never cross mid-drag; the edge drop strip handles that
      const peer = this.peerOnSide(side);
      if (!peer || !this.settings.inputSharing) return;
      if (this.peerAllows.get(peer) !== true) {
        this.setNotice(`${this.peerName(peer)} doesn't allow remote control (turn it on in its Settings)`);
        return;
      }
      this.notice = ''; // a message about the previous session must not linger beside the new one
      this.m = { mode: 'leading', peer, acked: false };
      this.startHeartbeat();
      this.backend?.send({ cmd: 'capture', on: true });
      this.core.send(peer, { t: 'input-enter', pos });
      this.ackTimer = setTimeout(() => {
        if (this.m.mode === 'leading' && this.m.peer === peer && !this.m.acked) this.release(`${this.peerName(peer)} didn't respond`, false);
      }, ACK_TIMEOUT);
      this.core.changed();
    } else if (this.m.mode === 'following') {
      const leader = this.m.peer;
      if (this.settings.inputLayout?.[leader] !== side) return;
      this.core.send(leader, { t: 'input-leave', pos });
      this.backend?.send({ cmd: 'release_all' });
      this.m = { mode: 'local' };
      this.stopHeartbeat();
      this.heldKeys.clear();
      this.reconfigure();
      if (this.settings.clipboardOnCross) void this.core.clipboard.pushNow(leader, 'cross').catch(() => undefined);
      this.core.changed();
    }
  }

  private flushMoves(): void {
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = undefined;
    const [dx, dy] = this.pendingMove;
    this.pendingMove = [0, 0];
    if ((dx || dy) && this.m.mode === 'leading') this.core.send(this.m.peer, { t: 'input-ev', e: [['m', dx, dy]] });
  }

  private forward(ev: WireEvent): void {
    if (this.m.mode !== 'leading') return;
    this.flushMoves();
    this.core.send(this.m.peer, { t: 'input-ev', e: [ev] });
  }

  /** Return to `local`. `releaseKeys` lets go of anything we injected (follower side). */
  private release(reason: string, releaseKeys: boolean): void {
    const was = this.m;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.flushMoves();
    if (was.mode === 'leading') this.backend?.send({ cmd: 'capture', on: false });
    if (was.mode === 'following' || releaseKeys) this.backend?.send({ cmd: 'release_all' });
    this.m = { mode: 'local' };
    this.stopHeartbeat();
    this.heldKeys.clear();
    if (reason) this.setNotice(reason);
    this.reconfigure();
    this.core.changed();
  }

  // ------------------------------------------------------------ peer messages

  private onMessage(peerId: string, msg: any): void {
    switch (msg.t) {
      case 'input-hello':
        this.peerAllows.set(peerId, msg.allow === true);
        this.core.changed();
        break;
      case 'input-layout': {
        const side = msg.side === null ? null : SIDES.has(msg.side) ? (msg.side as ScreenSide) : undefined;
        if (side === undefined) return;
        const current = this.settings.inputLayout?.[peerId] ?? null;
        if (side === current) {
          this.layoutSuggestions.delete(peerId);
        } else if (side === null) {
          // removing the shared edge only ever reduces what the peer can do: apply it
          const layout = { ...(this.settings.inputLayout ?? {}) };
          delete layout[peerId];
          this.core.store.updateSettings({ inputLayout: layout });
          this.layoutSuggestions.delete(peerId);
          this.reconfigure();
        } else {
          // A peer must not be able to point one of our screen edges at itself (that would route our
          // keystrokes to it on an accidental edge push), so a new side is only a suggestion.
          this.layoutSuggestions.set(peerId, side);
        }
        this.core.changed();
        break;
      }
      case 'input-enter': {
        const deny = (reason: string): void => void this.core.send(peerId, { t: 'input-deny', reason });
        if (!this.settings.allowRemoteInput) return deny('remote control is turned off on that device');
        if (this.m.mode !== 'local') return deny('that device is busy');
        const side = this.settings.inputLayout?.[peerId];
        if (!side) return deny('screen layout is not set on that device');
        if (!this.backend?.running) return deny('input helper is not running on that device');
        if (!this.hasConsent(peerId)) {
          const c = this.consent.get(peerId);
          if (c && !c.ok && c.session === this.core.sessions.get(peerId)) return deny('control was declined on that device');
          const session = this.core.sessions.get(peerId);
          if (session && !this.consentPrompt) {
            this.consentPrompt = { peerId, session };
            this.emit('consent', this.peerName(peerId));
            this.core.changed();
          }
          return deny('waiting for approval on that device – click Allow there, then move the cursor across again');
        }
        this.notice = '';
        this.m = { mode: 'following', peer: peerId };
        this.startHeartbeat();
        this.rate = { windowStart: Date.now(), n: 0 };
        this.frac = [0, 0];
        this.backend.send({ cmd: 'config', edges: this.onlineSides(), follower: true });
        this.backend.send({ cmd: 'enter', side, pos: clamp01(Number(msg.pos)) });
        this.core.send(peerId, { t: 'input-ack' });
        this.core.changed();
        break;
      }
      case 'input-hb':
        if (this.m.mode !== 'local' && this.m.peer === peerId) this.lastHb = Date.now();
        break;
      case 'input-consent':
        if (msg.ok === true) this.setNotice(`${this.peerName(peerId)} allowed control – move the cursor across again`);
        else this.setNotice(`${this.peerName(peerId)} declined control for this connection`);
        break;
      case 'input-ack':
        if (this.m.mode === 'leading' && this.m.peer === peerId) {
          this.m.acked = true;
          if (this.ackTimer) clearTimeout(this.ackTimer);
          // only once the peer has accepted control, never before consent
          if (this.settings.clipboardOnCross) void this.core.clipboard.pushNow(peerId, 'cross').catch(() => undefined);
        }
        break;
      case 'input-deny':
        if (this.m.mode === 'leading' && this.m.peer === peerId) this.release(String(msg.reason ?? 'refused').slice(0, 200), false);
        break;
      case 'input-ev':
        if (this.m.mode === 'following' && this.m.peer === peerId && this.hasConsent(peerId) && Array.isArray(msg.e)) {
          this.lastHb = Date.now();
          for (const ev of msg.e.slice(0, 256)) if (this.underRate()) this.inject(peerId, ev);
        }
        break;
      case 'input-leave':
        if (this.m.mode === 'leading' && this.m.peer === peerId) {
          const side = this.settings.inputLayout?.[peerId];
          this.release('', false);
          if (side) this.backend?.send({ cmd: 'enter', side, pos: clamp01(Number(msg.pos)) });
        }
        break;
      case 'input-takeback':
        if (this.m.mode === 'leading' && this.m.peer === peerId) this.release('', false);
        break;
      case 'input-release':
        if (this.m.mode === 'following' && this.m.peer === peerId) this.release('', true);
        break;
    }
  }

  private underRate(): boolean {
    const now = Date.now();
    if (now - this.rate.windowStart >= 1000) this.rate = { windowStart: now, n: 0 };
    return ++this.rate.n <= MAX_EVENTS_PER_SEC;
  }

  private inject(peerId: string, ev: unknown): void {
    if (!Array.isArray(ev) || !this.backend) return;
    const [kind, a, b] = ev;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
    const s = this.settings;
    if (kind === 'm') {
      const scale = s.pointerScale > 0 ? s.pointerScale : 1;
      const fx = a * scale + this.frac[0];
      const fy = b * scale + this.frac[1];
      const dx = Math.trunc(fx);
      const dy = Math.trunc(fy);
      this.frac = [fx - dx, fy - dy];
      if (dx || dy) this.backend.send({ cmd: 'move', dx: clampAbs(dx, 4000), dy: clampAbs(dy, 4000) });
    } else if (kind === 'b') {
      if (Number.isInteger(a) && a >= 0 && a <= 4) this.backend.send({ cmd: 'button', b: a, down: b === 1 });
    } else if (kind === 'w') {
      const k = s.invertScroll ? -1 : 1;
      this.backend.send({ cmd: 'wheel', dx: clampAbs(a * k, 10000), dy: clampAbs(b * k, 10000) });
    } else if (kind === 'k') {
      if (!Number.isInteger(a) || a < 0x04 || a > 0xe7) return;
      const down = b === 1;
      if (down && !this.heldKeys.has(a) && this.heldKeys.size >= MAX_HELD_KEYS) return;
      if (down) this.heldKeys.add(a);
      else this.heldKeys.delete(a);
      let hid = a;
      const peerOs = this.core.store.getPeer(peerId)?.os;
      const myOs = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform;
      if (s.swapCmdCtrl && peerOs && peerOs !== myOs && SWAP[hid]) hid = SWAP[hid];
      this.backend.send({ cmd: 'key', hid, down });
    }
  }

  private peerName(id: string): string {
    return this.core.store.getPeer(id)?.name ?? 'device';
  }

  isDragging(): boolean {
    return this.dragging;
  }

  snapshot() {
    return {
      helper: {
        present: !!this.backend,
        running: !!this.backend?.running,
        error: this.helperError,
        platform: this.helperInfo?.platform ?? '',
        accessibility: this.helperInfo?.accessibility ?? false,
        inputMonitoring: this.helperInfo?.inputMonitoring ?? false,
      },
      mode: this.m.mode,
      peer: this.m.mode === 'local' ? null : this.peerName(this.m.peer),
      peerAllows: Object.fromEntries(this.peerAllows),
      notice: this.notice,
      layoutSuggestions: Object.fromEntries(this.layoutSuggestions),
      consentPrompt: this.consentPrompt ? { peerId: this.consentPrompt.peerId, name: this.peerName(this.consentPrompt.peerId) } : null,
    };
  }

  stop(): void {
    if (this.m.mode !== 'local') this.release('', true);
    this.backend?.stop();
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}
function clampAbs(n: number, max: number): number {
  return Math.max(-max, Math.min(max, Math.round(n)));
}
