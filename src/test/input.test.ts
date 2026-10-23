import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Core } from '../main/core';
import type { HelperCommand, HelperEvent, InputBackend } from '../main/input';

class FakeHelper extends EventEmitter implements InputBackend {
  running = false;
  cmds: HelperCommand[] = [];
  start() { this.running = true; }
  stop() { this.running = false; }
  send(c: HelperCommand) { this.cmds.push(c); }
  fire(e: HelperEvent) { this.emit('event', e); }
  of<K extends HelperCommand['cmd']>(cmd: K) { return this.cmds.filter((c) => c.cmd === cmd) as Extract<HelperCommand, { cmd: K }>[]; }
}

const clip = { readText: async () => '', writeText: async () => {}, readImagePng: async () => null, writeImagePng: async () => {} };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlink-input-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(10);
  }
}

function mk(name: string, defaults: Record<string, unknown>) {
  const helper = new FakeHelper();
  const core = new Core({
    dir: path.join(tmp, name),
    clipboard: clip,
    discovery: false,
    inputBackend: helper,
    defaults: { deviceName: name, listenPort: 0, clipboardOnCross: false, ...defaults },
  });
  return { core, helper };
}

describe('shared mouse & keyboard', () => {
  const A = mk('mac', { inputSharing: true });
  const B = mk('win', { allowRemoteInput: true });

  before(async () => {
    await A.core.start();
    await B.core.start();
    A.core.on('pair-prompt', () => A.core.answerPair(true));
    B.core.on('pair-prompt', () => B.core.answerPair(true));
    A.core.startPairing();
    await B.core.pairWith('127.0.0.1', A.core.listenPort);
    await waitFor(() => A.core.sessions.size === 1 && B.core.sessions.size === 1, 'sessions');
    A.core.input.setLayout(B.core.id, 'right');
    // the peer's layout is only a suggestion until the local user accepts it
    await waitFor(() => (B.core.input.snapshot().layoutSuggestions as any)[A.core.id] === 'left', 'suggested layout');
    assert.equal(B.core.store.settings.inputLayout[A.core.id], undefined);
    B.core.input.setLayout(A.core.id, 'left');
    await waitFor(() => B.core.store.settings.inputLayout[A.core.id] === 'left', 'accepted layout');
    await waitFor(() => A.core.input.snapshot().peerAllows[B.core.id] === true, 'hello');
  });
  after(async () => {
    await A.core.stop();
    await B.core.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(() => {
    A.helper.cmds = [];
    B.helper.cmds = [];
  });

  test('layout is mirrored and both helpers watch the shared edge', () => {
    assert.equal(A.core.store.settings.inputLayout[B.core.id], 'right');
    assert.equal(B.core.store.settings.inputLayout[A.core.id], 'left');
    assert.ok(A.helper.running && B.helper.running);
  });

  test('the follower must approve control once per connection', async () => {
    A.helper.fire({ ev: 'edge', side: 'right', pos: 0.5, buttons: 0 });
    await waitFor(() => B.core.input.snapshot().consentPrompt !== null, 'consent prompt');
    await waitFor(() => A.core.input.mode.mode === 'local', 'denied until approved');
    assert.equal(B.core.input.mode.mode, 'local');
    assert.match(A.core.input.notice, /waiting for approval/);
    B.core.input.answerConsent(true);
    await waitFor(() => /allowed control/.test(A.core.input.notice), 'consent reaches leader');
    assert.equal(B.core.input.snapshot().consentPrompt, null);
  });

  test('cursor crosses at the edge, input flows, and comes back', async () => {
    A.helper.fire({ ev: 'edge', side: 'right', pos: 0.25, buttons: 0 });
    assert.equal(A.core.input.mode.mode, 'leading');
    assert.deepEqual(A.helper.of('capture').at(-1), { cmd: 'capture', on: true });
    await waitFor(() => B.core.input.mode.mode === 'following', 'follower');
    assert.deepEqual(B.helper.of('enter').at(-1), { cmd: 'enter', side: 'left', pos: 0.25 });

    // moves are coalesced, keys and buttons keep their order relative to moves
    A.helper.fire({ ev: 'move', dx: 3, dy: 1 });
    A.helper.fire({ ev: 'move', dx: 4, dy: -2 });
    A.helper.fire({ ev: 'button', b: 0, down: true });
    A.helper.fire({ ev: 'key', hid: 0x04, down: true });
    await waitFor(() => B.helper.of('key').length === 1, 'key');
    const seq = B.helper.cmds.filter((c) => ['move', 'button', 'key'].includes(c.cmd));
    assert.deepEqual(seq, [
      { cmd: 'move', dx: 7, dy: -1 },
      { cmd: 'button', b: 0, down: true },
      { cmd: 'key', hid: 0x04, down: true },
    ]);

    // follower's injected cursor reaches the edge facing the leader
    B.helper.fire({ ev: 'edge', side: 'left', pos: 0.8, buttons: 0 });
    assert.equal(B.core.input.mode.mode, 'local');
    assert.ok(B.helper.of('release_all').length >= 1, 'follower lets go of held keys');
    await waitFor(() => A.core.input.mode.mode === 'local', 'leader back');
    assert.deepEqual(A.helper.of('capture').at(-1), { cmd: 'capture', on: false });
    assert.deepEqual(A.helper.of('enter').at(-1), { cmd: 'enter', side: 'right', pos: 0.8 });
  });

  test('Cmd and Ctrl swap between macOS and Windows', async () => {
    // pretend the peers run different OSes (both run on this machine in tests)
    const recA = B.core.store.getPeer(A.core.id)!;
    B.core.store.putPeer({ ...recA, os: process.platform === 'win32' ? 'macOS' : 'Windows' });
    A.helper.fire({ ev: 'edge', side: 'right', pos: 0.5, buttons: 0 });
    await waitFor(() => B.core.input.mode.mode === 'following', 'follower');
    A.helper.fire({ ev: 'key', hid: 0xe3, down: true }); // left GUI (Cmd)
    A.helper.fire({ ev: 'key', hid: 0x06, down: true }); // c
    await waitFor(() => B.helper.of('key').length === 2, 'keys');
    assert.deepEqual(B.helper.of('key').map((k) => k.hid), [0xe0, 0x06]); // became left Ctrl
    B.core.store.putPeer(recA);
    A.helper.fire({ ev: 'hotkey' });
    await waitFor(() => B.core.input.mode.mode === 'local' && A.core.input.mode.mode === 'local', 'hotkey release');
  });

  test('no crossing while a mouse button is held (that is a drag)', () => {
    A.helper.fire({ ev: 'edge', side: 'right', pos: 0.5, buttons: 1 });
    assert.equal(A.core.input.mode.mode, 'local');
    A.helper.fire({ ev: 'edge', side: 'left', pos: 0.5, buttons: 0 }); // nobody there
    assert.equal(A.core.input.mode.mode, 'local');
  });

  test('touching the follower mouse takes control back', async () => {
    A.helper.fire({ ev: 'edge', side: 'right', pos: 0.5, buttons: 0 });
    await waitFor(() => B.core.input.mode.mode === 'following', 'follower');
    B.helper.fire({ ev: 'local_activity' });
    await waitFor(() => A.core.input.mode.mode === 'local', 'leader released');
    assert.equal(B.core.input.mode.mode, 'local');
    assert.deepEqual(A.helper.of('capture').at(-1), { cmd: 'capture', on: false });
  });

  test('silence from the follower releases the leader quickly', async () => {
    A.helper.fire({ ev: 'edge', side: 'right', pos: 0.5, buttons: 0 });
    await waitFor(() => B.core.input.mode.mode === 'following', 'follower');
    // simulate a dead link: the follower's heartbeats stop arriving
    const send = B.core.send.bind(B.core);
    (B.core as any).send = (id: string, msg: any) => (msg?.t === 'input-hb' ? true : send(id, msg));
    await waitFor(() => A.core.input.mode.mode === 'local', 'leader released', 4000);
    assert.match(A.core.input.notice, /lost contact/);
    (B.core as any).send = send;
    await waitFor(() => B.core.input.mode.mode === 'local', 'follower released too', 4000);
  });

  test('a new session clears the previous "lost contact" notice on both sides', async () => {
    A.helper.fire({ ev: 'edge', side: 'right', pos: 0.5, buttons: 0 });
    await waitFor(() => B.core.input.mode.mode === 'following', 'follower');
    const send = B.core.send.bind(B.core);
    (B.core as any).send = (id: string, msg: any) => (msg?.t === 'input-hb' ? true : send(id, msg));
    await waitFor(() => A.core.input.mode.mode === 'local', 'leader released', 4000);
    (B.core as any).send = send;
    await waitFor(() => B.core.input.mode.mode === 'local', 'follower released too', 4000);
    B.core.input.notice = 'lost contact with the other device';
    assert.match(A.core.input.notice, /lost contact/);
    A.helper.fire({ ev: 'edge', side: 'right', pos: 0.5, buttons: 0 });
    await waitFor(() => B.core.input.mode.mode === 'following', 'follower again');
    assert.equal(A.core.input.notice, '');
    assert.equal(B.core.input.notice, '');
  });

  test("the helper's watchdog release ends control on both sides", async () => {
    A.helper.fire({ ev: 'edge', side: 'right', pos: 0.5, buttons: 0 });
    await waitFor(() => B.core.input.mode.mode === 'following', 'follower');
    A.helper.fire({ ev: 'released', reason: 'DevLink stopped responding' });
    assert.equal(A.core.input.mode.mode, 'local');
    await waitFor(() => B.core.input.mode.mode === 'local', 'follower released');
  });

  test('refused when the other machine does not allow control', async () => {
    B.core.store.updateSettings({ allowRemoteInput: false });
    B.core.input.announce();
    await waitFor(() => A.core.input.snapshot().peerAllows[B.core.id] === false, 'hello off');
    A.helper.fire({ ev: 'edge', side: 'right', pos: 0.5, buttons: 0 });
    assert.equal(A.core.input.mode.mode, 'local');
    assert.match(A.core.input.notice, /doesn't allow/);
    // even if the leader has stale information, the follower refuses
    (A.core.input as any).peerAllows.set(B.core.id, true);
    A.helper.fire({ ev: 'edge', side: 'right', pos: 0.5, buttons: 0 });
    await waitFor(() => A.core.input.mode.mode === 'local', 'denied');
    assert.match(A.core.input.notice, /turned off/);
    assert.equal(B.core.input.mode.mode, 'local');
    B.core.store.updateSettings({ allowRemoteInput: true });
    B.core.input.announce();
    await waitFor(() => A.core.input.snapshot().peerAllows[B.core.id] === true, 'hello on');
  });

  test('dropping the connection releases both sides', async () => {
    A.helper.fire({ ev: 'edge', side: 'right', pos: 0.5, buttons: 0 });
    await waitFor(() => B.core.input.mode.mode === 'following', 'follower');
    A.core.sessions.get(B.core.id)!.close();
    await waitFor(() => A.core.input.mode.mode === 'local' && B.core.input.mode.mode === 'local', 'both local');
    assert.deepEqual(A.helper.of('capture').at(-1), { cmd: 'capture', on: false });
    assert.ok(B.helper.of('release_all').length >= 1);
    // a new connection must be approved again
    await waitFor(() => A.core.sessions.size === 1 && B.core.sessions.size === 1, 'reconnect', 15000);
    await waitFor(() => A.core.input.snapshot().peerAllows[B.core.id] === true, 'hello after reconnect');
    A.helper.fire({ ev: 'edge', side: 'right', pos: 0.5, buttons: 0 });
    await waitFor(() => B.core.input.snapshot().consentPrompt !== null, 'asks again');
    assert.equal(B.core.input.mode.mode, 'local');
  });

  test('injected keys outside the HID keyboard range are dropped', async () => {
    B.core.input.answerConsent(true);
    await waitFor(() => /allowed control/.test(A.core.input.notice), 'consent');
    A.helper.fire({ ev: 'edge', side: 'right', pos: 0.5, buttons: 0 });
    await waitFor(() => B.core.input.mode.mode === 'following', 'follower');
    B.helper.cmds = [];
    A.core.send(B.core.id, { t: 'input-ev', e: [['k', 0x1234, 1], ['k', 0x02, 1], ['b', 9, 1], ['k', 0x04, 1]] });
    await waitFor(() => B.helper.of('key').length === 1, 'valid key');
    assert.deepEqual(B.helper.of('key'), [{ cmd: 'key', hid: 0x04, down: true }]);
    assert.equal(B.helper.of('button').length, 0);
  });
});
