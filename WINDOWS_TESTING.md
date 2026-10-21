# Checklist for the Windows machine (untested there so far)

Setup: install Node 20+ (or run the packaged `.exe` built with `npm run dist:win`), `npm install`, `npm start`.

1. **Firewall prompt** – on first start Windows Defender Firewall asks to allow Electron/DevLink: allow on *Private* networks. Without it the Mac can't reach port 47821. If the prompt was dismissed: `New-NetFirewallRule -DisplayName DevLink -Direction Inbound -Protocol TCP -LocalPort 47821 -Action Allow -Profile Private` (admin PowerShell). mDNS discovery uses UDP 5353.
2. **Discovery** – does the Mac appear under "Found on your network"? If not, check the network profile is Private (not Public) and fall back to entering the Mac's IP:47821. Also check the Mac's *Local Network* permission prompt (System Settings → Privacy → Local Network) was allowed for DevLink/Electron.
3. **Pairing** – both codes match; pair from each direction at least once (Mac→Win and Win→Mac) after unpairing.
4. **Reconnect** – quit and restart either side; they should reconnect within ~5s. Also try sleep/wake and switching Wi-Fi.
5. **Clipboard** – text both ways, a screenshot (image) both ways, large text (~1 MB). Check no echo loops.
6. **Files** – send a single file, a folder with nested folders, a >1 GB file; names with spaces/unicode; a file named like `CON.txt` or with `:` should be renamed safely. Confirm "Show" opens Explorer.
7. **Port forward** – Mac `localhost:3000` → Windows dev server (and reverse). Windows servers bound only to `::1` (IPv6) won't be reachable since DevLink connects to `127.0.0.1`; bind to 127.0.0.1/0.0.0.0.
8. **Status** – tool chips: `npm`/`python3` detection (on Windows the app probes `python`, and runs via `cmd` for `.cmd` shims); `java -version`.
9. **Shortcuts** – "Open terminal" on Windows (`cmd /k`): quoting of commands with spaces/quotes is the least-tested piece. SSH suggestions need *OpenSSH Server* on Windows (Settings → Optional features) and *Remote Login* on macOS.
10. **safeStorage** – confirm the identity survives restarts on Windows (DPAPI). If the app fails to start after an OS profile change, delete `%APPDATA%\DevLink\devlink\config.json` and re-pair.
11. **Packaging** – `npm run dist:win` produces working installer + portable exe; note SmartScreen warning.
