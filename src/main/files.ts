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
const MAX_FILES = 50_000;
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

  constructor(private core: Core) {
    core.onJson('file', (peerId, msg) => this.onMessage(peerId, msg));
    core.onBin(BIN_FILE, (peerId, data) => this.onChunk(peerId, data));
    core.onPeerDown((peerId) => this.abortPeer(peerId));
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
      const st = fs.statSync(p);
      const root = path.basename(p);
      const files: { abs: string; rel: string; size: number }[] = [];
      if (st.isDirectory()) this.walk(p, root, files);
      else if (st.isFile()) files.push({ abs: p, rel: root, size: st.size });
      else continue;
      const batch = crypto.randomBytes(6).toString('hex');
      const t: Transfer = {
        id: `out-${batch}`,
        peerId,
        peerName: this.peerName(peerId),
        dir: 'out',
        name: root,
        files: files.length,
        filesDone: 0,
        bytes: files.reduce((n, f) => n + f.size, 0),
        bytesDone: 0,
        state: 'active',
        ts: Date.now(),
      };
      this.transfers.set(t.id, t);
      this.core.changed();
      try {
        for (const f of files) {
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
            await session.sendBin(BIN_FILE, Buffer.concat([head, chunk as Buffer]));
            t.bytesDone += (chunk as Buffer).length;
            this.core.changed();
          }
          session.sendJSON({ t: 'file-end', fid });
          t.filesDone++;
        }
        t.state = 'done';
      } catch (e: any) {
        t.state = 'error';
        t.error = e.message;
      }
      this.touch(t);
    }
  }

  private walk(dir: string, rel: string, out: { abs: string; rel: string; size: number }[]): void {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= MAX_FILES) throw new Error(`folder has more than ${MAX_FILES} files`);
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) this.walk(abs, path.join(rel, e.name), out);
      else if (e.isFile()) out.push({ abs, rel: path.join(rel, e.name), size: fs.statSync(abs).size });
    }
  }

  // ------------------------------------------------------------ receiving

  private onMessage(peerId: string, msg: any): void {
    const key = (fid: number) => `${peerId}:${fid}`;
    if (msg.t === 'file-start') {
      const s = this.core.store.settings;
      if (!s.acceptFiles) {
        this.core.send(peerId, { t: 'file-reject', fid: msg.fid, reason: 'receiving is turned off on the other device' });
        return;
      }
      if (typeof msg.name !== 'string' || !Number.isFinite(msg.size) || msg.size < 0 || this.incoming.has(key(msg.fid))) return;
      const root = path.resolve(s.downloadsDir, sanitizeRelPath(this.peerName(peerId)));
      const segs = sanitizeRelPath(msg.name).split(path.sep);
      const batchKey = `in-${peerId}-${msg.batch}`;
      let t = this.transfers.get(batchKey);
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
      inc.ws.end(() => {
        if (inc.failed || inc.got !== inc.size) {
          t.state = 'error';
          t.error = inc.failed ?? 'size mismatch';
          fs.rm(inc.file, { force: true }, () => undefined);
        } else {
          t.filesDone++;
          if (t.filesDone >= t.files && t.state === 'active') t.state = 'done';
        }
        this.touch(t);
      });
    } else if (msg.t === 'file-reject') {
      for (const t of this.transfers.values()) if (t.dir === 'out' && t.peerId === peerId && t.state === 'active') {
        t.state = 'error';
        t.error = String(msg.reason ?? 'rejected');
        this.touch(t);
      }
    }
  }

  private onChunk(peerId: string, data: Buffer): void {
    if (data.length < 4) return;
    const inc = this.incoming.get(`${peerId}:${data.readUInt32BE(0)}`);
    if (!inc) return;
    const body = data.subarray(4);
    inc.got += body.length;
    if (inc.got > inc.size) {
      inc.failed = 'received more data than announced';
      return;
    }
    inc.ws.write(body);
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
