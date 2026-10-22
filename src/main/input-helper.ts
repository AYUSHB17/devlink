import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { HelperCommand, InputBackend } from './input';

const EXE = process.platform === 'win32' ? 'devlink-input.exe' : 'devlink-input';

/**
 * Finds the native helper. A packaged app only ever uses the copy bundled in its resources (no env override,
 * no dev paths), so nothing outside the app can swap in a different binary. Dev runs use the cargo output.
 */
export function findHelper(projectRoot: string, resourcesPath?: string): string | null {
  const candidates = resourcesPath
    ? [path.join(resourcesPath, EXE)]
    : [
        process.env.DEVLINK_INPUT_HELPER,
        path.join(projectRoot, 'native', 'devlink-input', 'target', 'release', EXE),
        path.join(projectRoot, 'native', 'devlink-input', 'target', 'debug', EXE),
      ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

/** Runs the Rust helper as a child process speaking JSON lines; restarts it a few times if it crashes. */
export class HelperProcess extends EventEmitter implements InputBackend {
  private child?: ChildProcess;
  private restarts = 0;
  private stopping = false;
  private lastConfig?: HelperCommand;
  private pinger?: NodeJS.Timeout;
  running = false;

  constructor(private bin: string | null, private log: (m: string) => void) {
    super();
  }

  start(): void {
    if (this.running) return;
    if (!this.bin) {
      this.emit('exit', 'The input helper is not built yet. Run "npm run build:native" and restart DevLink.');
      return;
    }
    this.stopping = false;
    const child = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.running = true;
    const startedAt = Date.now();
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      this.emit('event', ev);
    });
    child.stderr!.on('data', (d) => this.log(`input helper: ${String(d).trim()}`));
    child.on('error', (e) => this.log(`input helper: ${e.message}`));
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.running = false;
      this.child = undefined;
      if (this.stopping) return;
      this.emit('exit', `input helper exited (code ${code})`);
      // a helper that ran fine for a while gets a fresh set of restarts
      if (Date.now() - startedAt > 60_000) this.restarts = 0;
      if (++this.restarts <= 5) setTimeout(() => this.start(), 1000 * this.restarts);
    });
    if (this.lastConfig) this.send(this.lastConfig);
    // the helper's watchdog releases capture/held keys if these stop (e.g. the app hangs)
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = setInterval(() => this.send({ cmd: 'ping' }), 1000);
  }

  send(c: HelperCommand): void {
    if (c.cmd === 'config') this.lastConfig = c;
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(JSON.stringify(c) + '\n');
  }

  stop(): void {
    if (!this.child) return;
    this.stopping = true;
    if (this.pinger) clearInterval(this.pinger);
    const child = this.child;
    this.send({ cmd: 'quit' });
    child.stdin?.end();
    setTimeout(() => child.kill(), 500).unref();
    this.child = undefined;
    this.running = false;
  }
}
