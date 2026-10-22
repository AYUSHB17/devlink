import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Core } from '../main/core';

const clip = { readText: async () => '', writeText: async () => {}, readImagePng: async () => null, writeImagePng: async () => {} };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlink-files-'));
async function waitFor(cond: () => boolean, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const mk = (name: string, acceptFiles: boolean) =>
  new Core({
    dir: path.join(tmp, name, 'cfg'),
    clipboard: clip,
    discovery: false,
    defaults: { deviceName: name, listenPort: 0, acceptFiles, downloadsDir: path.join(tmp, name, 'dl') },
  });

describe('file transfer flow control', () => {
  const A = mk('sender', true);
  const B = mk('receiver', false);
  before(async () => {
    await A.start();
    await B.start();
    A.on('pair-prompt', () => A.answerPair(true));
    B.on('pair-prompt', () => B.answerPair(true));
    A.startPairing();
    await B.pairWith('127.0.0.1', A.listenPort);
    await waitFor(() => A.sessions.size === 1 && B.sessions.size === 1, 'sessions');
  });
  after(async () => {
    await A.stop();
    await B.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a refused folder stops after one reject instead of streaming every file', async () => {
    const dir = path.join(tmp, 'src', 'many');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(dir, `f${i}.bin`), Buffer.alloc(50_000, i));
    const sent: string[] = [];
    const send = B.send.bind(B);
    (B as any).send = (id: string, msg: any) => (sent.push(msg?.t), send(id, msg));
    await A.files.sendPaths(B.id, [dir]);
    const t = A.files.snapshot()[0];
    assert.equal(t.state, 'error');
    assert.match(t.error ?? '', /receiving is turned off/);
    assert.ok(t.filesDone < 200, `stopped early (sent ${t.filesDone} files)`);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sent.filter((x) => x === 'file-reject').length, 1);
    (B as any).send = send;
  });
});
