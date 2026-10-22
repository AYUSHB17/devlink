import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Core } from './core';

/**
 * Remote folders: a paired device can browse (and, if allowed, edit) folders you explicitly share.
 *
 * Everything the peer sends is untrusted. A request names a share id plus a relative path; it can never name an
 * absolute path, and the resolved real path (symlinks followed) must stay inside the share's real root.
 * Protocol: JSON messages with the `fs` prefix, request `fs-<op>` carries `rid`, reply is `fs-res` with the same `rid`.
 */

export interface Share {
  id: string;
  name: string;
  path: string;
  writable: boolean;
}

export interface DirEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
  mtimeMs: number;
}

export interface RemoteShare {
  id: string;
  name: string;
  writable: boolean;
}

interface Persisted {
  enabled: boolean;
  shares: Share[];
}

export const MAX_LIST = 5000;
export const MAX_READ = 1024 * 1024;
export const MAX_WRITE = 8 * 1024 * 1024;
const REQUEST_TIMEOUT = 15_000;
const MAX_NAME = 255;

/** Credential stores that are never exposed, even inside a share. Matched against every path segment. */
const BLOCKED = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.azure']);

export class FsError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Splits a peer-supplied relative path into safe segments, or throws. Strict: nothing is silently rewritten. */
export function safeSegments(rel: unknown): string[] {
  if (typeof rel !== 'string' || rel.length > 4096) throw new FsError('bad-path');
  if (rel.includes('\u0000')) throw new FsError('bad-path');
  const segs = rel.split('/').filter((s) => s && s !== '.');
  for (const s of segs) {
    if (s === '..' || s.length > MAX_NAME) throw new FsError('bad-path');
    if (process.platform === 'win32' && /[<>:"|?*\\\u0000-\u001f]/.test(s)) throw new FsError('bad-path');
    if (BLOCKED.has(s.toLowerCase())) throw new FsError('blocked');
  }
  return segs;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface Activity {
  ts: number;
  peer: string;
  op: string;
  share: string;
  path: string;
  ok: boolean;
}

type Pending = { peerId: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class RemoteFs {
  private data: Persisted = { enabled: false, shares: [] };
  private file: string;
  private pending = new Map<string, Pending>();
  private activity: Activity[] = [];
  /** the main process plugs the edit-in-place sessions in here so the UI gets them with the rest of the state */
  extraSnapshot?: () => unknown;

  constructor(private core: Core) {
    this.file = path.join(core.store.dir, 'remotefs.json');
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { enabled: loaded.enabled === true, shares: Array.isArray(loaded.shares) ? loaded.shares : [] };
    } catch {
      /* first run */
    }
    core.onJson('fs', (peerId, msg) => void this.onMessage(peerId, msg));
    core.onPeerDown((peerId) => this.failPending(peerId, 'device disconnected'));
  }

  // ------------------------------------------------------------ settings (this machine's side)

  get enabled(): boolean {
    return this.data.enabled;
  }
  setEnabled(on: boolean): void {
    this.data.enabled = !!on;
    this.save();
    this.core.changed();
  }
  get shares(): Share[] {
    return this.data.shares;
  }

  snapshot() {
    return { enabled: this.data.enabled, shares: this.data.shares, activity: this.activity, edits: this.extraSnapshot?.() ?? [] };
  }

  private record(peerId: string, op: string, msg: any, ok: boolean): void {
    this.activity.unshift({
      ts: Date.now(),
      peer: this.core.store.getPeer(peerId)?.name ?? 'device',
      op: op.replace(/^fs-/, ''),
      share: this.data.shares.find((s) => s.id === msg.share)?.name ?? '?',
      path: typeof msg.path === 'string' ? msg.path.slice(0, 200) : '',
      ok,
    });
    this.activity.length = Math.min(this.activity.length, 30);
    this.core.changed();
  }

  addShare(folder: string, writable = false, name?: string): Share {
    const real = fs.realpathSync(path.resolve(folder));
    if (!fs.statSync(real).isDirectory()) throw new Error('not a folder');
    if (path.parse(real).root === real) throw new Error('refusing to share a whole drive');
    if (real === fs.realpathSync(os.homedir())) throw new Error('refusing to share your whole home folder; pick a project folder');
    if (this.data.shares.some((s) => s.path === real)) throw new Error('already shared');
    const share: Share = {
      id: crypto.randomBytes(4).toString('hex'),
      name: (name?.trim() || path.basename(real)).slice(0, 100),
      path: real,
      writable: !!writable,
    };
    this.data.shares.push(share);
    this.save();
    this.core.changed();
    return share;
  }

  removeShare(id: string): void {
    this.data.shares = this.data.shares.filter((s) => s.id !== id);
    this.save();
    this.core.changed();
  }

  setWritable(id: string, writable: boolean): void {
    this.data.shares = this.data.shares.map((s) => (s.id === id ? { ...s, writable: !!writable } : s));
    this.save();
    this.core.changed();
  }

  private save(): void {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // ------------------------------------------------------------ path confinement

  /**
   * Maps (share id, peer path) to a real path guaranteed to be inside the share.
   * For a path that does not exist yet (writes) the parent directory must exist and be inside.
   */
  resolve(shareId: unknown, rel: unknown, opts: { write?: boolean } = {}): { share: Share; real: string; root: string } {
    const share = this.data.shares.find((s) => s.id === shareId);
    if (!share) throw new FsError('no-such-share');
    if (opts.write && !share.writable) throw new FsError('read-only');
    const segs = safeSegments(rel);
    let root: string;
    try {
      root = fs.realpathSync(share.path);
    } catch {
      throw new FsError('share-unavailable');
    }
    const lexical = path.join(root, ...segs);
    let real: string;
    try {
      real = fs.realpathSync(lexical);
    } catch (e: any) {
      if (e.code !== 'ENOENT' || !opts.write || !segs.length) throw new FsError(e.code === 'ENOENT' ? 'not-found' : 'io-error');
      // creating a new file: its parent must exist and resolve inside the share
      let parent: string;
      try {
        parent = fs.realpathSync(path.dirname(lexical));
      } catch {
        throw new FsError('not-found');
      }
      real = path.join(parent, path.basename(lexical));
    }
    if (!isInside(root, real)) throw new FsError('outside-share');
    return { share, real, root };
  }

  // ------------------------------------------------------------ serving requests from a peer

  private async onMessage(peerId: string, msg: any): Promise<void> {
    if (msg.t === 'fs-res') return this.onResponse(peerId, msg);
    const rid = typeof msg.rid === 'string' ? msg.rid.slice(0, 64) : '';
    if (!rid || typeof msg.t !== 'string') return;
    const reply = (body: Record<string, unknown>): void => void this.core.send(peerId, { t: 'fs-res', rid, ...body });
    // Only paired peers reach here (the session is authenticated); this switch is the user's own opt-in.
    if (!this.data.enabled) return reply({ ok: false, error: 'remote-folders-off' });
    try {
      switch (msg.t) {
        case 'fs-shares':
          return reply({ ok: true, shares: this.data.shares.map(({ id, name, writable }) => ({ id, name, writable })) });
        case 'fs-list':
          reply({ ok: true, entries: await this.list(msg.share, msg.path) });
          return this.record(peerId, msg.t, msg, true);
        case 'fs-read': {
          const r = await this.read(msg.share, msg.path, msg.offset, msg.length);
          reply({ ok: true, ...r });
          // log a read once per file (its first chunk), not once per 1 MB chunk
          if (!msg.offset) this.record(peerId, msg.t, msg, true);
          return;
        }
        case 'fs-write':
          reply({ ok: true, ...(await this.write(msg.share, msg.path, msg.data, msg.expectMtimeMs)) });
          return this.record(peerId, msg.t, msg, true);
        default:
          return reply({ ok: false, error: 'unsupported' });
      }
    } catch (e: any) {
      // never leak absolute paths or OS error text to the peer
      reply({ ok: false, error: e instanceof FsError ? e.code : 'io-error' });
      this.record(peerId, msg.t, msg, false);
      if (!(e instanceof FsError)) this.core.log(`remotefs: ${e.message}`);
    }
  }

  async list(shareId: unknown, rel: unknown): Promise<DirEntry[]> {
    const { real } = this.resolve(shareId, rel);
    const names = await fs.promises.readdir(real);
    if (names.length > MAX_LIST) throw new FsError('too-many-entries');
    const out: DirEntry[] = [];
    for (const name of names) {
      if (BLOCKED.has(name.toLowerCase())) continue;
      try {
        const st = await fs.promises.stat(path.join(real, name));
        if (st.isDirectory()) out.push({ name, type: 'dir', size: 0, mtimeMs: st.mtimeMs });
        else if (st.isFile()) out.push({ name, type: 'file', size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* unreadable or broken link: skip */
      }
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  }

  async read(shareId: unknown, rel: unknown, offset: unknown, length: unknown): Promise<{ data: string; size: number; mtimeMs: number; eof: boolean }> {
    const { real, root } = this.resolve(shareId, rel);
    const off = Number.isSafeInteger(offset) && (offset as number) >= 0 ? (offset as number) : 0;
    const len = Math.min(Number.isSafeInteger(length) && (length as number) > 0 ? (length as number) : MAX_READ, MAX_READ);
    const fh = await fs.promises.open(real, 'r');
    try {
      // re-check on the opened handle's path to narrow the symlink-swap window
      if (!isInside(root, fs.realpathSync(real))) throw new FsError('outside-share');
      const st = await fh.stat();
      if (!st.isFile()) throw new FsError('not-a-file');
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, off);
      return { data: buf.subarray(0, bytesRead).toString('base64'), size: st.size, mtimeMs: st.mtimeMs, eof: off + bytesRead >= st.size };
    } finally {
      await fh.close();
    }
  }

  /** Replaces a whole file. `expectMtimeMs` (from the last read/list) makes a concurrent local edit a conflict, not a silent overwrite. */
  async write(shareId: unknown, rel: unknown, data: unknown, expectMtimeMs: unknown): Promise<{ size: number; mtimeMs: number }> {
    if (typeof data !== 'string') throw new FsError('bad-data');
    const body = Buffer.from(data, 'base64');
    if (body.length > MAX_WRITE) throw new FsError('too-large');
    const { real, root } = this.resolve(shareId, rel, { write: true });
    let existing: fs.Stats | null = null;
    try {
      existing = await fs.promises.stat(real);
    } catch {
      /* new file */
    }
    if (existing) {
      if (!existing.isFile()) throw new FsError('not-a-file');
      // editing an existing file needs the version the editor started from
      if (typeof expectMtimeMs !== 'number' || Math.abs(existing.mtimeMs - expectMtimeMs) > 1) throw new FsError('conflict');
    }
    const tmp = path.join(path.dirname(real), `.devlink-${crypto.randomBytes(4).toString('hex')}.tmp`);
    if (!isInside(root, path.dirname(real))) throw new FsError('outside-share');
    try {
      await fs.promises.writeFile(tmp, body, { flag: 'wx', mode: existing ? existing.mode & 0o777 : 0o644 });
      await fs.promises.rename(tmp, real);
    } catch (e) {
      await fs.promises.rm(tmp, { force: true });
      throw e;
    }
    const st = await fs.promises.stat(real);
    return { size: st.size, mtimeMs: st.mtimeMs };
  }

  // ------------------------------------------------------------ asking a peer (this machine's client side)

  private request<T = any>(peerId: string, type: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.core.sessions.has(peerId)) return reject(new Error('device is offline'));
      const rid = crypto.randomBytes(8).toString('hex');
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error('timed out'));
      }, REQUEST_TIMEOUT);
      this.pending.set(rid, { peerId, resolve, reject, timer });
      this.core.send(peerId, { t: type, rid, ...params });
    });
  }

  private onResponse(peerId: string, msg: any): void {
    const p = typeof msg.rid === 'string' ? this.pending.get(msg.rid) : undefined;
    // a reply only counts if it comes from the device we asked
    if (!p || p.peerId !== peerId) return;
    this.pending.delete(msg.rid);
    clearTimeout(p.timer);
    if (msg.ok === true) p.resolve(msg);
    else p.reject(new Error(typeof msg.error === 'string' ? msg.error.slice(0, 60) : 'failed'));
  }

  private failPending(peerId: string, why: string): void {
    for (const [rid, p] of [...this.pending]) {
      if (p.peerId !== peerId) continue;
      this.pending.delete(rid);
      clearTimeout(p.timer);
      p.reject(new Error(why));
    }
  }

  async remoteShares(peerId: string): Promise<RemoteShare[]> {
    return (await this.request(peerId, 'fs-shares')).shares;
  }
  async remoteList(peerId: string, share: string, rel: string): Promise<DirEntry[]> {
    return (await this.request(peerId, 'fs-list', { share, path: rel })).entries;
  }
  async remoteReadAll(peerId: string, share: string, rel: string, maxBytes = 64 * 1024 * 1024): Promise<{ data: Buffer; mtimeMs: number }> {
    const chunks: Buffer[] = [];
    let got = 0;
    let mtimeMs = 0;
    for (;;) {
      const r = await this.request(peerId, 'fs-read', { share, path: rel, offset: got, length: MAX_READ });
      const b = Buffer.from(String(r.data), 'base64');
      chunks.push(b);
      got += b.length;
      mtimeMs = r.mtimeMs;
      if (got > maxBytes) throw new Error('file too large to open remotely');
      if (r.eof || !b.length) break;
    }
    return { data: Buffer.concat(chunks), mtimeMs };
  }
  async remoteWrite(peerId: string, share: string, rel: string, data: Buffer, expectMtimeMs?: number): Promise<{ size: number; mtimeMs: number }> {
    return this.request(peerId, 'fs-write', { share, path: rel, data: data.toString('base64'), expectMtimeMs });
  }
}
