import * as net from 'net';
import * as os from 'os';
import { EventEmitter } from 'events';
import { ClipboardAdapter, ClipboardSync } from './clipboard';
import { Discovery, DiscoveredDevice } from './discovery';
import { FileTransfers } from './files';
import { PortForwards } from './forward';
import { RemoteFs } from './remotefs';
import { Jobs } from './jobs';
import { InputBackend, InputShare } from './input';
import { BrowserBridge } from './browser-bridge';
import { LinkShare } from './links';
import { ScreenShare } from './screen';
import { fingerprint, handshake, HandshakeCtx, PeerHello, Session } from './protocol';
import { SecretBox, Settings, Store } from './store';
import { StatusReporter } from './status';

export interface CoreOptions {
  dir: string;
  clipboard: ClipboardAdapter;
  secretBox?: SecretBox;
  defaults?: Partial<Settings>;
  /** advertise / browse via mDNS */
  discovery?: boolean;
  /** native input helper for shared mouse & keyboard (absent in tests) */
  inputBackend?: InputBackend;
  log?: (msg: string) => void;
  /** opens a received web link in the default browser (absent in tests) */
  openUrl?: (url: string) => unknown;
}

export interface PairPrompt {
  sas: string;
  peer: { id: string; name: string; os: string; fingerprint: string };
}

type JsonHandler = (peerId: string, msg: any, session: Session) => void;
type BinHandler = (peerId: string, data: Buffer, session: Session) => void;

const platformName = () => (process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform);

export class Core extends EventEmitter {
  readonly store: Store;
  readonly sessions = new Map<string, Session>();
  readonly clipboard: ClipboardSync;
  readonly files: FileTransfers;
  readonly forwards: PortForwards;
  readonly status: StatusReporter;
  readonly input: InputShare;
  readonly links: LinkShare;
  readonly screen: ScreenShare;
  readonly bridge: BrowserBridge;
  readonly remotefs: RemoteFs;
  readonly jobs: Jobs;
  private discovery?: Discovery;
  private discovered = new Map<string, DiscoveredDevice>();
  private server?: net.Server;
  private dialing = new Set<string>();
  private dialTimer?: NodeJS.Timeout;
  private jsonHandlers = new Map<string, JsonHandler>();
  private binHandlers = new Map<number, BinHandler>();
  private upHandlers: ((peerId: string, s: Session) => void)[] = [];
  private downHandlers: ((peerId: string) => void)[] = [];
  private pairingUntil = 0;
  private pairingAttempts = 0;
  private pairPrompt: { prompt: PairPrompt; resolve: (ok: boolean) => void } | null = null;
  private lastError = '';
  listenPort = 0;
  readonly log: (msg: string) => void;

  constructor(private opts: CoreOptions) {
    super();
    this.log = opts.log ?? (() => undefined);
    this.store = new Store(opts.dir, opts.secretBox, opts.defaults);
    this.clipboard = new ClipboardSync(this, opts.clipboard);
    this.files = new FileTransfers(this);
    this.forwards = new PortForwards(this);
    this.status = new StatusReporter(this);
    this.input = new InputShare(this, opts.inputBackend ?? null);
    this.links = new LinkShare(this, opts.openUrl ?? (() => undefined));
    this.screen = new ScreenShare(this);
    this.bridge = new BrowserBridge(this);
    this.remotefs = new RemoteFs(this);
    this.jobs = new Jobs(this);
  }

  get id(): string {
    return this.store.identity.id;
  }

  // ------------------------------------------------------------ plumbing for features

  onJson(prefix: string, fn: JsonHandler): void {
    this.jsonHandlers.set(prefix, fn);
  }
  onBin(kind: number, fn: BinHandler): void {
    this.binHandlers.set(kind, fn);
  }
  onPeerUp(fn: (peerId: string, s: Session) => void): void {
    this.upHandlers.push(fn);
  }
  onPeerDown(fn: (peerId: string) => void): void {
    this.downHandlers.push(fn);
  }

  send(peerId: string, msg: unknown): boolean {
    const s = this.sessions.get(peerId);
    if (!s) return false;
    s.sendJSON(msg);
    return true;
  }
  broadcast(msg: unknown, except?: string): void {
    for (const [id, s] of this.sessions) if (id !== except) s.sendJSON(msg);
  }

  changed(): void {
    this.emit('changed');
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    this.server = net.createServer((sock) => void this.onIncoming(sock));
    this.listenPort = await this.listen(this.store.settings.listenPort);
    this.log(`listening on ${this.listenPort}`);
    if (this.opts.discovery !== false) {
      this.discovery = new Discovery(this.id, this.log);
      this.discovery.on('change', (list: DiscoveredDevice[]) => {
        this.discovered = new Map(list.map((d) => [d.id, d]));
        // remember where paired peers currently live
        for (const d of list) {
          const p = this.store.getPeer(d.id);
          if (p && (p.lastHost !== d.host || p.lastPort !== d.port)) this.store.putPeer({ ...p, lastHost: d.host, lastPort: d.port });
        }
        this.changed();
      });
      this.discovery.start(this.store.settings.deviceName, this.listenPort);
    }
    this.clipboard.start();
    this.forwards.start();
    this.status.start();
    await this.bridge.reconcile();
    this.dialTimer = setInterval(() => this.dialAll(), 4000);
    setTimeout(() => this.dialAll(), 500);
  }

  private listen(port: number): Promise<number> {
    const srv = this.server!;
    return new Promise((resolve, reject) => {
      const attempt = (p: number) => {
        srv.once('error', (e: NodeJS.ErrnoException) => {
          if (e.code === 'EADDRINUSE' && p !== 0) attempt(0);
          else reject(e);
        });
        srv.listen(p, '0.0.0.0', () => resolve((srv.address() as net.AddressInfo).port));
      };
      attempt(port);
    });
  }

  async stop(): Promise<void> {
    if (this.dialTimer) clearInterval(this.dialTimer);
    this.clipboard.stop();
    this.status.stop();
    this.input.stop();
    this.screen.stopAll();
    this.bridge.stop();
    this.jobs.stopAll();
    this.forwards.stop();
    this.discovery?.stop();
    for (const s of [...this.sessions.values()]) s.close();
    this.server?.close();
  }

  // ------------------------------------------------------------ connections

  private ctx(extra: Partial<HandshakeCtx> = {}): HandshakeCtx {
    return {
      identity: this.store.identity,
      deviceName: this.store.settings.deviceName,
      os: platformName(),
      listenPort: this.listenPort,
      allowPairing: () => this.pairingEnabled(),
      isKnown: (id) => !!this.store.getPeer(id),
      confirmPair: (sas, peer) => this.askPair(sas, peer),
      ...extra,
    };
  }

  private async onIncoming(sock: net.Socket): Promise<void> {
    sock.setNoDelay(true);
    try {
      const r = await handshake(sock, 'responder', this.ctx());
      const host = (sock.remoteAddress ?? '').replace(/^::ffff:/, '');
      if (r.newlyPaired) this.recordPairing(r.peer, host, r.peer.port);
      this.adopt(r.session);
    } catch (e: any) {
      this.log(`incoming rejected: ${e.reason ?? e.message}`);
      if (e.reason && e.reason !== 'timeout') this.noteFail(e.reason);
    }
  }

  private noteFail(reason: string): void {
    if (this.pairingEnabled() && (reason === 'pair-declined' || reason === 'commit-mismatch' || reason === 'auth-failed')) {
      if (++this.pairingAttempts >= 3) this.stopPairing();
    }
  }

  private recordPairing(peer: PeerHello, host: string, port: number): void {
    this.store.putPeer({
      id: peer.id,
      pub: peer.pub,
      name: peer.name,
      os: peer.os,
      lastHost: host,
      lastPort: port || undefined,
      pairedAt: Date.now(),
    });
    this.stopPairing();
  }

  private connect(host: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('connect timeout'));
      }, 5000);
      sock.once('connect', () => {
        clearTimeout(timer);
        sock.setNoDelay(true);
        resolve(sock);
      });
      sock.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  /** Initiator side of pairing: dial a device that has "Allow pairing" switched on. */
  async pairWith(host: string, port: number): Promise<PeerHello> {
    const sock = await this.connect(host, port);
    const r = await handshake(sock, 'initiator', this.ctx({ mode: 'pair' }));
    this.recordPairing(r.peer, host, port);
    this.adopt(r.session);
    return r.peer;
  }

  private dialAll(): void {
    for (const p of this.store.peers) {
      if (this.sessions.has(p.id) || this.dialing.has(p.id)) continue;
      const d = this.discovered.get(p.id);
      const host = d?.host ?? p.lastHost;
      const port = d?.port ?? p.lastPort;
      if (!host || !port) continue;
      this.dialing.add(p.id);
      setTimeout(async () => {
        try {
          if (this.sessions.has(p.id) || !this.store.getPeer(p.id)) return;
          const sock = await this.connect(host, port);
          const r = await handshake(sock, 'initiator', this.ctx({ mode: 'normal', expectId: p.id }));
          this.adopt(r.session);
        } catch (e: any) {
          this.lastError = `${p.name}: ${e.reason ?? e.message}`;
        } finally {
          this.dialing.delete(p.id);
          this.changed();
        }
      }, Math.random() * 1500);
    }
  }

  /** Register an authenticated session. Both ends apply the same tie-break when two exist. */
  adopt(session: Session): void {
    const peerId = session.peer.id;
    if (!this.store.getPeer(peerId)) {
      // e.g. an in-flight dial that raced with unpairing
      session.close();
      return;
    }
    const preferred = [this.id, peerId].sort()[0];
    const initOf = (s: Session) => (s.initiator ? this.id : peerId);
    const old = this.sessions.get(peerId);
    if (old && !old.closed) {
      if (initOf(old) === preferred && initOf(session) !== preferred) {
        session.close();
        return;
      }
      this.sessions.delete(peerId);
      old.close();
      // the old session's close handler no longer sees itself in the map, so tell features here
      for (const fn of this.downHandlers) fn(peerId);
    }
    this.sessions.set(peerId, session);
    const rec = this.store.getPeer(peerId);
    if (rec) {
      const host = session.initiator ? rec.lastHost : session.remoteAddress || rec.lastHost;
      const port = session.initiator ? rec.lastPort : session.peer.port || rec.lastPort;
      this.store.putPeer({ ...rec, name: session.peer.name, os: session.peer.os, lastHost: host, lastPort: port });
    }
    session.on('json', (msg) => {
      const prefix = String(msg?.t ?? '').split('-')[0];
      this.jsonHandlers.get(prefix)?.(peerId, msg, session);
    });
    session.on('bin', (kind, data) => this.binHandlers.get(kind)?.(peerId, data, session));
    session.on('close', () => {
      if (this.sessions.get(peerId) === session) {
        this.sessions.delete(peerId);
        for (const fn of this.downHandlers) fn(peerId);
      }
      this.changed();
    });
    session.start();
    this.log(`connected to ${session.peer.name}`);
    for (const fn of this.upHandlers) fn(peerId, session);
    this.changed();
  }

  // ------------------------------------------------------------ pairing UI plumbing

  pairingEnabled(): boolean {
    return Date.now() < this.pairingUntil;
  }
  startPairing(seconds = 120): void {
    this.pairingUntil = Date.now() + seconds * 1000;
    this.pairingAttempts = 0;
    setTimeout(() => this.changed(), seconds * 1000 + 50).unref();
    this.changed();
  }
  stopPairing(): void {
    this.pairingUntil = 0;
    this.changed();
  }

  private askPair(sas: string, peer: PeerHello): Promise<boolean> {
    if (this.pairPrompt) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.pairPrompt = null;
        this.changed();
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), 120_000);
      timer.unref();
      this.pairPrompt = {
        prompt: { sas, peer: { id: peer.id, name: peer.name, os: peer.os, fingerprint: fingerprint(peer.id) } },
        resolve: done,
      };
      this.emit('pair-prompt', this.pairPrompt.prompt);
      this.changed();
    });
  }
  answerPair(ok: boolean): void {
    this.pairPrompt?.resolve(ok);
  }

  unpair(peerId: string): void {
    this.store.removePeer(peerId);
    this.sessions.get(peerId)?.close();
    this.forwards.reconcile();
    this.changed();
  }

  // ------------------------------------------------------------ state for the UI

  state() {
    const s = this.store.settings;
    const ips: { iface: string; address: string }[] = [];
    for (const [iface, list] of Object.entries(os.networkInterfaces()))
      for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) ips.push({ iface, address: a.address });
    return {
      self: { id: this.id, name: s.deviceName, os: platformName(), fingerprint: fingerprint(this.id), port: this.listenPort, ips },
      pairing: { enabled: this.pairingEnabled(), until: this.pairingUntil },
      pairPrompt: this.pairPrompt?.prompt ?? null,
      discovered: [...this.discovered.values()]
        .filter((d) => d.id !== this.id)
        .map((d) => ({ ...d, paired: !!this.store.getPeer(d.id) })),
      peers: this.store.peers.map((p) => ({
        id: p.id,
        name: p.name,
        os: p.os,
        fingerprint: fingerprint(p.id),
        online: this.sessions.has(p.id),
        address: p.lastHost ? `${p.lastHost}:${p.lastPort ?? '?'}` : '',
        status: this.status.get(p.id) ?? null,
      })),
      settings: s,
      forwards: this.forwards.snapshot(),
      input: this.input.snapshot(),
      links: this.links.log,
      screen: this.screen.snapshot(),
      bridge: this.bridge.snapshot(),
      remotefs: this.remotefs.snapshot(),
      jobs: this.jobs.snapshot(),
      transfers: this.files.snapshot(),
      clipboardLog: this.clipboard.log,
      shortcuts: this.store.shortcuts,
      lastError: this.lastError,
    };
  }
}
