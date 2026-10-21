import * as crypto from 'crypto';
import * as net from 'net';
import { EventEmitter } from 'events';

export const PROTOCOL_VERSION = 1;
const MAX_FRAME = 16 * 1024 * 1024;

/** Encrypted frame payload types. 0 = JSON, everything else is a binary stream. */
export const T_JSON = 0;
export const BIN_FILE = 1;
export const BIN_FWD = 2;

const HANDSHAKE_TIMEOUT = 10_000;
const PAIR_TIMEOUT = 130_000;

// ---------------------------------------------------------------- identity

export interface Identity {
  id: string;
  /** Ed25519 public key, SPKI DER, base64 */
  pub: string;
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
}

export function generateIdentity(): { pub: string; priv: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

export function idOfPub(pubB64: string): string {
  return crypto.createHash('sha256').update(Buffer.from(pubB64, 'base64')).digest('hex');
}

export function loadIdentity(pub: string, priv: string): Identity {
  return {
    id: idOfPub(pub),
    pub,
    publicKey: crypto.createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' }),
    privateKey: crypto.createPrivateKey({ key: Buffer.from(priv, 'base64'), format: 'der', type: 'pkcs8' }),
  };
}

/** Human-comparable fingerprint, e.g. "A1B2 C3D4 E5F6 0718" */
export function fingerprint(id: string): string {
  return (id.slice(0, 16).toUpperCase().match(/.{4}/g) ?? []).join(' ');
}

// ---------------------------------------------------------------- framing

/** Length-prefixed frame reader/writer. Pull-style during the handshake, push-style afterwards. */
export class FrameStream extends EventEmitter {
  private buffered: Buffer = Buffer.alloc(0);
  private queue: Buffer[] = [];
  private waiter: { resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private error: Error | null = null;
  private handler: ((b: Buffer) => void) | null = null;

  constructor(readonly socket: net.Socket) {
    super();
    socket.on('data', (d: Buffer) => this.onData(d));
    socket.on('error', (e) => this.fail(e));
    socket.on('close', () => this.fail(new Error('connection closed')));
  }

  private onData(d: Buffer): void {
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, d]) : d;
    while (this.buffered.length >= 4) {
      const len = this.buffered.readUInt32BE(0);
      if (len > MAX_FRAME) {
        this.fail(new Error('frame too large'));
        this.socket.destroy();
        return;
      }
      if (this.buffered.length < 4 + len) break;
      const frame = Buffer.from(this.buffered.subarray(4, 4 + len));
      this.buffered = this.buffered.subarray(4 + len);
      this.deliver(frame);
    }
  }

  private deliver(frame: Buffer): void {
    if (this.handler) return this.handler(frame);
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      return w.resolve(frame);
    }
    this.queue.push(frame);
  }

  private fail(e: Error): void {
    if (this.error) return;
    this.error = e;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.reject(e);
    }
    this.emit('close', e);
  }

  read(timeoutMs: number): Promise<Buffer> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new HandshakeError('timeout'));
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  /** Switch to push mode: every frame (including already queued ones) goes to `fn`. */
  onFrame(fn: (b: Buffer) => void): void {
    this.handler = fn;
    for (const f of this.queue.splice(0)) fn(f);
  }

  write(payload: Buffer): boolean {
    const head = Buffer.allocUnsafe(4);
    head.writeUInt32BE(payload.length, 0);
    return this.socket.write(Buffer.concat([head, payload]));
  }

  drain(): Promise<void> {
    if (this.socket.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.socket.off('drain', done);
        this.socket.off('close', done);
        resolve();
      };
      this.socket.once('drain', done);
      this.socket.once('close', done);
    });
  }
}

// ---------------------------------------------------------------- session

export interface PeerHello {
  id: string;
  pub: string;
  name: string;
  os: string;
  /** TCP port the peer listens on, so we can dial back later */
  port: number;
}

/** Established, authenticated, AES-256-GCM encrypted channel. */
export class Session extends EventEmitter {
  private sendCtr = 0n;
  private recvCtr = 0n;
  private lastRx = Date.now();
  private timers: NodeJS.Timeout[] = [];
  closed = false;
  readonly remoteAddress: string;

  constructor(
    readonly stream: FrameStream,
    private sendKey: Buffer,
    private recvKey: Buffer,
    readonly peer: PeerHello,
    readonly initiator: boolean,
  ) {
    super();
    this.setMaxListeners(50);
    this.remoteAddress = (stream.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    stream.on('close', () => this.close());
  }

  private nonce(ctr: bigint): Buffer {
    const n = Buffer.alloc(12);
    n.writeBigUInt64BE(ctr, 4);
    return n;
  }

  private seal(type: number, body: Buffer): Buffer {
    const c = crypto.createCipheriv('aes-256-gcm', this.sendKey, this.nonce(this.sendCtr++));
    const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from([type]), body])), c.final()]);
    return Buffer.concat([ct, c.getAuthTag()]);
  }

  private open(frame: Buffer): { type: number; body: Buffer } {
    if (frame.length < 17) throw new Error('short frame');
    const d = crypto.createDecipheriv('aes-256-gcm', this.recvKey, this.nonce(this.recvCtr++));
    d.setAuthTag(frame.subarray(frame.length - 16));
    const pt = Buffer.concat([d.update(frame.subarray(0, frame.length - 16)), d.final()]);
    return { type: pt[0], body: pt.subarray(1) };
  }

  sendJSON(obj: unknown): void {
    if (this.closed) return;
    this.stream.write(this.seal(T_JSON, Buffer.from(JSON.stringify(obj))));
  }

  /** Sends a binary payload; resolves once the socket buffer has drained (backpressure). */
  async sendBin(kind: number, data: Buffer): Promise<void> {
    if (this.closed) return;
    const ok = this.stream.write(this.seal(kind, data));
    if (!ok) await this.stream.drain();
  }

  /** Handshake-phase read of one encrypted JSON message. */
  async recvJSON(timeoutMs: number): Promise<any> {
    const frame = await this.stream.read(timeoutMs);
    let m;
    try {
      m = this.open(frame);
    } catch {
      throw new HandshakeError('auth-failed');
    }
    if (m.type !== T_JSON) throw new HandshakeError('bad-frame');
    return JSON.parse(m.body.toString('utf8'));
  }

  /** Begin normal operation. Emits 'json' (msg) and 'bin' (kind, buffer). */
  start(): void {
    this.stream.onFrame((frame) => {
      let m;
      try {
        m = this.open(frame);
      } catch {
        this.close();
        return;
      }
      this.lastRx = Date.now();
      if (m.type === T_JSON) {
        let obj;
        try {
          obj = JSON.parse(m.body.toString('utf8'));
        } catch {
          return;
        }
        if (obj && obj.t === 'ping') return;
        this.emit('json', obj);
      } else {
        this.emit('bin', m.type, m.body);
      }
    });
    this.stream.socket.setKeepAlive(true, 10_000);
    this.timers.push(
      setInterval(() => this.sendJSON({ t: 'ping' }), 10_000),
      setInterval(() => {
        if (Date.now() - this.lastRx > 35_000) this.close();
      }, 5_000),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.stream.socket.destroy();
    this.emit('close');
  }
}

// ---------------------------------------------------------------- handshake

export class HandshakeError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface HandshakeCtx {
  identity: Identity;
  deviceName: string;
  os: string;
  listenPort: number;
  /** initiator: 'pair' runs the one-time pairing flow, 'normal' only talks to a known peer */
  mode?: 'normal' | 'pair';
  /** initiator, normal mode: the identity we expect at the other end */
  expectId?: string;
  /** responder: is pairing currently allowed? */
  allowPairing?: () => boolean;
  /** responder: is this identity already paired? */
  isKnown?: (id: string) => boolean;
  /** both sides, pair mode: show the 6 digit code and resolve with the user's answer */
  confirmPair?: (sas: string, peer: PeerHello) => Promise<boolean>;
}

export interface HandshakeResult {
  session: Session;
  peer: PeerHello;
  newlyPaired: boolean;
}

const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest();

function parseJSON(b: Buffer): any {
  try {
    return JSON.parse(b.toString('utf8'));
  } catch {
    throw new HandshakeError('bad-frame');
  }
}

function parseHello(text: string): PeerHello {
  const h = (() => {
    try {
      return JSON.parse(text);
    } catch {
      throw new HandshakeError('bad-frame');
    }
  })();
  if (h.t === 'reject') throw new HandshakeError(String(h.reason ?? 'rejected'));
  if (h.t !== 'hello' || h.v !== PROTOCOL_VERSION) throw new HandshakeError('bad-version');
  for (const k of ['pub', 'eph', 'nonce', 'name', 'os']) if (typeof h[k] !== 'string') throw new HandshakeError('bad-hello');
  if (h.pub.length > 200 || h.eph.length > 200 || h.name.length > 100) throw new HandshakeError('bad-hello');
  return { id: idOfPub(h.pub), pub: h.pub, name: h.name, os: h.os, port: Number(h.port) || 0 };
}

function reject(stream: FrameStream, reason: string): never {
  try {
    stream.write(Buffer.from(JSON.stringify({ t: 'reject', reason })));
  } catch {
    /* ignore */
  }
  setTimeout(() => stream.socket.destroy(), 100);
  throw new HandshakeError(reason);
}

export async function handshake(
  sock: net.Socket,
  role: 'initiator' | 'responder',
  ctx: HandshakeCtx,
): Promise<HandshakeResult> {
  const stream = new FrameStream(sock);
  try {
    return await doHandshake(stream, role, ctx);
  } catch (e) {
    sock.destroy();
    throw e;
  }
}

async function doHandshake(stream: FrameStream, role: 'initiator' | 'responder', ctx: HandshakeCtx): Promise<HandshakeResult> {
  const eph = crypto.generateKeyPairSync('x25519');
  const myStr = JSON.stringify({
    t: 'hello',
    v: PROTOCOL_VERSION,
    pub: ctx.identity.pub,
    eph: eph.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    nonce: crypto.randomBytes(32).toString('base64'),
    name: ctx.deviceName,
    os: ctx.os,
    port: ctx.listenPort,
  });
  let timeout = ctx.mode === 'pair' ? PAIR_TIMEOUT : HANDSHAKE_TIMEOUT;
  let pairing = ctx.mode === 'pair';
  let peerStr: string;
  let peer: PeerHello;

  if (role === 'initiator') {
    if (pairing) {
      // Commit to our hello before seeing theirs, so neither side can grind the 6 digit code.
      stream.write(Buffer.from(JSON.stringify({ t: 'pair-commit', c: sha256(myStr).toString('hex') })));
      peerStr = (await stream.read(timeout)).toString('utf8');
      peer = parseHello(peerStr);
      stream.write(Buffer.from(myStr));
    } else {
      stream.write(Buffer.from(myStr));
      peerStr = (await stream.read(timeout)).toString('utf8');
      peer = parseHello(peerStr);
      if (ctx.expectId && peer.id !== ctx.expectId) throw new HandshakeError('identity-mismatch');
    }
  } else {
    const first = await stream.read(timeout);
    const firstObj = parseJSON(first);
    if (firstObj.t === 'pair-commit') {
      if (!ctx.allowPairing?.()) reject(stream, 'pairing-disabled');
      if (typeof firstObj.c !== 'string') reject(stream, 'bad-frame');
      pairing = true;
      timeout = PAIR_TIMEOUT;
      stream.write(Buffer.from(myStr));
      peerStr = (await stream.read(timeout)).toString('utf8');
      if (sha256(peerStr).toString('hex') !== firstObj.c) reject(stream, 'commit-mismatch');
      peer = parseHello(peerStr);
    } else {
      peerStr = first.toString('utf8');
      peer = parseHello(peerStr);
      if (!ctx.isKnown?.(peer.id)) reject(stream, 'unknown-device');
      stream.write(Buffer.from(myStr));
    }
  }

  const initStr = role === 'initiator' ? myStr : peerStr;
  const respStr = role === 'initiator' ? peerStr : myStr;
  const th = sha256(initStr + '\n' + respStr);
  const peerEph = crypto.createPublicKey({
    key: Buffer.from(JSON.parse(peerStr).eph, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: peerEph });
  const derive = (info: string) => Buffer.from(crypto.hkdfSync('sha256', shared, th, info, 32));
  const i2r = derive('devlink/i2r');
  const r2i = derive('devlink/r2i');
  const session = new Session(
    stream,
    role === 'initiator' ? i2r : r2i,
    role === 'initiator' ? r2i : i2r,
    peer,
    role === 'initiator',
  );

  // Mutual authentication: sign the transcript hash with the long-term identity key.
  const label = (r: 'initiator' | 'responder') => Buffer.concat([Buffer.from('devlink-auth-' + r + '-'), th]);
  session.sendJSON({ t: 'auth', sig: crypto.sign(null, label(role), ctx.identity.privateKey).toString('base64') });
  const auth = await session.recvJSON(timeout);
  const peerRole = role === 'initiator' ? 'responder' : 'initiator';
  const peerKey = crypto.createPublicKey({ key: Buffer.from(peer.pub, 'base64'), format: 'der', type: 'spki' });
  if (auth.t !== 'auth' || typeof auth.sig !== 'string' || !crypto.verify(null, label(peerRole), peerKey, Buffer.from(auth.sig, 'base64'))) {
    throw new HandshakeError('auth-failed');
  }

  let newlyPaired = false;
  if (pairing) {
    // Short authentication string: both screens must show the same 6 digits.
    const sas = String(sha256(Buffer.concat([Buffer.from('devlink-sas'), th])).readUInt32BE(0) % 1_000_000).padStart(6, '0');
    const ok = ctx.confirmPair ? await ctx.confirmPair(sas, peer) : false;
    session.sendJSON({ t: 'pair-confirm', ok });
    const theirs = await session.recvJSON(PAIR_TIMEOUT);
    if (!ok || theirs.t !== 'pair-confirm' || theirs.ok !== true) throw new HandshakeError('pair-declined');
    newlyPaired = true;
  } else if (role === 'responder' && !ctx.isKnown?.(peer.id)) {
    throw new HandshakeError('unknown-device');
  }
  return { session, peer, newlyPaired };
}
