import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Core, PairPrompt } from '../main/core';
import { sanitizeRelPath } from '../main/files';
import { handshake } from '../main/protocol';
import type { ClipboardAdapter } from '../main/clipboard';

class FakeClipboard implements ClipboardAdapter {
  text = '';
  png: Buffer | null = null;
  async readText() { return this.text; }
  async writeText(t: string) { this.text = t; }
  async readImagePng() { return this.png; }
  async writeImagePng(b: Buffer) { this.png = b; this.text = ''; }
}

async function waitFor(cond: () => boolean, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlink-test-'));
function mk(name: string) {
  const clip = new FakeClipboard();
  const core = new Core({
    dir: path.join(tmp, name, 'cfg'),
    clipboard: clip,
    discovery: false,
    log: process.env.DL_DEBUG ? (m: string) => console.log(Date.now() % 100000, name, m) : undefined,
    defaults: { deviceName: name, listenPort: 0, downloadsDir: path.join(tmp, name, 'dl') },
  });
  return { core, clip };
}

describe('pairing, clipboard, files, ports', () => {
  const A = mk('alpha');
  const B = mk('beta');
  const prompts: Record<string, PairPrompt> = {};

  before(async () => {
    (A.core as any).clipboard.pollMs = 50;
    await A.core.start();
    await B.core.start();
  });
  after(async () => {
    await A.core.stop();
    await B.core.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('refuses pairing unless enabled, and unknown devices in normal mode', async () => {
    await assert.rejects(B.core.pairWith('127.0.0.1', A.core.listenPort), /pairing-disabled|closed|reset/);
    const sock = net.connect(A.core.listenPort, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    const stranger = mk('stranger').core;
    await assert.rejects(
      handshake(sock, 'initiator', {
        identity: stranger.store.identity, deviceName: 's', os: 'x', listenPort: 1, mode: 'normal',
      }),
      /unknown-device/,
    );
    await stranger.stop();
  });

  test('pairs with matching 6 digit codes and connects', async () => {
    A.core.on('pair-prompt', (p: PairPrompt) => { prompts.A = p; });
    B.core.on('pair-prompt', (p: PairPrompt) => { prompts.B = p; });
    A.core.startPairing();
    const pairing = B.core.pairWith('127.0.0.1', A.core.listenPort);
    await waitFor(() => !!prompts.A && !!prompts.B, 8000, 'both prompts');
    assert.match(prompts.A.sas, /^\d{6}$/);
    assert.equal(prompts.A.sas, prompts.B.sas);
    assert.equal(prompts.A.peer.name, 'beta');
    assert.equal(prompts.B.peer.id, A.core.id);
    A.core.answerPair(true);
    B.core.answerPair(true);
    await pairing;
    await waitFor(() => A.core.sessions.size === 1 && B.core.sessions.size === 1, 8000, 'sessions');
    assert.equal(A.core.store.peers.length, 1);
    assert.equal(A.core.pairingEnabled(), false);
  });

  test('declined pairing stores nothing', async () => {
    const C = mk('gamma');
    await C.core.start();
    const seen: PairPrompt[] = [];
    A.core.on('pair-prompt', (p: PairPrompt) => { seen.push(p); A.core.answerPair(false); });
    C.core.on('pair-prompt', () => C.core.answerPair(true));
    A.core.startPairing();
    await assert.rejects(C.core.pairWith('127.0.0.1', A.core.listenPort), /pair-declined|closed|reset/);
    assert.equal(A.core.store.peers.length, 1);
    A.core.removeAllListeners('pair-prompt');
    A.core.stopPairing();
    await C.core.stop();
  });

  test('clipboard text mirrors both ways without echo loops', async () => {
    A.clip.text = 'hello from alpha';
    await waitFor(() => B.clip.text === 'hello from alpha', 8000, 'clip A->B');
    B.clip.text = 'reply from beta';
    await waitFor(() => A.clip.text === 'reply from beta', 8000, 'clip B->A');
    await new Promise((r) => setTimeout(r, 1800));
    assert.equal(A.clip.text, 'reply from beta');
    assert.equal(B.clip.text, 'reply from beta');
    assert.equal(B.core.clipboard.log.filter((e) => e.dir === 'out').length, 1);
  });

  test('sends a folder and a big file, never overwriting', async () => {
    const src = path.join(tmp, 'src');
    fs.mkdirSync(path.join(src, 'proj', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'proj', 'a.txt'), 'aaa');
    fs.writeFileSync(path.join(src, 'proj', 'sub', 'b.bin'), Buffer.alloc(300_000, 7));
    fs.writeFileSync(path.join(src, 'proj', 'empty.txt'), '');
    const big = path.join(src, 'big.dat');
    fs.writeFileSync(big, Buffer.alloc(5 * 1024 * 1024, 1));
    await A.core.files.sendPaths(B.core.id, [path.join(src, 'proj'), big]);
    const root = path.join(tmp, 'beta', 'dl', 'alpha');
    await waitFor(() => A.core.files.snapshot().every((t) => t.state === 'done') && B.core.files.snapshot().length === 2 && B.core.files.snapshot().every((t) => t.state === 'done'), 8000, 'transfers');
    assert.equal(fs.readFileSync(path.join(root, 'proj', 'a.txt'), 'utf8'), 'aaa');
    assert.equal(fs.statSync(path.join(root, 'proj', 'sub', 'b.bin')).size, 300_000);
    assert.equal(fs.statSync(path.join(root, 'big.dat')).size, 5 * 1024 * 1024);
    await A.core.files.sendPaths(B.core.id, [big]);
    await waitFor(() => fs.existsSync(path.join(root, 'big (1).dat')) && fs.statSync(path.join(root, 'big (1).dat')).size === 5 * 1024 * 1024, 8000, 'no-overwrite copy');
  });

  test('forwards a TCP port through the encrypted tunnel', async () => {
    const echo = net.createServer((s) => s.on('data', (d) => s.write(Buffer.from(d.toString().toUpperCase()))));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    const remotePort = (echo.address() as net.AddressInfo).port;
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const localPort = (probe.address() as net.AddressInfo).port;
    await new Promise((r) => probe.close(r));
    B.core.forwards.add(A.core.id, localPort, remotePort);
    await waitFor(() => B.core.forwards.snapshot()[0]?.listening === true, 5000, 'listener');
    const c = net.connect(localPort, '127.0.0.1');
    const got = await new Promise<string>((resolve, reject) => {
      c.on('error', reject);
      c.write('ping through tunnel');
      c.once('data', (d) => resolve(d.toString()));
    });
    assert.equal(got, 'PING THROUGH TUNNEL');
    c.destroy();
    // a port nobody listens on closes the local connection instead of hanging
    const dead = net.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = (dead.address() as net.AddressInfo).port;
    await new Promise((r) => dead.close(r));
    const lp2 = localPort + 1;
    B.core.forwards.add(A.core.id, lp2, deadPort);
    await waitFor(() => B.core.forwards.snapshot()[1]?.listening === true, 5000, 'listener 2');
    const c2 = net.connect(lp2, '127.0.0.1');
    await new Promise((r) => c2.once('close', r));
    echo.close();
  });

  test('status is exchanged and reconnects after a dropped session', async () => {
    await waitFor(() => !!B.core.status.get(A.core.id), 8000, 'status');
    assert.equal(B.core.status.get(A.core.id)!.hostname, os.hostname());
    B.core.sessions.get(A.core.id)!.close();
    await waitFor(() => A.core.sessions.size === 0 || B.core.sessions.size === 0, 3000, 'drop');
    await waitFor(() => A.core.sessions.size === 1 && B.core.sessions.size === 1, 15000, 'reconnect');
  });

  test('unpairing disconnects and forgets the device', async () => {
    A.core.unpair(B.core.id);
    await waitFor(() => A.core.sessions.size === 0, 3000, 'disconnect');
    assert.equal(A.core.store.peers.length, 0);
    await new Promise((r) => setTimeout(r, 5500));
    assert.equal(A.core.sessions.size, 0, 'a forgotten device must not be allowed back in');
  });
});

describe('sanitizeRelPath', () => {
  test('neutralises traversal and Windows-hostile names', () => {
    const s = path.sep;
    assert.equal(sanitizeRelPath('../../etc/passwd'), ['etc', 'passwd'].join(s));
    assert.equal(sanitizeRelPath('/abs/olute\\x'), ['abs', 'olute', 'x'].join(s));
    assert.equal(sanitizeRelPath('CON'), '_CON');
    assert.equal(sanitizeRelPath('a:b?.txt'), 'a_b_.txt');
    assert.equal(sanitizeRelPath('trailing. '), 'trailing');
    assert.equal(sanitizeRelPath('..'), 'file');
  });
});
