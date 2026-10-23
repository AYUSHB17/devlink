import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateIdentity, Identity, loadIdentity } from './protocol';

export interface PeerRecord {
  id: string;
  pub: string;
  name: string;
  os: string;
  lastHost?: string;
  lastPort?: number;
  pairedAt: number;
}

export interface Settings {
  deviceName: string;
  listenPort: number;
  clipboardSync: boolean;
  clipboardImages: boolean;
  acceptFiles: boolean;
  downloadsDir: string;
  allowForwarding: boolean;
  /** shared mouse & keyboard: let this machine's input cross to peers */
  inputSharing: boolean;
  /** let paired peers drive this machine's mouse & keyboard */
  allowRemoteInput: boolean;
  /** peerId -> side of this machine that peer sits on */
  inputLayout: Record<string, ScreenSide>;
  swapCmdCtrl: boolean;
  pointerScale: number;
  invertScroll: boolean;
  clipboardOnCross: boolean;
  edgeDrop: boolean;
  /** open http(s) links that paired devices send in this machine's browser */
  acceptLinks: boolean;
  /** "Send & open": open received documents in their default app (allowlisted types only) */
  openSentFiles: boolean;
  /** let paired devices view this machine's screen (each connection still asks) */
  allowScreenView: boolean;
  /** local bridge for the browser extension (127.0.0.1 only, token protected) */
  /** let paired devices run programs in this machine's job workspaces (each job still needs approval here) */
  allowJobs: boolean;
  browserBridge: boolean;
  browserBridgePort: number;
  browserBridgeToken: string;
  /** the one extension allowed to use the bridge (learned on first use; reset with a new token) */
  browserBridgeOrigin: string;
}

export type ScreenSide = 'left' | 'right' | 'top' | 'bottom';

export interface ForwardRule {
  id: string;
  peerId: string;
  listenPort: number;
  remotePort: number;
  enabled: boolean;
}

export interface Shortcut {
  id: string;
  label: string;
  command: string;
}

interface Persisted {
  identity: { pub: string; priv: string };
  settings: Settings;
  peers: Record<string, PeerRecord>;
  forwards: ForwardRule[];
  shortcuts: Shortcut[];
}

/** Optional at-rest protection for the private key (Electron safeStorage in the app). */
export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

const plainBox: SecretBox = {
  encrypt: (s) => 'plain:' + s,
  decrypt: (s) => (s.startsWith('plain:') ? s.slice(6) : s),
};

export const DEFAULT_PORT = 47821;

export class Store {
  private data: Persisted;
  readonly identity: Identity;
  private file: string;

  constructor(readonly dir: string, private box: SecretBox = plainBox, defaults: Partial<Settings> = {}) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'config.json');
    let loaded: Partial<Persisted> = {};
    try {
      loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* first run */
    }
    let ident = loaded.identity;
    if (!ident) {
      const g = generateIdentity();
      ident = { pub: g.pub, priv: this.box.encrypt(g.priv) };
    }
    this.data = {
      identity: ident,
      settings: {
        deviceName: os.hostname().replace(/\.local$/, ''),
        listenPort: DEFAULT_PORT,
        clipboardSync: true,
        clipboardImages: true,
        // off until the user opts in: a paired device can otherwise write files here / reach this machine's localhost
        acceptFiles: false,
        downloadsDir: path.join(os.homedir(), 'Downloads', 'DevLink'),
        allowForwarding: false,
        inputSharing: false,
        allowRemoteInput: false,
        inputLayout: {},
        swapCmdCtrl: true,
        pointerScale: 1,
        invertScroll: false,
        clipboardOnCross: true,
        edgeDrop: true,
        acceptLinks: false,
        openSentFiles: false,
        allowScreenView: false,
        allowJobs: false,
        browserBridge: false,
        browserBridgePort: 47823,
        browserBridgeToken: '',
        browserBridgeOrigin: '',
        ...defaults,
        ...(loaded.settings ?? {}),
      },
      peers: loaded.peers ?? {},
      forwards: loaded.forwards ?? [],
      shortcuts: loaded.shortcuts ?? [],
    };
    this.identity = loadIdentity(this.data.identity.pub, this.box.decrypt(this.data.identity.priv));
    this.save();
  }

  private save(): void {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get settings(): Settings {
    return this.data.settings;
  }
  updateSettings(patch: Partial<Settings>): void {
    Object.assign(this.data.settings, patch);
    this.save();
  }

  get peers(): PeerRecord[] {
    return Object.values(this.data.peers);
  }
  getPeer(id: string): PeerRecord | undefined {
    return this.data.peers[id];
  }
  putPeer(p: PeerRecord): void {
    this.data.peers[p.id] = p;
    this.save();
  }
  removePeer(id: string): void {
    delete this.data.peers[id];
    delete this.data.settings.inputLayout?.[id];
    this.data.forwards = this.data.forwards.filter((f) => f.peerId !== id);
    this.save();
  }

  get forwards(): ForwardRule[] {
    return this.data.forwards;
  }
  setForwards(f: ForwardRule[]): void {
    this.data.forwards = f;
    this.save();
  }

  get shortcuts(): Shortcut[] {
    return this.data.shortcuts;
  }
  setShortcuts(s: Shortcut[]): void {
    this.data.shortcuts = s;
    this.save();
  }
}
