import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Core } from '../main/core';
import { cleanUrl } from '../main/links';
import { handshake } from '../main/protocol';

const clip = { readText: async () => '', writeText: async () => {}, readImagePng: async () => null, writeImagePng: async () => {} };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlink-share-'));
async function waitFor(cond: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('cleanUrl', () => {
  test('allows only plain web links', () => {
    assert.equal(cleanUrl('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
    assert.equal(cleanUrl('http://localhost:3000'), 'http://localhost:3000/');
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'vscode://x', 'https://user:pw@host/', 'not a url', '', 42, 'https://' + 'a'.repeat(5000)])
      assert.equal(cleanUrl(bad), null, String(bad));
  });
});

describe('links, browser bridge and screen view between two devices', () => {
  const opened: string[] = [];
  const mk = (name: string, extra: Record<string, unknown>, openUrl?: (u: string) => void) =>
    new Core({ dir: path.join(tmp, name), clipboard: clip, discovery: false, openUrl, defaults: { deviceName: name, listenPort: 0, ...extra } });
  const A = mk('mac', { browserBridge: true, browserBridgePort: 0 });
  const B = mk('win', { acceptLinks: true, allowScreenView: true }, (u) => opened.push(u));

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

  test('sent links open on the other device; unsafe ones are dropped', async () => {
    const n = A.links.send(B.id, ['https://example.com/', 'javascript:alert(1)', 'https://github.com/AYUSHB17/devlink']);
    assert.equal(n, 2);
    await waitFor(() => opened.length === 2, 'opened');
    assert.deepEqual(opened, ['https://example.com/', 'https://github.com/AYUSHB17/devlink']);
    await waitFor(() => A.links.log.every((e) => e.state === 'opened'), 'acknowledged');
  });

  test('links are refused when the receiver has them turned off', async () => {
    B.store.updateSettings({ acceptLinks: false });
    const failed: any[] = [];
    A.on('links-failed', (e) => failed.push(e));
    A.links.send(B.id, ['https://example.org/']);
    await waitFor(() => failed.length === 1, 'refusal');
    assert.match(failed[0].reason, /turned off/);
    assert.equal(opened.length, 2);
    B.store.updateSettings({ acceptLinks: true });
  });

  test('browser bridge: token required, web pages refused, sends tabs', async () => {
    const base = `http://127.0.0.1:${A.bridge.port}`;
    const token = A.store.settings.browserBridgeToken;
    assert.ok(token.length >= 32);
    assert.equal((await fetch(`${base}/v1/devices`)).status, 401);
    assert.equal((await fetch(`${base}/v1/devices`, { headers: { 'x-devlink-token': 'nope' } })).status, 401);
    assert.equal((await fetch(`${base}/v1/devices`, { headers: { 'x-devlink-token': token, origin: 'https://evil.example' } })).status, 403);
    const list = await (await fetch(`${base}/v1/devices`, { headers: { 'x-devlink-token': token } })).json();
    assert.deepEqual(list.devices.map((d: any) => d.name), ['win']);
    const r = await fetch(`${base}/v1/send`, {
      method: 'POST',
      headers: { 'x-devlink-token': token, 'content-type': 'application/json', origin: 'chrome-extension://abcdefghijklmnop' },
      body: JSON.stringify({ urls: ['https://nodejs.org/', 'file:///etc/hosts'] }),
    });
    assert.deepEqual(await r.json(), { sent: 1 });
    await waitFor(() => opened.includes('https://nodejs.org/'), 'tab opened on the other device');
  });

  test('screen view needs approval on the shared device, then relays signalling', async () => {
    const events: string[] = [];
    A.screen.on('view-open', () => events.push('view-open'));
    B.screen.on('consent', () => events.push('consent'));
    const started: string[] = [];
    B.screen.on('share-start', (sid) => started.push(sid));
    const sid = A.screen.request(B.id);
    await waitFor(() => B.screen.snapshot().prompt !== null, 'consent prompt');
    assert.deepEqual(events, ['view-open', 'consent']);
    assert.equal(started.length, 0, 'nothing is captured before approval');
    B.screen.answerConsent(true);
    await waitFor(() => started.length === 1, 'sharing starts');
    assert.equal(started[0], sid);
    assert.equal(B.screen.isSharing(), 'mac');
    // signalling goes both ways, only for that stream
    const atA: unknown[] = [];
    const atB: unknown[] = [];
    A.screen.on('signal', (s, d) => s === sid && atA.push(d));
    B.screen.on('signal', (s, d) => s === sid && atB.push(d));
    A.screen.relay(sid, { type: 'ready' });
    B.screen.relay(sid, { type: 'offer', sdp: 'v=0' });
    await waitFor(() => atA.length === 1 && atB.length === 1, 'signals');
    assert.deepEqual(atB[0], { type: 'ready' });
    assert.deepEqual(atA[0], { type: 'offer', sdp: 'v=0' });
    // the viewer closes its window: the sharer stops too
    const stopped: string[] = [];
    B.screen.on('stopped', (s) => stopped.push(s));
    A.screen.stop(sid);
    await waitFor(() => stopped.includes(sid), 'sharer stopped');
    assert.equal(B.screen.isSharing(), null);
  });

  test('same connection is not asked twice; turning the setting off refuses', async () => {
    const sid2 = A.screen.request(B.id);
    await waitFor(() => B.screen.isSharing() !== null, 'shares without asking again');
    assert.equal(B.screen.snapshot().prompt, null);
    B.store.updateSettings({ allowScreenView: false });
    B.screen.settingsChanged();
    await waitFor(() => !A.screen.snapshot().viewing.some((v) => v.sid === sid2), 'viewer notified');
    const reasons: string[] = [];
    A.screen.on('stopped', (_s, why) => reasons.push(why));
    A.screen.request(B.id);
    await waitFor(() => reasons.length === 1, 'denied');
    assert.match(reasons[0], /turned off/);
  });

  test('bridge refuses a rebinding Host header and a second extension', async () => {
    const token = A.store.settings.browserBridgeToken;
    const get = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: A.bridge.port, path: '/v1/devices', headers: { 'x-devlink-token': token, ...headers } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
    assert.equal(await get({ host: 'attacker.example:47823' }), 403);
    assert.equal(await get({ origin: 'chrome-extension://abcdefghijklmnop' }), 200, 'the pinned extension still works');
    assert.equal(await get({ origin: 'chrome-extension://someotherextension' }), 403);
    A.bridge.newToken();
    assert.equal(A.store.settings.browserBridgeOrigin, '', 'a new token forgets the pinned extension');
  });

  test('a replaced connection ends screen sharing and forgets consent', async () => {
    B.store.updateSettings({ allowScreenView: true });
    // consent from earlier in this connection still holds
    A.screen.request(B.id);
    await waitFor(() => B.screen.isSharing() !== null, 'sharing');
    // B opens a second connection, which replaces the first on both sides
    const sock = await (B as any).connect('127.0.0.1', A.listenPort);
    const r = await handshake(sock, 'initiator', (B as any).ctx({ mode: 'normal', expectId: A.id }));
    B.adopt(r.session);
    await waitFor(() => B.screen.isSharing() === null && A.screen.snapshot().viewing.length === 0, 'stream ended');
    await waitFor(() => A.sessions.size === 1 && B.sessions.size === 1 && !A.sessions.get(B.id)!.closed, 'new session');
    A.screen.request(B.id);
    await waitFor(() => B.screen.snapshot().prompt !== null, 'asks again on the new connection');
  });

  test('consent clicks are ignored while this machine is being remote controlled', async () => {
    const input = B.input as any;
    const saved = input.m;
    input.m = { mode: 'following', peer: A.id };
    B.screen.answerConsent(true);
    assert.notEqual(B.screen.snapshot().prompt, null, 'still asking');
    assert.equal(B.screen.isSharing(), null);
    input.m = saved;
    B.screen.answerConsent(true);
    await waitFor(() => B.screen.isSharing() !== null, 'shares after a real answer');
    B.screen.stopAll();
  });

  test('declined consent refuses this connection without asking again', async () => {
    // a fresh connection so consent is unknown again
    const oldA = A.sessions.get(B.id);
    const sock = await (B as any).connect('127.0.0.1', A.listenPort);
    B.adopt((await handshake(sock, 'initiator', (B as any).ctx({ mode: 'normal', expectId: A.id }))).session);
    await waitFor(() => !!A.sessions.get(B.id) && A.sessions.get(B.id) !== oldA && B.sessions.size === 1, 'new session on both sides');
    const reasons: string[] = [];
    A.screen.on('stopped', (_s, why) => reasons.push(why));
    A.screen.request(B.id);
    await waitFor(() => B.screen.snapshot().prompt !== null, 'prompt');
    B.screen.answerConsent(false);
    await waitFor(() => reasons.length === 1, 'denied');
    assert.match(reasons[0], /declined/);
    A.screen.request(B.id);
    await waitFor(() => reasons.length === 2, 'denied again');
    assert.equal(B.screen.snapshot().prompt, null, 'no second prompt');
  });

  test('requests queued behind one prompt cannot exceed the sharing limit', async () => {
    const oldA = A.sessions.get(B.id);
    const sock = await (B as any).connect('127.0.0.1', A.listenPort);
    B.adopt((await handshake(sock, 'initiator', (B as any).ctx({ mode: 'normal', expectId: A.id }))).session);
    await waitFor(() => !!A.sessions.get(B.id) && A.sessions.get(B.id) !== oldA && B.sessions.size === 1, 'fresh connection');
    const started: string[] = [];
    B.screen.on('share-start', (sid) => started.push(sid));
    for (let i = 0; i < 10; i++) A.screen.request(B.id);
    await waitFor(() => B.screen.snapshot().prompt !== null, 'prompt');
    await new Promise((r) => setTimeout(r, 100));
    B.screen.answerConsent(true);
    await waitFor(() => started.length > 0, 'some start');
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(started.length <= 3, `started ${started.length}`);
    B.screen.stopAll();
  });
});
