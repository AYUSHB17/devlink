import { execFile } from 'child_process';
import * as os from 'os';
import type { Core } from './core';

export interface DeviceStatus {
  hostname: string;
  username: string;
  platform: string;
  release: string;
  arch: string;
  uptime: number;
  load1: number;
  cpus: number;
  memTotal: number;
  memFree: number;
  ips: string[];
  tools: Record<string, string | null>;
  ts: number;
}

const TOOLS: [string, string[]][] = [
  ['git', ['--version']],
  ['node', ['--version']],
  ['npm', ['--version']],
  ['docker', ['--version']],
  ['python3', ['--version']],
  ['go', ['version']],
  ['cargo', ['--version']],
  ['java', ['-version']],
];

function probe(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    // fixed command list; shell only on Windows so that .cmd shims like npm resolve
    execFile(cmd, args, { timeout: 3000, windowsHide: true, shell: process.platform === 'win32' }, (err, out, errOut) => {
      if (err) return resolve(null);
      const line = `${out}${errOut}`.split('\n')[0].trim();
      resolve(line.replace(/^(git version|Python|Docker version|go version|cargo|openjdk version|java version)\s*/i, '').slice(0, 60) || null);
    });
  });
}

/** Shares a small "how is my other machine doing" snapshot with every connected peer. */
export class StatusReporter {
  private remote = new Map<string, DeviceStatus>();
  private timer?: NodeJS.Timeout;
  private tools: Record<string, string | null> = {};
  private toolsAt = 0;

  constructor(private core: Core) {
    core.onJson('status', (peerId, msg) => {
      if (msg.data && typeof msg.data === 'object') {
        this.remote.set(peerId, msg.data);
        core.changed();
      }
    });
    core.onPeerUp((peerId) => void this.sendTo(peerId));
    core.onPeerDown((peerId) => {
      this.remote.delete(peerId);
    });
  }

  start(): void {
    this.timer = setInterval(() => void this.sendAll(), 15_000);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get(peerId: string): DeviceStatus | undefined {
    return this.remote.get(peerId);
  }

  async collect(): Promise<DeviceStatus> {
    if (Date.now() - this.toolsAt > 5 * 60_000) {
      this.toolsAt = Date.now();
      const found = await Promise.all(TOOLS.map(([c, a]) => probe(c === 'python3' && process.platform === 'win32' ? 'python' : c, a)));
      this.tools = Object.fromEntries(TOOLS.map(([c], i) => [c, found[i]]));
    }
    const ips: string[] = [];
    for (const list of Object.values(os.networkInterfaces()))
      for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
    return {
      hostname: os.hostname(),
      username: os.userInfo().username,
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptime: os.uptime(),
      load1: os.loadavg()[0],
      cpus: os.cpus().length,
      memTotal: os.totalmem(),
      memFree: os.freemem(),
      ips,
      tools: this.tools,
      ts: Date.now(),
    };
  }

  private async sendTo(peerId: string): Promise<void> {
    this.core.send(peerId, { t: 'status', data: await this.collect() });
  }
  private async sendAll(): Promise<void> {
    if (!this.core.sessions.size) return;
    const data = await this.collect();
    this.core.broadcast({ t: 'status', data });
  }
}
