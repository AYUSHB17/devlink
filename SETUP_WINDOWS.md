# DevLink – setup guide for the Windows PC (for a human or an AI agent)

**Goal:** get DevLink running on this Windows machine, pair it with the owner's Mac over the local network, and
verify the features. This project was built and tested on macOS only; **nothing has been tested on Windows yet**,
so expect small Windows-specific problems and fix them.

**What DevLink is:** an Electron + TypeScript desktop app. Two machines on the same LAN pair once (6-digit code
shown on both screens), then sync clipboard, send files/folders, forward TCP ports, and show device status.
Architecture and security model: `README.md`. Windows test checklist: `WINDOWS_TESTING.md`.

Rules for an AI agent doing this:
- Work only inside this project folder and the steps below. Don't change firewall rules beyond the single
  DevLink rule below, and don't touch other system settings.
- Don't install anything except Node.js (LTS) if it's missing. Ask the user before other installs.
- Never ask for or print passwords or tokens. The user does any GitHub sign-in themselves.
- If a step fails, read the error, fix the cause in this folder, and report what you changed.

## 1. Prerequisites

Open **PowerShell** and check:

```powershell
node -v    # needs v20 or newer (v24 is what was used)
npm -v
```

If Node is missing, install the **LTS** version from https://nodejs.org (default options), then open a **new**
PowerShell window.

## 2. Install and start

From the project folder (the one containing `package.json`):

```powershell
cd <path to the devlink folder>
$env:NODE_ENV = ""
npm install --include=dev
node node_modules/electron/install.js
npm start
```

Why those flags:
- Electron and TypeScript are **dev dependencies**. If `npm install` reports only ~40 packages, or
  `node_modules\electron\install.js` doesn't exist, dev dependencies were skipped (usually `NODE_ENV=production`
  or `npm config get omit` containing `dev`). Fix: unset `NODE_ENV`, run `npm config delete omit`, and reinstall
  with `--include=dev`.
- `node node_modules/electron/install.js` downloads the Electron binary (~100 MB). npm's install scripts may be skipped.
- If the folder came from a zip made on a Mac, first delete anything built there:
  `Remove-Item -Recurse -Force node_modules, dist, release, .tools -ErrorAction SilentlyContinue`
- `npm start` compiles TypeScript (`tsc`) into `dist/` and launches Electron. A window titled **DevLink** should open.

Quick self-checks that don't need the Mac:

```powershell
npm test          # integration tests, should end with "pass 9, fail 0"
npm run smoke     # prints SMOKE_OK when the window and core boot
```

## 3. Windows Firewall

On first launch Windows asks to allow Electron/DevLink: tick **Private networks**, click **Allow access**.
If it was dismissed, run in an **administrator** PowerShell:

```powershell
New-NetFirewallRule -DisplayName DevLink -Direction Inbound -Protocol TCP -LocalPort 47821 -Action Allow -Profile Private
```

Check the Wi-Fi/Ethernet network profile is **Private** (Settings → Network & internet → your connection → Network profile type).
Device discovery uses mDNS (UDP 5353) and is blocked on Public profiles.

## 4. Pair with the Mac

The Mac must have DevLink running too (`npm start` in its folder) and be on the same network.

1. On **one** machine: Devices tab → **Allow pairing**.
2. On the **other**: under "Found on your network" press **Pair**. If nothing is listed, type the first machine's
   LAN IP and port `47821` under "Or enter an address" (the IP is shown bottom-left in its window).
3. Both windows show a 6-digit code. If the codes are **identical**, click **Codes match** on both. If they differ, click
   "Doesn't match" and retry, and tell the user.
4. The device now shows a green dot and "connected". Later runs reconnect automatically.

## 5. Verify (report each as pass/fail)

- [ ] The Mac appears under discovery (or manual address works)
- [ ] Pairing works, codes matched
- [ ] Status chips for the Mac show (uptime, RAM, tools)
- [ ] Copy text on one machine → paste on the other (both directions). Try a screenshot too.
- [ ] Send a file and a folder Windows → Mac and Mac → Windows (Files tab or drag and drop). Received files appear in
      `%USERPROFILE%\Downloads\DevLink\<device name>\`
- [ ] Ports tab: forward a local port to a server running on the other machine (e.g. run `python -m http.server 8000`
      on the Mac, add forward local 8000 → remote 8000 on Windows, open `http://localhost:8000`)
- [ ] Shortcuts tab: "Open terminal" opens a cmd window (least-tested part; quoting of commands with spaces/quotes)
- [ ] Quit and restart one side: they reconnect within ~5 seconds
- [ ] Optional: `npm run dist:win` builds an installer and portable exe in `release\`

## 6. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Cannot find module ...electron\install.js` | Dev dependencies not installed – see step 2 |
| `tsc` not found / TypeScript errors about `node` types | Same cause; reinstall with `--include=dev` |
| Window opens but Mac never listed | Firewall (step 3), network profile not Private, router "client isolation", or VPN. Use the manual IP:port pairing instead |
| "connect timeout" when pairing by IP | Firewall on the machine being dialed, or wrong IP (use the 192.168.x.x / 10.x.x.x address, not 127.0.0.1) |
| Pair fails with `pairing-disabled` | "Allow pairing" wasn't switched on at the other end, or its 2-minute window expired |
| `EADDRINUSE` / app uses a different port | Another process holds 47821; DevLink falls back to a random port, so use the port shown in the app window |
| App won't start after profile or OS changes | Delete `%APPDATA%\DevLink\devlink\config.json` and re-pair on both machines (the identity key is stored encrypted with Windows DPAPI) |
| Port forward connects but nothing arrives | The remote service is bound to `::1` only; DevLink connects to `127.0.0.1`. Bind the server to `127.0.0.1` or `0.0.0.0` |

## 7. What to report back to the owner

1. Windows version and Node version (`node -v`).
2. Which checklist items passed or failed, with the exact error text for failures.
3. Any code changes made (file and what), so they can be applied to the main copy.
