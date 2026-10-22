import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { MAX_WRITE, RemoteFs } from './remotefs';

export interface EditSession {
  id: string;
  peerId: string;
  peerName: string;
  share: string;
  path: string;
  name: string;
  local: string;
  state: 'open' | 'saving' | 'saved' | 'error';
  error?: string;
  ts: number;
}

const MAX_AGE = 4 * 60 * 60 * 1000;

/**
 * Edit-in-place: copy a file from a peer's shared folder to a private temp folder, open it in the normal
 * app, and push every save back to the peer. A save fails (and your copy is kept) if the file changed on the
 * other device since you opened it, so nobody's edits are silently overwritten.
 */
export class RemoteEdit {
  private sessions = new Map<string, EditSession & { lastMtime: number; timer?: NodeJS.Timeout; busy: boolean; again: boolean; expiry: NodeJS.Timeout }>();

  constructor(
    private rfs: RemoteFs,
    private root: string,
    private opener: (file: string) => unknown,
    private onChange: () => void,
  ) {
    // leftovers from a crash can hold copies of remote files, so start clean
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  snapshot(): EditSession[] {
    return [...this.sessions.values()]
      .map(({ lastMtime, timer, busy, again, expiry, ...s }) => s)
      .sort((a, b) => b.ts - a.ts);
  }

  async start(peerId: string, shareId: string, rel: string, peerName: string): Promise<EditSession> {
    const remote = await this.rfs.remoteReadAll(peerId, shareId, rel, MAX_WRITE);
    const id = crypto.randomBytes(6).toString('hex');
    const name = (path.posix.basename(rel).replace(/[^\w.\- ]/g, '_').slice(0, 100) || 'file').replace(/^\.+$/, '_');
    const dir = path.join(this.root, id);
    fs.mkdirSync(dir, { mode: 0o700 });
    const local = path.join(dir, name);
    fs.writeFileSync(local, remote.data, { mode: 0o600 });
    const s = {
      id, peerId, peerName, share: shareId, path: rel, name, local,
      state: 'open' as const, ts: Date.now(), lastMtime: remote.mtimeMs, busy: false, again: false,
      expiry: setTimeout(() => this.stop(id), MAX_AGE),
    } as EditSession & { lastMtime: number; timer?: NodeJS.Timeout; busy: boolean; again: boolean; expiry: NodeJS.Timeout };
    s.expiry.unref();
    this.sessions.set(id, s);
    fs.watchFile(local, { interval: 700 }, (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return;
      clearTimeout(s.timer);
      s.timer = setTimeout(() => void this.push(s), 400); // let the editor finish writing
    });
    this.onChange();
    await this.opener(local);
    return this.snapshot().find((x) => x.id === id)!;
  }

  private async push(s: EditSession & { lastMtime: number; busy: boolean; again: boolean }): Promise<void> {
    if (!this.sessions.has(s.id)) return;
    if (s.busy) {
      s.again = true;
      return;
    }
    s.busy = true;
    s.state = 'saving';
    s.error = undefined;
    this.onChange();
    try {
      const data = fs.readFileSync(s.local);
      if (data.length > MAX_WRITE) throw new Error('file is too large to save back');
      const r = await this.rfs.remoteWrite(s.peerId, s.share, s.path, data, s.lastMtime);
      s.lastMtime = r.mtimeMs;
      s.state = 'saved';
    } catch (e: any) {
      s.state = 'error';
      s.error = e.message === 'conflict' ? 'changed on the other device since you opened it. Your copy is kept here.' : e.message;
    } finally {
      s.busy = false;
      s.ts = Date.now();
      this.onChange();
    }
    if (s.again) {
      s.again = false;
      void this.push(s);
    }
  }

  stop(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    clearTimeout(s.timer);
    clearTimeout(s.expiry);
    fs.unwatchFile(s.local);
    fs.rmSync(path.dirname(s.local), { recursive: true, force: true });
    this.onChange();
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }
}
