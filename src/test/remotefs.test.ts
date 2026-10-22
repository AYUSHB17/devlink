import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Core, PairPrompt } from '../main/core';
import { RemoteEdit } from '../main/remoteedit';
import { FsError, RemoteFs, safeSegments } from '../main/remotefs';
import type { ClipboardAdapter } from '../main/clipboard';

const noClip: ClipboardAdapter = {
  readText: async () => '',
  writeText: async () => undefined,
  readImagePng: async () => null,
  writeImagePng: async () => undefined,
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlink-rfs-'));
const mk = (name: string) =>
  new Core({
    dir: path.join(tmp, name, 'cfg'),
    clipboard: noClip,
    discovery: false,
    defaults: { deviceName: name, listenPort: 0, downloadsDir: path.join(tmp, name, 'dl') },
  });

async function waitFor(cond: () => boolean, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'ok';
  } catch (e: any) {
    return e instanceof FsError ? e.code : e.message;
  }
};

describe('remote folders: path safety', () => {
  const A = mk('safe');
  let rfs: RemoteFs;
  let shareId = '';
  const share = path.join(tmp, 'project');
  const outside = path.join(tmp, 'outside');

  before(() => {
    rfs = A.remotefs;
    fs.mkdirSync(path.join(share, 'src'), { recursive: true });
    fs.mkdirSync(path.join(share, '.ssh'));
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(share, 'src', 'a.txt'), 'hello');
    fs.writeFileSync(path.join(share, '.ssh', 'id_rsa'), 'secret');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
    fs.symlinkSync(outside, path.join(share, 'escape'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(share, 'link.txt'));
    shareId = rfs.addShare(share, false).id;
  });

  test('rejects traversal, NUL and credential folders', async () => {
    assert.throws(() => safeSegments('../etc/passwd'), /bad-path/);
    assert.throws(() => safeSegments('a/../../b'), /bad-path/);
    assert.throws(() => safeSegments('a\u0000b'), /bad-path/);
    assert.throws(() => safeSegments(42), /bad-path/);
    assert.throws(() => safeSegments('proj/.ssh/id_rsa'), /blocked/);
    assert.deepEqual(safeSegments('/src//./a.txt'), ['src', 'a.txt']);
    assert.equal(await code(() => rfs.resolve(shareId, '../outside/secret.txt')), 'bad-path');
    assert.equal(await code(() => rfs.resolve(shareId, '.ssh/id_rsa')), 'blocked');
  });

  test('a symlink inside the share cannot lead outside it', async () => {
    assert.equal(await code(() => rfs.resolve(shareId, 'escape')), 'outside-share');
    assert.equal(await code(() => rfs.resolve(shareId, 'escape/secret.txt')), 'outside-share');
    assert.equal(await code(rfs.read(shareId, 'link.txt', 0, 100)), 'outside-share');
    assert.equal(await code(rfs.list(shareId, 'escape')), 'outside-share');
  });

  test('absolute-looking paths stay inside the share root', async () => {
    // a leading slash is dropped, so this means <share>/etc/passwd, which does not exist
    assert.equal(await code(rfs.read(shareId, '/etc/passwd', 0, 10)), 'not-found');
  });

  test('lists without exposing blocked entries or symlinks that leave the share', async () => {
    const names = (await rfs.list(shareId, '')).map((e) => e.name);
    assert.ok(names.includes('src'));
    assert.ok(!names.includes('.ssh'));
  });

  test('refuses to share a whole drive or the home folder', () => {
    assert.throws(() => rfs.addShare(path.parse(tmp).root), /whole drive/);
    assert.throws(() => rfs.addShare(os.homedir()), /home folder/);
  });

  test('a read-only share cannot be written', async () => {
    assert.equal(await code(rfs.write(shareId, 'src/new.txt', Buffer.from('x').toString('base64'), undefined)), 'read-only');
  });
});

describe('remote folders: between two paired devices', () => {
  const A = mk('host'); // shares folders
  const B = mk('guest'); // browses them
  let fsA: RemoteFs;
  let fsB: RemoteFs;
  const dir = path.join(tmp, 'shared');
  let shareId = '';
  let stoppedA = false;

  before(async () => {
    fsA = A.remotefs;
    fsB = B.remotefs;
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'notes.txt'), 'line1\n');
    fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(2.5 * 1024 * 1024, 7));
    shareId = fsA.addShare(dir, false).id;
    await A.start();
    await B.start();
    const prompts: PairPrompt[] = [];
    A.on('pair-prompt', () => A.answerPair(true));
    B.on('pair-prompt', () => B.answerPair(true));
    void prompts;
    A.startPairing();
    await B.pairWith('127.0.0.1', A.listenPort);
    await waitFor(() => A.sessions.size === 1 && B.sessions.size === 1, 8000, 'sessions');
  });
  after(async () => {
    await B.stop();
    if (A.sessions.size || !stoppedA) await A.stop();
  });

  test('is off until the owner switches it on', async () => {
    assert.equal(fsA.enabled, false);
    assert.equal(await code(fsB.remoteShares(A.id)), 'remote-folders-off');
    fsA.setEnabled(true);
    const shares = await fsB.remoteShares(A.id);
    assert.equal(shares.length, 1);
    assert.deepEqual(Object.keys(shares[0]).sort(), ['id', 'name', 'writable']); // no local path leaks
  });

  test('browses and reads, including a file bigger than one chunk', async () => {
    const root = await fsB.remoteList(A.id, shareId, '');
    assert.deepEqual(root.map((e) => `${e.type}:${e.name}`), ['dir:docs', 'file:big.bin']);
    const notes = await fsB.remoteReadAll(A.id, shareId, 'docs/notes.txt');
    assert.equal(notes.data.toString(), 'line1\n');
    const big = await fsB.remoteReadAll(A.id, shareId, 'big.bin');
    assert.equal(big.data.length, 2.5 * 1024 * 1024);
    assert.ok(big.data.every((b) => b === 7));
  });

  test('traversal and unknown shares are refused with short error codes only', async () => {
    assert.equal(await code(fsB.remoteList(A.id, shareId, '../')), 'bad-path');
    assert.equal(await code(fsB.remoteList(A.id, 'nope', '')), 'no-such-share');
    assert.equal(await code(fsB.remoteReadAll(A.id, shareId, 'missing.txt')), 'not-found');
  });

  test('writes need an opt-in, detect conflicts, and are atomic', async () => {
    const cur = await fsB.remoteReadAll(A.id, shareId, 'docs/notes.txt');
    assert.equal(await code(fsB.remoteWrite(A.id, shareId, 'docs/notes.txt', Buffer.from('edit'), cur.mtimeMs)), 'read-only');
    fsA.setWritable(shareId, true);
    await fsB.remoteWrite(A.id, shareId, 'docs/notes.txt', Buffer.from('line1\nline2\n'), cur.mtimeMs);
    assert.equal(fs.readFileSync(path.join(dir, 'docs', 'notes.txt'), 'utf8'), 'line1\nline2\n');
    // stale mtime: someone else changed it since this editor opened it
    assert.equal(await code(fsB.remoteWrite(A.id, shareId, 'docs/notes.txt', Buffer.from('lost update'), cur.mtimeMs - 5000)), 'conflict');
    assert.equal(fs.readFileSync(path.join(dir, 'docs', 'notes.txt'), 'utf8'), 'line1\nline2\n');
    // a new file needs no mtime
    await fsB.remoteWrite(A.id, shareId, 'docs/created.txt', Buffer.from('new'));
    assert.equal(fs.readFileSync(path.join(dir, 'docs', 'created.txt'), 'utf8'), 'new');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'docs')).filter((n) => n.endsWith('.tmp')), []);
    assert.equal(await code(fsB.remoteWrite(A.id, shareId, '../escape.txt', Buffer.from('x'))), 'bad-path');
    assert.equal(fs.existsSync(path.join(tmp, 'escape.txt')), false);
  });

  test('edit-in-place sends each save back and refuses a stale one', async () => {
    fsA.setWritable(shareId, true);
    const opened: string[] = [];
    const editRoot = path.join(os.tmpdir(), 'devlink-edit-' + Date.now());
    const edit = new RemoteEdit(fsB, editRoot, (f) => void opened.push(f), () => undefined);
    const remoteFile = path.join(dir, 'docs', 'notes.txt');
    const s = await edit.start(A.id, shareId, 'docs/notes.txt', 'host');
    assert.equal(opened[0], s.local);
    assert.equal(fs.readFileSync(s.local, 'utf8'), fs.readFileSync(remoteFile, 'utf8'));
    assert.equal(fs.statSync(path.dirname(s.local)).mode & 0o077, 0, 'edit copies are private');

    fs.writeFileSync(s.local, 'edited on guest\n');
    await waitFor(() => fs.readFileSync(remoteFile, 'utf8') === 'edited on guest\n', 8000, 'save to host');
    await waitFor(() => edit.snapshot()[0].state === 'saved', 8000, 'saved state');

    // the host changes the file itself; the guest's next save must not overwrite that
    const later = new Date(Date.now() + 5000);
    fs.writeFileSync(remoteFile, 'host edit\n');
    fs.utimesSync(remoteFile, later, later);
    fs.writeFileSync(s.local, 'guest second edit\n');
    await waitFor(() => edit.snapshot()[0].state === 'error', 8000, 'conflict state');
    assert.match(edit.snapshot()[0].error ?? '', /changed on the other device/);
    assert.equal(fs.readFileSync(remoteFile, 'utf8'), 'host edit\n');
    assert.equal(fs.readFileSync(s.local, 'utf8'), 'guest second edit\n', 'the guest copy is kept');

    edit.stop(s.id);
    assert.equal(fs.existsSync(s.local), false, 'temp copy removed');
    fs.rmSync(editRoot, { recursive: true, force: true });
  });

  test('the host sees what a peer accessed, and state exposes it to the UI', () => {
    const snap = A.state().remotefs as ReturnType<RemoteFs['snapshot']>;
    assert.equal(snap.enabled, true);
    assert.ok(snap.activity.some((a) => a.op === 'list' && a.peer === 'guest'));
    assert.ok(snap.activity.some((a) => a.op === 'write' && a.path === 'docs/notes.txt'));
    assert.ok(snap.activity.some((a) => !a.ok), 'refused attempts are logged too');
  });

  test('switching off stops serving immediately; offline devices fail fast', async () => {
    fsA.setEnabled(false);
    assert.equal(await code(fsB.remoteList(A.id, shareId, '')), 'remote-folders-off');
    await A.stop();
    stoppedA = true;
    await waitFor(() => B.sessions.size === 0, 8000, 'disconnect');
    assert.equal(await code(fsB.remoteShares(A.id)), 'device is offline');
  });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));
