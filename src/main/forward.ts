import * as crypto from 'crypto';
import * as net from 'net';
import type { Core } from './core';
import { BIN_FWD } from './protocol';
import type { ForwardRule } from './store';

const ORIGIN_BIT = 0x80000000;
const MAX_TUNNELS = 256;

interface RuleRuntime {
  server?: net.Server;
  error?: string;
}

/**
 * TCP port forwarding over the encrypted session, like `ssh -L`:
 * a rule listens on 127.0.0.1:<listenPort> here and connects to 127.0.0.1:<remotePort> on the peer.
 *
 * Tunnel ids are allocated by the side that opened the tunnel (the "origin"); bit 31 of the id on
 * the wire says whether the sender is the origin, so both sides can allocate ids independently.
 */
export class PortForwards {
  private runtime = new Map<string, RuleRuntime>();
  /** tunnels we opened: peerId -> cid -> local socket */
  private outbound = new Map<string, Map<number, net.Socket>>();
  /** tunnels the peer opened to us: peerId -> cid -> socket to local service */
  private inbound = new Map<string, Map<number, net.Socket>>();
  private nextCid = 1;

  constructor(private core: Core) {
    core.onJson('fwd', (peerId, msg) => this.onMessage(peerId, msg));
    core.onBin(BIN_FWD, (peerId, data) => this.onData(peerId, data));
    core.onPeerDown((peerId) => this.dropPeer(peerId));
  }

  start(): void {
    this.reconcile();
  }
  stop(): void {
    for (const r of this.runtime.values()) r.server?.close();
    this.runtime.clear();
  }

  snapshot() {
    return this.core.store.forwards.map((f) => ({
      ...f,
      peerName: this.core.store.getPeer(f.peerId)?.name ?? 'unknown',
      listening: !!this.runtime.get(f.id)?.server?.listening,
      error: this.runtime.get(f.id)?.error,
      connections: this.outbound.get(f.peerId)?.size ?? 0,
    }));
  }

  add(peerId: string, listenPort: number, remotePort: number): ForwardRule {
    const ok = (p: number) => Number.isInteger(p) && p > 0 && p < 65536;
    if (!ok(listenPort) || !ok(remotePort)) throw new Error('ports must be between 1 and 65535');
    if (!this.core.store.getPeer(peerId)) throw new Error('unknown device');
    if (this.core.store.forwards.some((f) => f.listenPort === listenPort)) throw new Error(`local port ${listenPort} is already used by another rule`);
    const rule: ForwardRule = { id: crypto.randomBytes(4).toString('hex'), peerId, listenPort, remotePort, enabled: true };
    this.core.store.setForwards([...this.core.store.forwards, rule]);
    this.reconcile();
    return rule;
  }

  remove(id: string): void {
    this.core.store.setForwards(this.core.store.forwards.filter((f) => f.id !== id));
    this.reconcile();
  }

  toggle(id: string, enabled: boolean): void {
    this.core.store.setForwards(this.core.store.forwards.map((f) => (f.id === id ? { ...f, enabled } : f)));
    this.reconcile();
  }

  /** Make the set of open listeners match the stored rules. */
  reconcile(): void {
    const rules = this.core.store.forwards;
    for (const [id, rt] of [...this.runtime]) {
      if (!rules.some((r) => r.id === id && r.enabled)) {
        rt.server?.close();
        this.runtime.delete(id);
      }
    }
    for (const rule of rules) {
      if (!rule.enabled || this.runtime.has(rule.id)) continue;
      const rt: RuleRuntime = {};
      this.runtime.set(rule.id, rt);
      const server = net.createServer((sock) => this.onLocalConnection(rule, sock));
      server.on('error', (e: any) => {
        rt.error = e.code === 'EADDRINUSE' ? `port ${rule.listenPort} is already in use` : e.message;
        this.core.changed();
      });
      server.listen(rule.listenPort, '127.0.0.1', () => {
        rt.server = server;
        this.core.changed();
      });
    }
    this.core.changed();
  }

  // ------------------------------------------------------------ origin side

  private onLocalConnection(rule: ForwardRule, sock: net.Socket): void {
    const session = this.core.sessions.get(rule.peerId);
    const tunnels = this.outbound.get(rule.peerId) ?? new Map<number, net.Socket>();
    this.outbound.set(rule.peerId, tunnels);
    if (!session || tunnels.size >= MAX_TUNNELS) return void sock.destroy();
    const cid = this.nextCid++ & 0x7fffffff;
    tunnels.set(cid, sock);
    sock.pause();
    session.sendJSON({ t: 'fwd-open', cid, port: rule.remotePort });
    sock.on('data', (d: Buffer) => {
      sock.pause();
      session.sendBin(BIN_FWD, this.pack(cid | ORIGIN_BIT, d)).then(() => sock.resume());
    });
    const end = () => {
      if (tunnels.get(cid) === sock) {
        tunnels.delete(cid);
        session.sendJSON({ t: 'fwd-close', cid, o: true });
      }
      sock.destroy();
    };
    sock.on('close', end);
    sock.on('error', end);
    this.core.changed();
  }

  // ------------------------------------------------------------ both sides

  private onMessage(peerId: string, msg: any): void {
    const session = this.core.sessions.get(peerId);
    if (!session) return;
    const cid = Number(msg.cid);
    if (msg.t === 'fwd-open') {
      const tunnels = this.inbound.get(peerId) ?? new Map<number, net.Socket>();
      this.inbound.set(peerId, tunnels);
      const port = Number(msg.port);
      if (!this.core.store.settings.allowForwarding) return session.sendJSON({ t: 'fwd-err', cid, error: 'port forwarding is turned off on that device' });
      if (!Number.isInteger(port) || port < 1 || port > 65535 || tunnels.size >= MAX_TUNNELS) return session.sendJSON({ t: 'fwd-err', cid, error: 'refused' });
      const target = net.connect({ host: '127.0.0.1', port });
      tunnels.set(cid, target);
      target.once('connect', () => {
        session.sendJSON({ t: 'fwd-ok', cid });
        target.on('data', (d: Buffer) => {
          target.pause();
          session.sendBin(BIN_FWD, this.pack(cid, d)).then(() => target.resume());
        });
      });
      const end = (e?: Error) => {
        if (tunnels.get(cid) === target) {
          tunnels.delete(cid);
          if (e && !target.connecting && (e as any).code === 'ECONNREFUSED') session.sendJSON({ t: 'fwd-err', cid, error: `nothing is listening on port ${port}` });
          else session.sendJSON({ t: 'fwd-close', cid, o: false });
        }
        target.destroy();
      };
      target.on('close', () => end());
      target.on('error', (e) => end(e));
    } else if (msg.t === 'fwd-ok') {
      this.outbound.get(peerId)?.get(cid)?.resume();
    } else if (msg.t === 'fwd-err') {
      const s = this.outbound.get(peerId)?.get(cid);
      this.outbound.get(peerId)?.delete(cid);
      s?.destroy();
    } else if (msg.t === 'fwd-close') {
      // msg.o: sender is the origin of the tunnel, so it is one of our inbound tunnels
      const map = msg.o ? this.inbound.get(peerId) : this.outbound.get(peerId);
      const s = map?.get(cid);
      map?.delete(cid);
      s?.end();
      setTimeout(() => s?.destroy(), 1000);
    }
  }

  private onData(peerId: string, data: Buffer): void {
    if (data.length < 4) return;
    const raw = data.readUInt32BE(0);
    const fromOrigin = (raw & ORIGIN_BIT) !== 0;
    const cid = raw & 0x7fffffff;
    const sock = (fromOrigin ? this.inbound : this.outbound).get(peerId)?.get(cid);
    sock?.write(data.subarray(4));
  }

  private pack(cid: number, d: Buffer): Buffer {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(cid >>> 0, 0);
    return Buffer.concat([head, d]);
  }

  private dropPeer(peerId: string): void {
    for (const m of [this.outbound.get(peerId), this.inbound.get(peerId)]) {
      for (const s of m?.values() ?? []) s.destroy();
      m?.clear();
    }
  }
}
