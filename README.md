# DevLink

Use your Mac and your Windows PC as one developer setup. DevLink is an Electron + TypeScript app that talks
directly between your machines over the local network (no cloud, no account).

| Feature | What it does |
|---|---|
| **Secure pairing** | One-time pairing with a 6-digit code you confirm on both screens. After that, devices recognise each other by key. |
| **Device status** | Shows the other machine's uptime, RAM, LAN IP and which dev tools it has (git, node, npm, docker, python, go, cargo, java). |
| **Clipboard sync** | Text and images you copy on one machine appear on the other. Toggle in the Clipboard tab. |
| **File & folder drop** | Drag files/folders onto the window or use the buttons. They land in `Downloads/DevLink/<device name>/` and never overwrite existing files. |
| **Port forwarding** | `ssh -L` style: open `localhost:3000` on the Mac to reach the dev server on the PC's `localhost:3000`, over the encrypted link. |
| **Shortcuts** | Saved terminal commands (one click opens Terminal / cmd) plus auto-suggested `ssh user@ip` for each connected device. |

## Security model

* Each install has a long-term **Ed25519 identity key** (private key protected with the OS keystore through Electron `safeStorage` when available).
* Every connection does an ephemeral **X25519** key exchange, derives per-direction keys with HKDF, and encrypts all traffic with **AES-256-GCM**. Both sides sign the handshake transcript, so only a paired device can connect.
* **Pairing** needs "Allow pairing" switched on at one end (2-minute window, closes after 3 failed attempts), and a **short authentication string**: both screens show the same 6 digits derived from the handshake. The initiator commits to its handshake message before seeing the other's, so a man-in-the-middle can't pick a matching code. Only confirm if the codes are identical.
* Unknown devices are rejected; "Unpair" removes a device immediately.
* Port forwards listen on `127.0.0.1` only, and the far side only connects to its own `127.0.0.1`. It can be disabled in Settings ("Allow paired devices to forward ports").
* Received file paths are sanitised (no `..`, absolute paths, or Windows-reserved names) and confined to the receive folder.
* Shortcut commands only run locally, from your own saved list; a peer cannot trigger commands.
* Traffic stays on your LAN. Do **not** expose the listen port (default 47821) to the internet.

Protocol details are in [`src/main/protocol.ts`](src/main/protocol.ts).

## Requirements

* Node.js 20+ (developed on Node 24) and npm
* macOS 12+ or Windows 10/11, both machines on the same network/subnet

## Run it (development)

```bash
npm install
node node_modules/electron/install.js   # only needed if npm skipped Electron's download script
npm start
```

Try two instances on one machine (uses separate profiles and ports):

```bash
npm start                # terminal 1: profile "default", port 47821
npm run start:b          # terminal 2: profile "b",       port 47822
```

Useful scripts: `npm test` (integration tests: pairing, clipboard, files, port forward, reconnect, unpair),
`npm run smoke` (launches Electron headlessly and checks the UI boots).

Env vars: `DEVLINK_PROFILE`, `DEVLINK_PORT`, `DEVLINK_DOWNLOADS`, `DEVLINK_PLAINTEXT_KEY=1` (skip OS keystore, dev only).

## Pair your two machines

1. Start DevLink on both (same Wi-Fi/LAN).
2. On machine A: **Devices → Allow pairing**.
3. On machine B: under "Found on your network" press **Pair** next to machine A. If it isn't listed (mDNS blocked), enter A's IP and port 47821 (shown at the bottom-left of A's window).
4. Both windows show a 6-digit code. If identical, click **Codes match** on both.
5. From now on they reconnect automatically whenever both are running.

## Package

electron-builder, output in `release/`:

```bash
npm run dist:mac    # on a Mac  → DevLink-<ver>-arm64.dmg / .zip
npm run dist:win    # on Windows → DevLink Setup <ver>.exe (installer) + portable .exe
```

Build each platform on its own OS (cross-building Windows installers from macOS needs Wine). `.github/workflows/build.yml`
builds both on GitHub Actions if you push this to a repo.
The builds are **unsigned**: on macOS right-click → Open the first time (or `xattr -cr DevLink.app`); on Windows SmartScreen shows
"More info → Run anyway". Code signing / notarization needs an Apple Developer ID and a Windows certificate.
No custom app icon yet (default Electron icon); add `build/icon.icns` and `build/icon.ico`.

## Project layout

```
src/main/protocol.ts   framing, handshake, AES-GCM session
src/main/core.ts       server, dialing, pairing, session registry, UI state
src/main/{clipboard,files,forward,status,discovery,shortcuts}.ts   features
src/main/main.ts       Electron window, IPC, native clipboard adapter
src/preload/           contextBridge API for the renderer
src/renderer/          plain HTML/CSS/JS UI (no framework, no innerHTML for peer data)
src/test/              node:test integration tests
```

## Testing status

Verified on macOS (Apple Silicon): all integration tests; two real Electron instances discovered each other via mDNS, paired through the UI
with matching codes, showed status, and transferred a file and a folder. **Not yet tested on Windows or between two physical machines.**
See [`WINDOWS_TESTING.md`](WINDOWS_TESTING.md).

## Known limitations / ideas

* Shared keyboard/mouse and screen sharing are not included (use Synergy/Barrier/Deskflow or Microsoft Mouse Without Borders alongside).
* No tray icon / run-at-login yet; closing the window quits the app (devices disconnect).
* Received data in file transfers and port tunnels has no receive-side flow control (fine on a LAN, large transfers buffer in memory if the disk is slower than the network).
* Empty folders are not transferred; symlinks are skipped.
* `safeStorage` sync methods are deprecated in Electron 45; Electron is pinned to 45.0.0 until they're migrated.
