import * as fs from 'fs';
import * as path from 'path';
import type { Core } from './core';
import { RemoteEdit } from './remoteedit';
import { sanitizeRelPath } from './files';

/** The few Electron pieces this needs, passed in so main.ts stays the only file that imports electron. */
export interface RemoteFsDeps {
  ipcMain: { handle(channel: string, fn: (e: unknown, ...args: any[]) => unknown): void };
  dialog: { showOpenDialog(win: any, opts: any): Promise<{ canceled: boolean; filePaths: string[] }> };
  shell: { openPath(p: string): Promise<string>; showItemInFolder(p: string): void };
  win: () => any;
  /** private temp folder for edit-in-place copies */
  editDir: string;
}

function uniquePath(p: string): string {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 1; i < 10_000; i++) if (!fs.existsSync(`${base} (${i})${ext}`)) return `${base} (${i})${ext}`;
  return `${p}.${Date.now()}`;
}

export function registerRemoteFsIpc(core: Core, deps: RemoteFsDeps): RemoteEdit {
  const edit = new RemoteEdit(
    core.remotefs,
    deps.editDir,
    async (file) => {
      const err = await deps.shell.openPath(file);
      if (err) throw new Error(err);
    },
    () => core.changed(),
  );
  core.remotefs.extraSnapshot = () => edit.snapshot();

  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    deps.ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { ok: true, value: await fn(...args) };
      } catch (e: any) {
        return { ok: false, error: friendly(e.message ?? String(e)) };
      }
    });
  const peerName = (id: string) => core.store.getPeer(String(id))?.name ?? 'device';
  const str = (v: unknown) => (typeof v === 'string' ? v : '');

  handle('rfs:enable', (on: boolean) => core.remotefs.setEnabled(!!on));
  handle('rfs:share', async (writable: boolean) => {
    const r = await deps.dialog.showOpenDialog(deps.win(), { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return core.remotefs.addShare(r.filePaths[0], !!writable).name;
  });
  handle('rfs:unshare', (id: string) => core.remotefs.removeShare(str(id)));
  handle('rfs:writable', (id: string, on: boolean) => core.remotefs.setWritable(str(id), !!on));

  handle('rfs:shares', (peerId: string) => core.remotefs.remoteShares(str(peerId)));
  handle('rfs:list', (peerId: string, share: string, rel: string) => core.remotefs.remoteList(str(peerId), str(share), str(rel)));

  /** Copy a remote file into <downloads>/<device>/ (never overwrites). */
  handle('rfs:copy', async (peerId: string, share: string, rel: string) => {
    const got = await core.remotefs.remoteReadAll(str(peerId), str(share), str(rel));
    const dir = path.join(core.store.settings.downloadsDir, sanitizeRelPath(peerName(peerId)));
    fs.mkdirSync(dir, { recursive: true });
    const dest = uniquePath(path.join(dir, sanitizeRelPath(path.posix.basename(str(rel)))));
    fs.writeFileSync(dest, got.data);
    deps.shell.showItemInFolder(dest);
    return dest;
  });
  handle('rfs:edit', async (peerId: string, share: string, rel: string) => {
    const s = await edit.start(str(peerId), str(share), str(rel), peerName(peerId));
    return s.name;
  });
  handle('rfs:stopEdit', (id: string) => edit.stop(str(id)));
  return edit;
}

/** Turns the short protocol codes into sentences the UI can show as-is. */
function friendly(code: string): string {
  const map: Record<string, string> = {
    'remote-folders-off': 'That device has not turned on folder sharing.',
    'no-such-share': 'That folder is no longer shared.',
    'read-only': 'That folder is shared read-only.',
    conflict: 'The file changed on the other device. Reload and try again.',
    'not-found': 'Not found on the other device.',
    blocked: 'That item is never shared (credentials folder).',
    'outside-share': 'That path is outside the shared folder.',
    'bad-path': 'Invalid path.',
    'too-large': 'File is too large.',
    'too-many-entries': 'Folder has too many entries to list.',
    'share-unavailable': 'The shared folder is not available on that device.',
    'io-error': 'The other device could not read that.',
  };
  return map[code] ?? code;
}
