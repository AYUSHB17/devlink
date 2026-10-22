import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Core } from './core';
import { BIN_FILE } from './protocol';

export interface Transfer {
  id: string;
  peerId: string;
  peerName: string;
  dir: 'in' | 'out';
  name: string;
  files: number;
  filesDone: number;
  bytes: number;
  bytesDone: number;
  state: 'active' | 'done' | 'error';
  error?: string;
  /** where received data landed (incoming only) */
  path?: string;
  ts: number;
}

interface Incoming {
  ws: fs.WriteStream;
  file: string;
  size: number;
  got: number;
  batch: string;
  failed?: string;
}

const CHUNK = 128 * 1024;
/** Unacknowledged bytes a sender may have in flight per peer (receiver acks once data is on disk). */
const WINDOW = 16 * 1024 * 1024;
const ACK_EVERY = 1024 * 1024;
const ACK_TIMEOUT_MS = 30_000;
const MAX_FILES = 1_000_000;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Makes a peer-supplied relative path safe to join under a root on both macOS and Windows. */
export function sanitizeRelPath(rel: string): string {
  const parts = String(rel)
    .split(/[\\/]+/)
    .filter((p) => p && p !== '.' && p !== '..')
    .map((p) => {
      let s = p.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
      if (!s) s = '_';
      if (RESERVED.test(s)) s = '_' + s;
      return s.slice(0, 200);
    });
  return parts.join(path.sep) || 'file';
}

/** Set asynchronously by a file-reject from the receiver (a function, so TypeScript doesn't narrow it away). */
const failed = (t: Transfer) => t.state === 'error';

/** Free bytes on the volume holding `dir` (or its nearest existing parent); null if unknown. */
function freeBytes(dir: string): number | null {
  let d = dir;
  for (let i = 0; i < 64 && !fs.existsSync(d); i++) d = path.dirname(d);
  try {
    const st = fs.statfsSync(d);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

function uniquePath(p: string): string {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 1; i < 10_000; i++) if (!fs.existsSync(`${base} (${i})${ext}`)) return `${base} (${i})${ext}`;
  return p + '.' + Date.now();
}

export class FileTransfers {
  private transfers = new Map<string, Transfer>();
  private incoming = new Map<string, Incoming>(); // peerId:fid
  private fidCounter = 1;
  /** sender side: bytes not yet acknowledged by each peer, and loops waiting for room */
  private credit = new Map<string, { inflight: number; waiters: (() => void)[] }>();
  /** receiver side: bytes written to disk but not yet acknowledged, per peer */
  private unacked = new Map<string, number>();
  /** receiver side: bytes received but not yet on disk, per peer (bounded, see onChunk) */
  private pending = new Map<string, number>();
  /** receiver side: batches already rejected, so the sender gets one reject per batch */
  private rejected = new Set<string>();

  constructor(private core: Core) {
    core.onJson('file', (peerId, msg) => this.onMessage(peerId, msg));
    core.onBin(BIN_FILE, (peerId, data) => this.onChunk(peerId, data));
    core.onPeerDown((peerId) => {
      this.abortPeer(peerId);
      const c = this.credit.get(peerId);
      this.credit.delete(peerId);
      this.unacked.delete(peerId);
      this.pending.delete(peerId);
      for (const k of [...this.rejected]) if (k.startsWith(peerId + ':')) this.rejected.delete(k);
      for (const w of c?.waiters ?? []) w();
    });
  }

  snapshot(): Transfer[] {
    return [...this.transfers.values()].sort((a, b) => b.ts - a.ts).slice(0, 40);
  }

  private peerName(id: string): string {
    return this.core.store.getPeer(id)?.name ?? 'device';
  }

  private touch(t: Transfer): void {
    t.ts = Date.now();
    this.core.changed();
  }

  // ------------------------------------------------------------ sending

  /** Sends files and folders to a connected peer. Resolves when all data has been handed to the socket. */
  async sendPaths(peerId: string, paths: string[]): Promise<void> {
    const session = this.core.sessions.get(peerId);
    if (!session) throw new Error('device is offline');
    for (const p of paths) {
      const root = path.basename(p);
      const batch = crypto.randomBytes(6).toString('hex');
      // Create the row first so scan problems (unreadable folder, too many files) are visible in the UI.
      const t: Transfer = {
        id: `out-${batch}`,
        peerId,
        peerName: this.peerName(peerId),
        dir: 'out',
        name: root,
        files: 0,
        filesDone: 0,
        bytes: 0,
        bytesDone: 0,
        state: 'active',
        ts: Date.now(),
      };
      this.transfers.set(t.id, t);
      this.core.changed();
      try {
        const files: { abs: string; rel: string; size: number }[] = [];
        const skipped = { n: 0 };
        const st = await fs.promises.stat(p);
        if (st.isDirectory()) await this.walk(p, root, files, skipped);
        else if (st.isFile()) files.push({ abs: p, rel: root, size: st.size });
        else throw new Error('not a file or folder');
        t.files = files.length;
        t.bytes = files.reduce((n, f) => n + f.size, 0);
        if (skipped.n) t.name = `${root} (${skipped.n} unreadable skipped)`;
        this.touch(t);
        for (const f of files) {
          // the receiver refused (e.g. receiving is off): stop instead of streaming the rest for nothing
          if (failed(t)) throw new Error(t.error ?? 'rejected');
          const fid = this.fidCounter++;
          session.sendJSON({
            t: 'file-start',
            fid,
            name: f.rel.split(path.sep).join('/'),
            size: f.size,
            batch,
            batchName: root,
            batchFiles: files.length,
            batchBytes: t.bytes,
          });
          const head = Buffer.alloc(4);
          head.writeUInt32BE(fid, 0);
          for await (const chunk of fs.createReadStream(f.abs, { highWaterMark: CHUNK })) {
            if (session.closed) throw new Error('connection lost');
            if (failed(t)) throw new Error(t.error ?? 'rejected');
            await this.waitForWindow(peerId, session);
            this.creditOf(peerId).inflight += (chunk as Buffer).length;
            await session.sendBin(BIN_FILE, Buffer.concat([head, chunk as Buffer]));
            t.bytesDone += (chunk as Buffer).length;
            this.core.changed();
          }
          session.sendJSON({ t: 'file-end', fid });
          t.filesDone++;
        }
        t.state = 'done';
      } catch (e: any) {
        if (t.state !== 'error') {
          t.state = 'error';
          t.error = e.message;
        }
        this.core.log(`send ${root}: ${t.error}`);
      }
      this.touch(t);
    }
  }

  private creditOf(peerId: string) {
    let c = this.credit.get(peerId);
    if (!c) this.credit.set(peerId, (c = { inflight: 0, waiters: [] }));
    return c;
  }

  /**
   * Application-level flow control: never let more than WINDOW bytes be in flight to a peer.
   * (Pausing the socket instead would also stall input events, clipboard and pings on the same session.)
   */
  private async waitForWindow(peerId: string, session: { closed: boolean }): Promise<void> {
    const c = this.creditOf(peerId);
    while (c.inflight > WINDOW) {
      if (session.closed) throw new Error('connection lost');
      const got = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ACK_TIMEOUT_MS);
        c.waiters.push(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!got) throw new Error('the other device stopped acknowledging data');
    }
  }

  private ack(peerId: string, bytes: number): void {
    const n = (this.unacked.get(peerId) ?? 0) + bytes;
    if (n >= ACK_EVERY) {
      this.unacked.set(peerId, 0);
      this.core.send(peerId, { t: 'file-ack', bytes: n });
    } else this.unacked.set(peerId, n);
  }

  /** Collects files below `dir`, skipping (and counting) anything unreadable instead of aborting the whole folder. */
  private async walk(dir: string, rel: string, out: { abs: string; rel: string; size: number }[], skipped: { n: number }): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      skipped.n++;
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) throw new Error(`folder has more than ${MAX_FILES.toLocaleString()} files; send it in parts or zip it`);
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await this.walk(abs, path.join(rel, e.name), out, skipped);
      else if (e.isFile()) {
        try {
          await fs.promises.access(abs, fs.constants.R_OK);
          out.push({ abs, rel: path.join(rel, e.name), size: (await fs.promises.stat(abs)).size });
        } catch {
          skipped.n++;
        }
      }
    }
  }

  // ------------------------------------------------------------ receiving

  private onMessage(peerId: string, msg: any): void {
    const key = (fid: number) => `${peerId}:${fid}`;
    if (msg.t === 'file-start') {
      // batch ids key our maps; ours are 12 hex chars, so refuse anything else a peer might send
      if (typeof msg.batch !== 'string' || !/^[0-9a-f]{1,64}$/.test(msg.batch)) return;
      const s = this.core.store.settings;
      const reject = (reason: string) => {
        const k = `${peerId}:${msg.batch}`;
        if (this.rejected.has(k)) return;
        if (this.rejected.size >= 1000) this.rejected.delete(this.rejected.values().next().value!);
        this.rejected.add(k);
        this.core.send(peerId, { t: 'file-reject', fid: msg.fid, batch: msg.batch, reason });
      };
      if (!s.acceptFiles) return reject('receiving is turned off on the other device');
      if (this.rejected.has(`${peerId}:${msg.batch}`)) return;
      if (typeof msg.name !== 'string' || !Number.isFinite(msg.size) || msg.size < 0 || this.incoming.has(key(msg.fid))) return;
      const root = path.resolve(s.downloadsDir, sanitizeRelPath(this.peerName(peerId)));
      const segs = sanitizeRelPath(msg.name).split(path.sep);
      const batchKey = `in-${peerId}-${msg.batch}`;
      let t = this.transfers.get(batchKey);
      // don't let a peer fill the disk: the whole batch (and each file) must fit, with some room to spare
      const free = freeBytes(root);
      const need = t ? Number(msg.size) : Math.max(Number(msg.batchBytes) || 0, Number(msg.size));
      if (free !== null && need > free - 256 * 1024 * 1024) return reject('not enough free disk space on the other device');
      if (!t) {
        // never overwrite: the top-level item gets a " (1)" suffix on conflict
        t = {
          id: batchKey,
          peerId,
          peerName: this.peerName(peerId),
          dir: 'in',
          name: String(msg.batchName ?? segs[0]).slice(0, 200),
          files: Number(msg.batchFiles) || 1,
          filesDone: 0,
          bytes: Number(msg.batchBytes) || msg.size,
          bytesDone: 0,
          state: 'active',
          path: uniquePath(path.join(root, segs[0])),
          ts: Date.now(),
        };
        this.transfers.set(batchKey, t);
      }
      const dest = path.join(t.path!, ...segs.slice(1));
      const rel = path.relative(root, dest);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return;
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const ws = fs.createWriteStream(dest, { flags: 'wx' });
        const inc: Incoming = { ws, file: dest, size: msg.size, got: 0, batch: batchKey };
        ws.on('error', (e) => (inc.failed = e.message));
        this.incoming.set(key(msg.fid), inc);
      } catch (e: any) {
        t.state = 'error';
        t.error = e.message;
      }
      this.touch(t);
    } else if (msg.t === 'file-end') {
      const inc = this.incoming.get(key(msg.fid));
      if (!inc) return;
      this.incoming.delete(key(msg.fid));
      const t = this.transfers.get(inc.batch)!;
      // flush the ack remainder so the sender's window never stays partly used
      const rest = this.unacked.get(peerId) ?? 0;
      if (rest) {
        this.unacked.set(peerId, 0);
        this.core.send(peerId, { t: 'file-ack', bytes: rest });
      }
      inc.ws.end(() => {
        if (inc.failed || inc.got !== inc.size) {
          t.state = 'error';
          t.error = inc.failed ?? 'size mismatch';
          fs.rm(inc.file, { force: true }, () => undefined);
        } else {
          t.filesDone++;
          if (t.filesDone >= t.files && t.state === 'active') {
            t.state = 'done';
            this.core.emit('received', t);
          }
        }
        this.touch(t);
      });
    } else if (msg.t === 'file-ack') {
      const c = this.credit.get(peerId);
      const n = Number(msg.bytes);
      if (!c || !Number.isFinite(n) || n <= 0) return;
      c.inflight = Math.max(0, c.inflight - n);
      for (const w of c.waiters.splice(0)) w();
    } else if (msg.t === 'file-reject') {
      const one = typeof msg.batch === 'string' ? this.transfers.get(`out-${msg.batch}`) : undefined;
      for (const t of one ? [one] : this.transfers.values()) if (t.dir === 'out' && t.peerId === peerId && t.state === 'active') {
        t.state = 'error';
        t.error = String(msg.reason ?? 'rejected').slice(0, 200);
        this.touch(t);
        this.core.emit('send-failed', t);
      }
    }
  }

  private onChunk(peerId: string, data: Buffer): void {
    if (data.length < 4) return;
    const body = data.subarray(4);
    // A well-behaved sender never has more than WINDOW unacknowledged; one that ignores it is cut off
    // rather than allowed to fill our memory.
    const pending = (this.pending.get(peerId) ?? 0) + body.length;
    if (pending > 2 * WINDOW) {
      this.core.log('file sender ignored flow control; closing the connection');
      this.core.sessions.get(peerId)?.close();
      return;
    }
    this.pending.set(peerId, pending);
    const done = () => {
      this.pending.set(peerId, Math.max(0, (this.pending.get(peerId) ?? 0) - body.length));
      this.ack(peerId, body.length);
    };
    const inc = this.incoming.get(`${peerId}:${data.readUInt32BE(0)}`);
    // data for a file we refused or already failed still counts against the sender's window
    if (!inc || inc.failed) return done();
    inc.got += body.length;
    if (inc.got > inc.size) {
      inc.failed = 'received more data than announced';
      return done();
    }
    // acknowledge only once the bytes are on disk, so a slow disk throttles the sender
    inc.ws.write(body, done);
    const t = this.transfers.get(inc.batch);
    if (t) {
      t.bytesDone += body.length;
      this.core.changed();
    }
  }

  private abortPeer(peerId: string): void {
    for (const [k, inc] of [...this.incoming]) {
      if (!k.startsWith(peerId + ':')) continue;
      this.incoming.delete(k);
      inc.ws.destroy();
      fs.rm(inc.file, { force: true }, () => undefined);
      const t = this.transfers.get(inc.batch);
      if (t && t.state === 'active') {
        t.state = 'error';
        t.error = 'connection lost';
      }
    }
    for (const t of this.transfers.values()) if (t.peerId === peerId && t.state === 'active') {
      t.state = 'error';
      t.error = 'connection lost';
    }
    this.core.changed();
  }
}
