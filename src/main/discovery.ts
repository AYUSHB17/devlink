import { EventEmitter } from 'events';
import Bonjour from 'bonjour-service';

export interface DiscoveredDevice {
  id: string;
  name: string;
  os: string;
  host: string;
  port: number;
}

/** LAN discovery over mDNS (_devlink._tcp). Failures are non-fatal: manual host:port always works. */
export class Discovery extends EventEmitter {
  private bonjour?: Bonjour;
  private found = new Map<string, DiscoveredDevice & { svc: string }>();

  constructor(private selfId: string, private log: (m: string) => void) {
    super();
  }

  start(name: string, port: number): void {
    try {
      this.bonjour = new Bonjour();
      this.bonjour.publish({
        name: 'devlink-' + this.selfId.slice(0, 12),
        type: 'devlink',
        port,
        txt: { id: this.selfId, name, os: process.platform, v: '1' },
      });
      const browser = this.bonjour.find({ type: 'devlink' });
      browser.on('up', (svc: any) => this.up(svc));
      browser.on('down', (svc: any) => {
        for (const [id, d] of this.found) if (d.svc === svc.name) this.found.delete(id);
        this.emitChange();
      });
    } catch (e: any) {
      this.log(`discovery unavailable: ${e.message}`);
    }
  }

  private up(svc: any): void {
    const id = svc.txt?.id;
    if (typeof id !== 'string' || id === this.selfId) return;
    const addrs: string[] = svc.addresses ?? [];
    const host = addrs.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? addrs[0];
    if (!host) return;
    this.found.set(id, { id, name: String(svc.txt.name ?? svc.host), os: String(svc.txt.os ?? ''), host, port: svc.port, svc: svc.name });
    this.emitChange();
  }

  private emitChange(): void {
    this.emit('change', [...this.found.values()].map(({ svc, ...d }) => d));
  }

  stop(): void {
    try {
      this.bonjour?.unpublishAll();
      this.bonjour?.destroy();
    } catch {
      /* ignore */
    }
  }
}
