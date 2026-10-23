import * as crypto from 'crypto';
import * as http from 'http';
import type { Core } from './core';

const MAX_BODY = 64 * 1024;
const MAX_REQUESTS_PER_10S = 40;

/**
 * Tiny local HTTP API for the DevLink browser extension ("send this tab / all tabs").
 *
 * - Listens on 127.0.0.1 only; off unless enabled in Settings.
 * - Every request needs the X-DevLink-Token header (shown in DevLink Settings, pasted into the extension once).
 * - Requests carrying a web-page Origin are refused, and no CORS headers are ever sent, so websites can't use it.
 * - It can only list online paired devices and send them web links; nothing else.
 */
export class BrowserBridge {
  private server?: http.Server;
  port = 0;
  error = '';
  private hits: number[] = [];

  constructor(private core: Core) {
    if (!core.store.settings.browserBridgeToken) this.newToken();
  }

  newToken(): string {
    const token = crypto.randomBytes(24).toString('base64url');
    // a new token also forgets which extension was allowed, so the next one to use it is pinned instead
    this.core.store.updateSettings({ browserBridgeToken: token, browserBridgeOrigin: '' });
    return token;
  }

  /** Start or stop to match the setting. */
  async reconcile(): Promise<void> {
    const s = this.core.store.settings;
    if (!s.browserBridge) return this.stop();
    if (this.server) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        this.error = e.code === 'EADDRINUSE' ? `port ${s.browserBridgePort} is already in use` : e.message;
        this.server = undefined;
        resolve();
      });
      server.listen(s.browserBridgePort, '127.0.0.1', () => {
        this.port = (server.address() as { port: number }).port;
        this.error = '';
        resolve();
      });
    });
    this.core.changed();
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    this.port = 0;
    this.core.changed();
  }

  private send(res: http.ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private authorized(req: http.IncomingMessage): boolean {
    const given = Buffer.from(String(req.headers['x-devlink-token'] ?? ''));
    const want = Buffer.from(this.core.store.settings.browserBridgeToken);
    return given.length === want.length && want.length > 0 && crypto.timingSafeEqual(given, want);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // DNS rebinding: a web page whose hostname resolves to 127.0.0.1 still sends its own Host header
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return this.send(res, 403, { error: 'forbidden' });
    const origin = String(req.headers.origin ?? '');
    // extensions send chrome-extension:// / moz-extension:// (or no Origin); web pages must never get in
    if (origin && !/^(chrome|moz|safari-web)-extension:\/\/[a-z0-9-]+\/?$/i.test(origin)) return this.send(res, 403, { error: 'forbidden' });
    if (req.method === 'OPTIONS') return this.send(res, 403, { error: 'forbidden' });
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < 10_000);
    if (this.hits.length >= MAX_REQUESTS_PER_10S) return this.send(res, 429, { error: 'too many requests' });
    this.hits.push(now);
    if (!this.authorized(req)) return this.send(res, 401, { error: 'wrong or missing token' });
    if (origin) {
      // trust on first use: once one extension has used the token, other extensions are refused
      const pinned = this.core.store.settings.browserBridgeOrigin;
      const o = origin.replace(/\/$/, '');
      if (!pinned) this.core.store.updateSettings({ browserBridgeOrigin: o });
      else if (pinned !== o) return this.send(res, 403, { error: 'a different browser extension is already linked; create a new token in DevLink to switch' });
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/devices') {
      const devices = this.core.store.peers
        .filter((p) => this.core.sessions.has(p.id))
        .map((p) => ({ id: p.id, name: p.name, os: p.os }));
      return this.send(res, 200, { self: this.core.store.settings.deviceName, devices });
    }
    if (req.method === 'POST' && url.pathname === '/v1/send') {
      let body: any;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e: any) {
        return this.send(res, 400, { error: e.message === 'too large' ? 'request too large' : 'bad JSON' });
      }
      let peerId = typeof body?.device === 'string' ? body.device : '';
      if (!peerId) {
        const online = this.core.store.peers.filter((p) => this.core.sessions.has(p.id));
        if (online.length !== 1) return this.send(res, 400, { error: online.length ? 'choose a device' : 'no device is connected' });
        peerId = online[0].id;
      }
      if (!this.core.store.getPeer(peerId)) return this.send(res, 404, { error: 'unknown device' });
      try {
        const n = this.core.links.send(peerId, Array.isArray(body?.urls) ? body.urls : []);
        return this.send(res, 200, { sent: n });
      } catch (e: any) {
        return this.send(res, 400, { error: e.message });
      }
    }
    return this.send(res, 404, { error: 'not found' });
  }

  snapshot() {
    const s = this.core.store.settings;
    return { enabled: s.browserBridge, port: this.port || s.browserBridgePort, running: !!this.server && !!this.port, error: this.error };
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
