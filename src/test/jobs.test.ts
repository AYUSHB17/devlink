import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Core, PairPrompt } from '../main/core';
import { buildEnv, checkRequest, displayCommand, JobError, parseArgv, planSpawn } from '../main/jobs';
import type { ClipboardAdapter } from '../main/clipboard';

const noClip: ClipboardAdapter = {
  readText: async () => '',
  writeText: async () => undefined,
  readImagePng: async () => null,
  writeImagePng: async () => undefined,
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlink-jobs-'));
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

const code = (fn: () => unknown): string => {
  try {
    fn();
    return 'ok';
  } catch (e: any) {
    return e instanceof JobError ? e.code : e.message;
  }
};

const node = process.execPath;
const id = 'a'.repeat(16);

describe('jobs: request validation', () => {
  const base = { ws: 'w', argv: ['node', '-v'] };

  test('parseArgv splits on spaces and quotes, no shell syntax', () => {
    assert.deepEqual(parseArgv('npm test -- --grep "a b"'), ['npm', 'test', '--', '--grep', 'a b']);
    assert.deepEqual(parseArgv(`echo 'x y' ""`), ['echo', 'x y', '']);
    assert.deepEqual(parseArgv('echo a;b|c'), ['echo', 'a;b|c']);
    assert.throws(() => parseArgv('echo "oops'), /unclosed-quote/);
  });

  test('accepts a plain request and fills defaults', () => {
    const r = checkRequest(id, base);
    assert.equal(r.wallSec, 600);
    assert.deepEqual(r.cwd, []);
  });

  test('rejects malformed ids, argv, env, paths and limits', () => {
    assert.equal(code(() => checkRequest('nope', base)), 'bad-id');
    assert.equal(code(() => checkRequest(id, { ...base, argv: [] })), 'bad-argv');
    assert.equal(code(() => checkRequest(id, { ...base, argv: ['a\u0000b'] })), 'bad-argv');
    assert.equal(code(() => checkRequest(id, { ...base, argv: ['x', 5] })), 'bad-argv');
    assert.equal(code(() => checkRequest(id, { ...base, argv: [''] })), 'bad-argv');
    assert.equal(code(() => checkRequest(id, { ...base, argv: new Array(65).fill('x') })), 'bad-argv');
    assert.equal(code(() => checkRequest(id, { ...base, argv: ['x'.repeat(5000)] })), 'bad-argv');
    assert.equal(code(() => checkRequest(id, { ...base, env: { PATH: '/evil' } })), 'env-not-allowed');
    assert.equal(code(() => checkRequest(id, { ...base, env: { NODE_OPTIONS: '--require x' } })), 'env-not-allowed');
    assert.equal(code(() => checkRequest(id, { ...base, env: { CI: 1 } })), 'bad-env');
    assert.equal(code(() => checkRequest(id, { ...base, cwd: '../up' })), 'bad-path');
    assert.equal(code(() => checkRequest(id, { ...base, cwd: 'a/.ssh' })), 'blocked');
    assert.equal(code(() => checkRequest(id, { ...base, wallSec: 0 })), 'bad-limit');
    assert.equal(code(() => checkRequest(id, { ...base, wallSec: 99999 })), 'bad-limit');
    assert.equal(code(() => checkRequest(id, { ...base, ws: 5 })), 'bad-workspace');
    assert.equal(code(() => checkRequest(id, null)), 'bad-request');
  });

  test('the job environment is built from a fixed list, not forwarded', () => {
    const env = buildEnv({ CI: '1' }, { PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'x', GITHUB_TOKEN: 'y', HOME: '/h' });
    assert.deepEqual(env, { PATH: '/bin', HOME: '/h', CI: '1' });
  });

  test('Windows .cmd shims only get shell-inert arguments', () => {
    const env = { PATH: '' };
    assert.equal(planSpawn(['npm.cmd', 'test', '--grep=foo'], env, 'win32').shell, true);
    assert.equal(code(() => planSpawn(['npm.cmd', 'test', 'a&calc'], env, 'win32')), 'unsafe-for-cmd');
    assert.equal(code(() => planSpawn(['npm.cmd', 'test', '%PATH%'], env, 'win32')), 'unsafe-for-cmd');
    assert.equal(code(() => planSpawn(['build.bat', 'a b'], env, 'win32')), 'unsafe-for-cmd');
    // a real executable needs no shell, so any argument is fine
    assert.deepEqual(planSpawn(['node.exe', 'a&b', 'x y'], env, 'win32'), { file: 'node.exe', args: ['a&b', 'x y'], shell: false });
    assert.equal(planSpawn(['ls', '-la'], env, 'linux').shell, false);
  });

  test('prompts show token boundaries and neutralise direction overrides', () => {
    assert.equal(displayCommand(['npm', 'test', 'a b']), 'npm test "a b"');
    assert.ok(!displayCommand(['echo', '‮txt.exe']).includes('‮'));
  });
});

describe('jobs: between two paired devices', () => {
  const A = mk('requester');
  const B = mk('worker');
  const ws = path.join(tmp, 'project');
  const sub = path.join(ws, 'sub');
  let wsId = '';

  /** Answers the prompt on the worker, as its user would in its own window. */
  const approve = async (decision: 'deny' | 'once' | 'session') => {
    await waitFor(() => !!B.jobs.snapshot().prompt, 8000, 'prompt');
    B.jobs.answer(B.jobs.snapshot().prompt!.id, decision);
  };
  const js = (src: string) => [node, '-e', src];
  const run = (argv: string[], extra: Record<string, unknown> = {}) => A.jobs.run(B.id, { ws: wsId, argv, ...extra });

  before(async () => {
    fs.mkdirSync(sub, { recursive: true });
    await A.start();
    await B.start();
    const prompts: Record<string, PairPrompt> = {};
    A.on('pair-prompt', (p: PairPrompt) => (prompts.A = p));
    B.on('pair-prompt', (p: PairPrompt) => (prompts.B = p));
    B.startPairing();
    const pairing = A.pairWith('127.0.0.1', B.listenPort);
    await waitFor(() => !!prompts.A && !!prompts.B, 8000, 'pair prompts');
    A.answerPair(true);
    B.answerPair(true);
    await pairing;
    await waitFor(() => A.sessions.size === 1 && B.sessions.size === 1, 8000, 'sessions');
    wsId = B.jobs.addWorkspace(ws).id;
  });
  after(async () => {
    await A.stop();
    await B.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('refused while the worker has jobs switched off (the default)', async () => {
    const r = await run(js('1')).done;
    assert.equal(r.reason, 'refused: jobs-off');
    assert.equal((await A.jobs.remoteWorkspaces(B.id)).enabled, false);
    B.store.updateSettings({ allowJobs: true });
    const list = await A.jobs.remoteWorkspaces(B.id);
    assert.equal(list.enabled, true);
    assert.equal(list.workspaces[0].name, 'project');
  });

  test('nothing runs until the worker approves; "once" runs it in the workspace', async () => {
    process.env.DEVLINK_TEST_SECRET = 'must-not-leak';
    const job = run(
      js(`require('fs').writeFileSync('ran.txt', process.cwd()); console.log('secret=' + process.env.DEVLINK_TEST_SECRET + ' ci=' + process.env.CI)`),
      { cwd: 'sub', env: { CI: '1' } },
    );
    await waitFor(() => !!B.jobs.snapshot().prompt);
    assert.equal(fs.existsSync(path.join(sub, 'ran.txt')), false, 'ran before approval');
    const p = B.jobs.snapshot().prompt!;
    assert.equal(p.peer, 'requester');
    assert.equal(p.cwd, 'sub');
    assert.match(p.command, /writeFileSync/);
    B.jobs.answer(p.id, 'once');
    const r = await job.done;
    assert.equal(r.code, 0);
    assert.equal(r.reason, '');
    assert.equal(fs.realpathSync(fs.readFileSync(path.join(sub, 'ran.txt'), 'utf8')), fs.realpathSync(sub));
    const text = A.jobs.snapshot().sent[0].tail;
    assert.match(text, /secret=undefined ci=1/);
    delete process.env.DEVLINK_TEST_SECRET;
    // "once" does not carry over
    const second = run(js('1'));
    await approve('deny');
    assert.equal((await second.done).reason, 'refused: declined');
  });

  test('a denied job never starts and is logged', async () => {
    const marker = path.join(ws, 'denied.txt');
    const job = run(js(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`));
    await approve('deny');
    assert.equal((await job.done).reason, 'refused: declined');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fs.existsSync(marker), false);
    assert.ok(B.jobs.snapshot().audit.some((e) => e.outcome === 'declined'));
  });

  test('approving for the connection lets later jobs run without a prompt', async () => {
    const first = run(js("console.log('one')"));
    await approve('session');
    assert.equal((await first.done).code, 0);
    const second = run(js('process.exit(7)'));
    assert.equal((await second.done).code, 7);
    assert.equal(B.jobs.snapshot().prompt, null);
    assert.deepEqual(B.jobs.snapshot().sessionApproved, ['requester']);
  });

  test('requests that break the rules are refused before anything is sent', async () => {
    assert.throws(() => run(js('1'), { cwd: '../outside' }), /bad-path/);
    assert.throws(() => run(js('1'), { env: { PATH: '/evil' } }), /env-not-allowed/);
    assert.throws(() => run([]), /bad-argv/);
  });

  test('a hostile requester is refused by the worker too', async () => {
    // bypass the requester-side check by sending raw messages
    const replies: string[] = [];
    const raw = (msg: any) =>
      new Promise<string>((resolve) => {
        const o: any = { id: msg.id, peerId: B.id, command: '', state: 'sent', tail: '', startedAt: Date.now(), resolve: (r: any) => resolve(r.reason) };
        (A.jobs as any).out.set(msg.id, o);
        A.send(B.id, msg);
      });
    replies.push(await raw({ t: 'job-submit', id: 'b'.repeat(16), ws: wsId, cwd: '', argv: ['x'], env: { PATH: '/evil' } }));
    replies.push(await raw({ t: 'job-submit', id: 'c'.repeat(16), ws: 'nope', cwd: '', argv: ['x'], env: {} }));
    replies.push(await raw({ t: 'job-submit', id: 'd'.repeat(16), ws: wsId, cwd: '../..', argv: ['x'], env: {} }));
    replies.push(await raw({ t: 'job-submit', id: 'e'.repeat(16), ws: wsId, cwd: '', argv: 'rm -rf /', env: {} }));
    assert.deepEqual(replies, ['refused: env-not-allowed', 'refused: no-such-workspace', 'refused: bad-path', 'refused: bad-argv']);
  });

  test('a symlink inside the workspace cannot point the job outside it', { skip: (() => { try { fs.symlinkSync(tmp, path.join(tmp, '.probe')); fs.rmSync(path.join(tmp, '.probe')); return false; } catch { return 'cannot create symlinks here'; } })() }, async () => {
    fs.symlinkSync(os.tmpdir(), path.join(ws, 'escape'));
    const r = await run(js('1'), { cwd: 'escape' }).done;
    assert.equal(r.reason, 'refused: outside-workspace');
  });

  test('stdout and stderr stream back, and a missing program is reported', async () => {
    const chunks: string[] = [];
    const job = A.jobs.run(B.id, { ws: wsId, argv: js("console.log('to-out'); console.error('to-err')") }, (s, d) => chunks.push(`${s}:${d.toString().trim()}`));
    await job.done;
    assert.ok(chunks.includes('stdout:to-out') && chunks.includes('stderr:to-err'), chunks.join('|'));
    const missing = await run(['definitely-not-a-real-program-xyz']).done;
    assert.equal(missing.reason, 'command not found');
  });

  test('the requester can cancel, and the time limit is enforced', async () => {
    const slow = run(js('setInterval(()=>{},1000)'));
    await waitFor(() => B.jobs.snapshot().running.length === 1, 8000, 'running');
    slow.cancel();
    const r = await slow.done;
    assert.equal(r.reason, 'cancelled by the requesting device');
    const timed = await run(js('setInterval(()=>{},1000)'), { wallSec: 1 }).done;
    assert.equal(timed.reason, 'time limit reached');
  });

  test('runaway output is cut off', async () => {
    const r = await run(js("const b='x'.repeat(65536); (function w(){ while(process.stdout.write(b)); process.stdout.once('drain', w); })()")).done;
    assert.equal(r.reason, 'output limit reached');
    assert.ok(A.jobs.snapshot().sent[0].tail.length <= 64 * 1024);
  });

  test('at most two jobs run at once', async () => {
    const a = run(js('setInterval(()=>{},1000)'));
    const b = run(js('setInterval(()=>{},1000)'));
    await waitFor(() => B.jobs.snapshot().running.length === 2, 8000, 'two running');
    const c = await run(js('1')).done;
    assert.equal(c.reason, 'refused: busy');
    a.cancel();
    b.cancel();
    await Promise.all([a.done, b.done]);
  });

  test('turning jobs off stops a running job and clears approvals', async () => {
    const job = run(js('setInterval(()=>{},1000)'));
    await waitFor(() => B.jobs.snapshot().running.length === 1, 8000, 'running');
    B.store.updateSettings({ allowJobs: false });
    B.jobs.settingsChanged();
    assert.equal((await job.done).reason, 'jobs were turned off');
    assert.deepEqual(B.jobs.snapshot().sessionApproved, []);
    B.store.updateSettings({ allowJobs: true });
  });

  test('approval is ignored while another device is driving this machine', async () => {
    B.jobs.settingsChanged();
    const job = run(js('1'));
    await waitFor(() => !!B.jobs.snapshot().prompt);
    Object.defineProperty(B.input, 'mode', { configurable: true, get: () => ({ mode: 'following', peer: 'x' }) });
    B.jobs.answer(B.jobs.snapshot().prompt!.id, 'session');
    assert.ok(B.jobs.snapshot().prompt, 'a remote click must not approve a job');
    delete (B.input as any).mode;
    B.jobs.answer(B.jobs.snapshot().prompt!.id, 'deny');
    await job.done;
  });

  test('a job dies with the connection', async () => {
    const pidFile = path.join(ws, 'pid.txt');
    const job = run(js(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`));
    await approve('once');
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0, 8000, 'pid file');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    B.sessions.get(A.id)!.close();
    assert.equal((await job.done).reason, 'device disconnected');
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 8000, 'process to exit');
    // the audit entry is written when the killed process's close event fires, a moment after it is gone
    await waitFor(() => B.jobs.snapshot().audit.some((e) => e.outcome === 'device disconnected'), 8000, 'audit entry');
    // the audit file keeps the record on disk
    assert.match(fs.readFileSync(path.join(tmp, 'worker', 'cfg', 'jobs-audit.log'), 'utf8'), /device disconnected/);
  });
});
