import { ChildProcess, execFile, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { Core } from './core';
import type { Session } from './protocol';
import { FsError, isInside, safeSegments } from './remotefs';

/**
 * Run on the other machine (docs/COMPUTE_POOLING.md, phase 1).
 *
 * A paired device can ask this machine to run a program, but only if all of these hold:
 *  - "Let paired devices run jobs on this machine" is on (off by default, its own switch);
 *  - the program runs inside a workspace folder that this machine's user registered;
 *  - the local user approves it in this machine's own window: once, or for this connection only
 *    (held in memory, gone when the connection drops or DevLink restarts).
 *
 * Everything the peer sends is untrusted. A job is an argument vector, never a shell string; the environment is
 * built here from a fixed list, not forwarded; output size, run time and concurrency are capped; the job dies with
 * the connection. The job runs as the logged-in user, not in a container: CPU and memory are NOT limited.
 *
 * Protocol (JSON, `job` prefix): job-submit / job-cancel (requester to worker); job-deny / job-ack / job-out /
 * job-exit (worker to requester); job-ws + job-wsres (list the worker's workspaces).
 */

export interface Workspace {
  id: string;
  name: string;
  path: string;
}

export interface JobRequest {
  /** workspace id on the worker */
  ws: string;
  /** folder inside the workspace, '/'-separated, '' for its root */
  cwd?: string;
  argv: string[];
  env?: Record<string, string>;
  wallSec?: number;
}

export interface JobResult {
  code: number | null;
  signal: string | null;
  /** '' when the program simply exited; otherwise why it was stopped or refused */
  reason: string;
  ms: number;
}

export class JobError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const MAX_ARGS = 64;
const MAX_ARG_LEN = 4096;
const MAX_ARGV_BYTES = 32 * 1024;
const MAX_ENV = 16;
const MAX_ENV_VALUE = 4096;
const DEFAULT_WALL_SEC = 600;
const MAX_WALL_SEC = 3600;
const MAX_OUTPUT = 4 * 1024 * 1024;
const CHUNK = 16 * 1024;
const FLUSH_MS = 50;
const MAX_RUNNING = 2;
const MAX_AWAITING = 5;
const CONSENT_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const TAIL = 64 * 1024;
const AUDIT_KEEP = 100;
const AUDIT_FILE_MAX = 1024 * 1024;
const ID = /^[0-9a-f]{16}$/;

/** The only variables a requester may set. Everything else it sends is dropped. */
const ENV_FROM_REQUESTER = new Set(['CI', 'NODE_ENV', 'FORCE_COLOR', 'NO_COLOR', 'TZ']);
/** What the job inherits from this machine's own environment (no tokens, no keys). */
const ENV_INHERIT = [
  'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'USERNAME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL',
  'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
];

/** cmd.exe needs a shell to run .cmd/.bat shims such as npm; with a shell, only arguments from this set are allowed. */
const CMD_SAFE_ARG = /^[A-Za-z0-9_@+=:,./\\-]+$/;

const BIDI = /[‎‏‪-‮⁦-⁩]/g;

export const clean = (s: string, max: number): string =>
  s.replace(BIDI, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).slice(0, max);

/** One readable line for prompts and logs. Quoting makes the token boundaries visible. */
export function displayCommand(argv: string[], max = 300): string {
  return clean(argv.map((a) => (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(a) ? a : JSON.stringify(a))).join(' '), max);
}

/** Splits a typed command line into an argument vector (spaces and single/double quotes only; no shell syntax). */
export function parseArgv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) throw new JobError('unclosed-quote');
  if (has || cur) out.push(cur);
  return out;
}

export interface Checked {
  id: string;
  ws: string;
  cwd: string[];
  argv: string[];
  env: Record<string, string>;
  wallSec: number;
}

/** Strict validation of a job request, used on both ends. Throws JobError with a short code. */
export function checkRequest(id: unknown, r: any): Checked {
  if (typeof id !== 'string' || !ID.test(id)) throw new JobError('bad-id');
  if (!r || typeof r !== 'object') throw new JobError('bad-request');
  if (typeof r.ws !== 'string' || r.ws.length > 64) throw new JobError('bad-workspace');
  const argv = r.argv;
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > MAX_ARGS) throw new JobError('bad-argv');
  let bytes = 0;
  for (const a of argv) {
    if (typeof a !== 'string' || a.length > MAX_ARG_LEN || a.includes('\u0000')) throw new JobError('bad-argv');
    bytes += a.length;
  }
  if (!argv[0] || bytes > MAX_ARGV_BYTES) throw new JobError('bad-argv');
  const env: Record<string, string> = {};
  const given = r.env && typeof r.env === 'object' && !Array.isArray(r.env) ? Object.entries(r.env) : [];
  if (given.length > MAX_ENV) throw new JobError('bad-env');
  for (const [k, v] of given) {
    if (!ENV_FROM_REQUESTER.has(k)) throw new JobError('env-not-allowed');
    if (typeof v !== 'string' || v.length > MAX_ENV_VALUE || v.includes('\u0000')) throw new JobError('bad-env');
    env[k] = v;
  }
  let cwd: string[];
  try {
    cwd = safeSegments(r.cwd ?? '');
  } catch (e) {
    throw new JobError(e instanceof FsError ? e.code : 'bad-path');
  }
  const w = r.wallSec === undefined ? DEFAULT_WALL_SEC : r.wallSec;
  if (!Number.isInteger(w) || w < 1 || w > MAX_WALL_SEC) throw new JobError('bad-limit');
  return { id, ws: r.ws, cwd, argv, env, wallSec: w };
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of ['.exe', '.com', '.cmd', '.bat']) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** Decides how to start argv[0]. On Windows, npm-style .cmd shims need cmd.exe, so their arguments are restricted. */
export function planSpawn(argv: string[], env: NodeJS.ProcessEnv, platform = process.platform): { file: string; args: string[]; shell: boolean } {
  const [file, ...args] = argv;
  if (platform !== 'win32') return { file, args, shell: false };
  let target = file;
  if (!path.extname(file) && !/[\\/]/.test(file)) target = findOnPath(file, env) ?? file;
  if (!/\.(cmd|bat)$/i.test(target)) return { file, args, shell: false };
  if (![file, ...args].every((a) => CMD_SAFE_ARG.test(a))) throw new JobError('unsafe-for-cmd');
  return { file, args, shell: true };
}

export function buildEnv(extra: Record<string, string>, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_INHERIT) if (base[k] !== undefined) env[k] = base[k];
  return Object.assign(env, extra);
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    return;
  }
  const group = (sig: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  group('SIGTERM');
  setTimeout(() => group('SIGKILL'), 3000).unref();
}

// ---------------------------------------------------------------- state

interface WorkerJob {
  id: string;
  peerId: string;
  session: Session;
  req: Checked;
  cwdReal: string;
  wsName: string;
  state: 'awaiting' | 'running';
  startedAt: number;
  child?: ChildProcess;
  stop?: string;
  askTimer?: NodeJS.Timeout;
}

interface Outgoing {
  id: string;
  peerId: string;
  command: string;
  state: 'sent' | 'running' | 'done';
  tail: string;
  startedAt: number;
  result?: JobResult;
  resolve: (r: JobResult) => void;
}

export interface AuditEntry {
  ts: number;
  peer: string;
  command: string;
  workspace: string;
  cwd: string;
  outcome: string;
  code: number | null;
  ms: number;
}

type Pending = { peerId: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export type Decision = 'deny' | 'once' | 'session';

export class Jobs extends EventEmitter {
  private workspaces: Workspace[] = [];
  private file: string;
  private auditFile: string;
  private work = new Map<string, WorkerJob>();
  private consent = new Map<string, Session>();
  private out = new Map<string, Outgoing>();
  private recent: Outgoing[] = [];
  private audit: AuditEntry[] = [];
  private pending = new Map<string, Pending>();

  constructor(private core: Core) {
    super();
    this.file = path.join(core.store.dir, 'jobs.json');
    this.auditFile = path.join(core.store.dir, 'jobs-audit.log');
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(loaded.workspaces)) this.workspaces = loaded.workspaces.filter((w: any) => w && typeof w.id === 'string' && typeof w.path === 'string');
    } catch {
      /* first run */
    }
    core.onJson('job', (peerId, msg, session) => this.onMessage(peerId, msg, session));
    core.onPeerDown((peerId) => this.peerDown(peerId));
  }

  private peerName(id: string): string {
    return clean(this.core.store.getPeer(id)?.name ?? 'device', 60);
  }

  // ------------------------------------------------------------ workspaces (this machine's side)

  get enabled(): boolean {
    return this.core.store.settings.allowJobs === true;
  }

  addWorkspace(folder: string, name?: string): Workspace {
    const real = fs.realpathSync(path.resolve(folder));
    if (!fs.statSync(real).isDirectory()) throw new Error('not a folder');
    if (path.parse(real).root === real) throw new Error('refusing to use a whole drive as a workspace');
    if (real === fs.realpathSync(os.homedir())) throw new Error('refusing to use your whole home folder; pick a project folder');
    if (this.workspaces.some((w) => w.path === real)) throw new Error('already a workspace');
    const ws: Workspace = { id: crypto.randomBytes(4).toString('hex'), name: (name?.trim() || path.basename(real)).slice(0, 100), path: real };
    this.workspaces.push(ws);
    this.saveWorkspaces();
    this.core.changed();
    return ws;
  }

  removeWorkspace(id: string): void {
    this.workspaces = this.workspaces.filter((w) => w.id !== id);
    this.saveWorkspaces();
    this.core.changed();
  }

  private saveWorkspaces(): void {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ workspaces: this.workspaces }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Call after settings change: switching jobs off ends everything that is running or waiting. */
  settingsChanged(): void {
    if (this.enabled) return;
    for (const j of [...this.work.values()]) this.stopJob(j, 'jobs were turned off');
    this.consent.clear();
    this.core.changed();
  }

  stopAll(): void {
    for (const j of [...this.work.values()]) this.stopJob(j, 'DevLink is closing');
  }

  // ------------------------------------------------------------ worker: receiving jobs

  private onMessage(peerId: string, msg: any, session: Session): void {
    switch (msg?.t) {
      case 'job-submit':
        return void this.onSubmit(peerId, msg, session);
      case 'job-cancel': {
        const j = typeof msg.id === 'string' ? this.work.get(msg.id) : undefined;
        if (j && j.peerId === peerId) this.stopJob(j, 'cancelled by the requesting device');
        return;
      }
      case 'job-ws':
        return this.onWorkspaceList(peerId, msg);
      case 'job-wsres':
        return this.onResponse(peerId, msg);
      case 'job-deny':
      case 'job-ack':
      case 'job-out':
      case 'job-exit':
        return this.onWorkerEvent(peerId, msg);
    }
  }

  private onWorkspaceList(peerId: string, msg: any): void {
    const rid = typeof msg.rid === 'string' ? msg.rid.slice(0, 64) : '';
    if (!rid) return;
    this.core.send(peerId, {
      t: 'job-wsres',
      rid,
      ok: true,
      enabled: this.enabled,
      workspaces: this.enabled ? this.workspaces.map(({ id, name }) => ({ id, name })) : [],
    });
  }

  private deny(peerId: string, id: unknown, reason: string): void {
    if (typeof id === 'string' && ID.test(id)) this.core.send(peerId, { t: 'job-deny', id, reason });
  }

  private onSubmit(peerId: string, msg: any, session: Session): void {
    if (!this.enabled) return this.deny(peerId, msg.id, 'jobs-off');
    let req: Checked;
    try {
      req = checkRequest(msg.id, msg);
    } catch (e: any) {
      return this.deny(peerId, msg.id, e instanceof JobError ? e.code : 'bad-request');
    }
    if (this.work.has(req.id)) return;
    const ws = this.workspaces.find((w) => w.id === req.ws);
    if (!ws) return this.deny(peerId, req.id, 'no-such-workspace');
    let cwdReal: string;
    try {
      const root = fs.realpathSync(ws.path);
      cwdReal = fs.realpathSync(path.join(root, ...req.cwd));
      if (!isInside(root, cwdReal) || !fs.statSync(cwdReal).isDirectory()) throw new JobError('outside-workspace');
    } catch (e: any) {
      return this.deny(peerId, req.id, e instanceof JobError ? e.code : 'cwd-unavailable');
    }
    const live = [...this.work.values()];
    if (live.filter((j) => j.state === 'running').length >= MAX_RUNNING) return this.deny(peerId, req.id, 'busy');
    if (live.filter((j) => j.state === 'awaiting').length >= MAX_AWAITING) return this.deny(peerId, req.id, 'busy');
    const job: WorkerJob = { id: req.id, peerId, session, req, cwdReal, wsName: ws.name, state: 'awaiting', startedAt: Date.now() };
    this.work.set(job.id, job);
    if (this.consent.get(peerId) === session) return this.start(job);
    job.askTimer = setTimeout(() => this.refuse(job, 'no-answer'), CONSENT_TIMEOUT_MS);
    job.askTimer.unref();
    if (this.firstAwaiting()?.id === job.id) this.emit('consent', this.peerName(peerId), displayCommand(req.argv, 120));
    this.core.changed();
  }

  private firstAwaiting(): WorkerJob | undefined {
    return [...this.work.values()].find((j) => j.state === 'awaiting');
  }

  /** Answered in this machine's own window. Ignored while another device is driving this machine's input. */
  answer(id: string, decision: Decision): void {
    if (this.core.input.mode.mode === 'following') return;
    const job = this.work.get(id);
    if (!job || job.state !== 'awaiting') return;
    if (decision === 'deny') return this.refuse(job, 'declined');
    if (job.session !== this.core.sessions.get(job.peerId) || !this.enabled) return this.refuse(job, 'device-disconnected');
    if (decision === 'session') {
      this.consent.set(job.peerId, job.session);
      for (const other of [...this.work.values()]) if (other.state === 'awaiting' && other.peerId === job.peerId) this.start(other);
    } else this.start(job);
  }

  private refuse(job: WorkerJob, reason: string): void {
    if (job.state !== 'awaiting') return;
    clearTimeout(job.askTimer);
    this.work.delete(job.id);
    this.core.send(job.peerId, { t: 'job-deny', id: job.id, reason });
    this.record(job, reason, null);
    const next = this.firstAwaiting();
    if (next) this.emit('consent', this.peerName(next.peerId), displayCommand(next.req.argv, 120));
    this.core.changed();
  }

  private start(job: WorkerJob): void {
    clearTimeout(job.askTimer);
    const { req } = job;
    let plan;
    try {
      plan = planSpawn(req.argv, buildEnv(req.env));
    } catch (e: any) {
      return this.refuse(job, e instanceof JobError ? e.code : 'cannot-start');
    }
    job.state = 'running';
    job.startedAt = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(plan.file, plan.args, {
        cwd: job.cwdReal,
        env: buildEnv(req.env),
        shell: plan.shell,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      job.state = 'awaiting';
      return this.refuse(job, 'cannot-start');
    }
    job.child = child;
    this.core.send(job.peerId, { t: 'job-ack', id: job.id });

    let total = 0;
    const buf: Record<'o' | 'e', Buffer[]> = { o: [], e: [] };
    const flush = () => {
      for (const s of ['o', 'e'] as const) {
        const joined = Buffer.concat(buf[s]);
        buf[s] = [];
        for (let i = 0; i < joined.length; i += CHUNK) this.core.send(job.peerId, { t: 'job-out', id: job.id, s, d: joined.subarray(i, i + CHUNK).toString('base64') });
      }
    };
    const timer = setInterval(flush, FLUSH_MS);
    const feed = (s: 'o' | 'e') => (d: Buffer) => {
      total += d.length;
      if (total > MAX_OUTPUT) return this.stopJob(job, 'output limit reached');
      buf[s].push(d);
      // do not let a fast job pile up unsent data in memory
      const sock = job.session.stream.socket;
      if (sock.writableLength > 1 << 20) {
        child.stdout?.pause();
        child.stderr?.pause();
        const resume = () => (sock.writableLength > 1 << 19 && !sock.destroyed ? setTimeout(resume, 100) : (child.stdout?.resume(), child.stderr?.resume()));
        setTimeout(resume, 100);
      }
    };
    child.stdout?.on('data', feed('o'));
    child.stderr?.on('data', feed('e'));
    const wall = setTimeout(() => this.stopJob(job, 'time limit reached'), req.wallSec * 1000);
    let finished = false;
    const finish = (code: number | null, signal: string | null, error?: string) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      clearTimeout(wall);
      flush();
      this.work.delete(job.id);
      const reason = job.stop ?? error ?? '';
      const ms = Date.now() - job.startedAt;
      this.core.send(job.peerId, { t: 'job-exit', id: job.id, code, signal, reason, ms });
      this.record(job, reason || 'finished', code, ms);
      this.core.changed();
    };
    child.on('error', (e: any) => finish(null, null, e.code === 'ENOENT' ? 'command not found' : 'could not start'));
    child.on('close', (code, signal) => finish(code, signal));
    this.core.changed();
  }

  private stopJob(job: WorkerJob, why: string): void {
    if (job.state === 'awaiting') return this.refuse(job, why);
    if (job.stop) return;
    job.stop = why;
    if (job.child) killTree(job.child);
    this.core.changed();
  }

  /** Stop button on the worker's own window. */
  stop(id: string): void {
    const j = this.work.get(id);
    if (j) this.stopJob(j, 'stopped on this machine');
  }

  private peerDown(peerId: string): void {
    this.consent.delete(peerId);
    for (const j of [...this.work.values()]) if (j.peerId === peerId) this.stopJob(j, 'device disconnected');
    for (const o of [...this.out.values()]) if (o.peerId === peerId) this.finishOut(o, { code: null, signal: null, reason: 'device disconnected', ms: Date.now() - o.startedAt });
    for (const [rid, p] of [...this.pending]) {
      if (p.peerId !== peerId) continue;
      this.pending.delete(rid);
      clearTimeout(p.timer);
      p.reject(new Error('device disconnected'));
    }
  }

  private record(job: WorkerJob, outcome: string, code: number | null, ms = 0): void {
    const e: AuditEntry = {
      ts: Date.now(),
      peer: this.peerName(job.peerId),
      command: displayCommand(job.req.argv, 500),
      workspace: clean(job.wsName, 100),
      cwd: clean(job.req.cwd.join('/'), 200),
      outcome: clean(outcome, 100),
      code,
      ms,
    };
    this.audit.unshift(e);
    this.audit.length = Math.min(this.audit.length, AUDIT_KEEP);
    try {
      if (fs.existsSync(this.auditFile) && fs.statSync(this.auditFile).size > AUDIT_FILE_MAX) fs.renameSync(this.auditFile, this.auditFile + '.1');
      fs.appendFileSync(this.auditFile, JSON.stringify(e) + '\n', { mode: 0o600 });
    } catch (err: any) {
      this.core.log(`jobs: could not write audit log: ${err.message}`);
    }
  }

  // ------------------------------------------------------------ requester: asking another device

  private request<T = any>(peerId: string, type: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.core.sessions.has(peerId)) return reject(new Error('device is offline'));
      const rid = crypto.randomBytes(8).toString('hex');
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error('timed out'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(rid, { peerId, resolve, reject, timer });
      this.core.send(peerId, { t: type, rid, ...params });
    });
  }

  private onResponse(peerId: string, msg: any): void {
    const p = typeof msg.rid === 'string' ? this.pending.get(msg.rid) : undefined;
    if (!p || p.peerId !== peerId) return;
    this.pending.delete(msg.rid);
    clearTimeout(p.timer);
    p.resolve(msg);
  }

  async remoteWorkspaces(peerId: string): Promise<{ enabled: boolean; workspaces: { id: string; name: string }[] }> {
    const r = await this.request(peerId, 'job-ws');
    const list = Array.isArray(r.workspaces) ? r.workspaces : [];
    return {
      enabled: r.enabled === true,
      workspaces: list.slice(0, 50).filter((w: any) => typeof w?.id === 'string' && typeof w?.name === 'string').map((w: any) => ({ id: w.id.slice(0, 64), name: clean(w.name, 100) })),
    };
  }

  /** Starts a job on `peerId`. Resolves when it ends, is refused, or the connection drops; never rejects after submit. */
  run(peerId: string, req: JobRequest, onOutput?: (stream: 'stdout' | 'stderr', data: Buffer) => void): { id: string; done: Promise<JobResult>; cancel: () => void } {
    if (!this.core.sessions.has(peerId)) throw new JobError('device-offline');
    const id = crypto.randomBytes(8).toString('hex');
    checkRequest(id, req);
    let resolve!: (r: JobResult) => void;
    const done = new Promise<JobResult>((r) => (resolve = r));
    const o: Outgoing = { id, peerId, command: displayCommand(req.argv, 300), state: 'sent', tail: '', startedAt: Date.now(), resolve };
    this.out.set(id, o);
    if (onOutput) this.on(`out:${id}`, onOutput);
    done.then(() => this.removeAllListeners(`out:${id}`));
    this.core.send(peerId, { t: 'job-submit', id, ws: req.ws, cwd: req.cwd ?? '', argv: req.argv, env: req.env ?? {}, wallSec: req.wallSec ?? DEFAULT_WALL_SEC });
    this.core.changed();
    return { id, done, cancel: () => this.cancel(id) };
  }

  cancel(id: string): void {
    const o = this.out.get(id);
    if (o) this.core.send(o.peerId, { t: 'job-cancel', id });
  }

  private finishOut(o: Outgoing, r: JobResult): void {
    if (o.state === 'done') return;
    o.state = 'done';
    o.result = r;
    this.out.delete(o.id);
    this.recent.unshift(o);
    this.recent.length = Math.min(this.recent.length, 10);
    o.resolve(r);
    this.core.changed();
  }

  private onWorkerEvent(peerId: string, msg: any): void {
    const o = typeof msg.id === 'string' ? this.out.get(msg.id) : undefined;
    // a reply only counts if it comes from the device we sent the job to
    if (!o || o.peerId !== peerId) return;
    switch (msg.t) {
      case 'job-deny':
        return this.finishOut(o, { code: null, signal: null, reason: `refused: ${clean(String(msg.reason ?? 'refused'), 80)}`, ms: Date.now() - o.startedAt });
      case 'job-ack':
        o.state = 'running';
        return this.core.changed();
      case 'job-out': {
        if ((msg.s !== 'o' && msg.s !== 'e') || typeof msg.d !== 'string' || msg.d.length > 24 * 1024) return;
        const data = Buffer.from(msg.d, 'base64');
        o.tail = (o.tail + data.toString('utf8')).slice(-TAIL);
        this.emit(`out:${o.id}`, msg.s === 'o' ? 'stdout' : 'stderr', data);
        return this.core.changed();
      }
      case 'job-exit': {
        const code = typeof msg.code === 'number' ? msg.code : null;
        const signal = typeof msg.signal === 'string' ? clean(msg.signal, 20) : null;
        return this.finishOut(o, { code, signal, reason: typeof msg.reason === 'string' ? clean(msg.reason, 100) : '', ms: Number.isFinite(msg.ms) ? Number(msg.ms) : 0 });
      }
    }
  }

  // ------------------------------------------------------------ for the UI

  snapshot() {
    const first = this.firstAwaiting();
    const asked = (j: WorkerJob) => ({ id: j.id, peer: this.peerName(j.peerId), command: displayCommand(j.req.argv, 600), workspace: clean(j.wsName, 100), cwd: clean(j.req.cwd.join('/'), 200) });
    return {
      enabled: this.enabled,
      workspaces: this.workspaces.map(({ id, name, path: p }) => ({ id, name, path: p })),
      prompt: first ? asked(first) : null,
      running: [...this.work.values()].filter((j) => j.state === 'running').map((j) => ({ ...asked(j), startedAt: j.startedAt })),
      sessionApproved: [...this.consent.keys()].map((id) => this.peerName(id)),
      audit: this.audit.slice(0, 30),
      sent: [...this.out.values(), ...this.recent].slice(0, 10).map((o) => ({
        id: o.id,
        peer: this.peerName(o.peerId),
        command: o.command,
        state: o.state,
        tail: o.tail,
        result: o.result ?? null,
      })),
    };
  }
}
