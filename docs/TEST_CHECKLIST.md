# Two-machine test checklist (Mac + Windows PC)

Nothing here has been run on two real machines or on Windows yet. Tick each box, and write down what you actually
saw next to anything that fails. For basics (firewall prompt, discovery, reconnect, ports, shortcuts) also run
[../WINDOWS_TESTING.md](../WINDOWS_TESTING.md).

## 0. Before you start

- [ ] Both machines on the **same Wi-Fi**, same subnet. Windows network profile is **Private**.
- [ ] Latest code on both. On each: `npm install`, `npm run build:native` (needs Rust), then `npm start`.
      Windows: `cd native\devlink-input; cargo test; .\target\release\devlink-input.exe --probe` prints a `ready` line.
- [ ] macOS: **Accessibility** and **Input Monitoring** granted to DevLink (to Terminal if you use `npm start`).
      System Settings → Privacy & Security. Revoke Terminal's access when you finish testing.
- [ ] Defaults are safe (off). For these tests switch on, on **both** machines: Files tab → accept files, Ports →
      allow forwarding only if you test it, Screens → the two input switches, Remote files → sharing.
- [ ] Make two test files: Mac `mkfile -n 2g ~/big.bin`; Windows `fsutil file createnew C:\big.bin 2147483648`.
      Make a small project folder with a few files, a subfolder, and a `.ssh` folder containing a dummy file.

## 1. Pairing

- [ ] Devices tab: Allow pairing on one machine, Pair on the other. Both show the **same 6 digits**.
- [ ] Say "Codes match" on only one side and let the other time out: nothing is saved, no device listed.
- [ ] Unpair, then pair from the other direction. Both directions work.
- [ ] Pairing window closes by itself after ~2 min, and after 3 failed attempts.

## 2. Remote files

- [ ] Off by default: from the other machine, Connect shows "has not turned on folder sharing".
- [ ] Share a project folder read-only; browse it from the other machine. `.ssh` does **not** appear.
- [ ] Copy here saves into `Downloads/DevLink/<device>/` and never overwrites an existing file.
- [ ] Edit is **absent** on a read-only share. Tick "Allow editing", then Edit opens the file in your normal editor.
- [ ] Save in the editor: the change appears on the sharing machine within a second or two ("saved").
- [ ] Change the same file on the sharing machine, then save in the editor: refused, "changed on the other
      device", your copy kept. Stop editing removes the temp copy.
- [ ] "Recent access" on the sharing machine lists the browse, the edit, and any refused attempt.
- [ ] Try sharing your home folder and a whole drive: refused.

## 3. Shared mouse and keyboard (Screens tab)

- [ ] Arrangement: set which side the other device is on; the other machine shows it as a **suggestion** with
      "Use this". Accept it there.
- [ ] Cursor leaves the facing edge and appears at the same height on the other machine, and comes back.
- [ ] Typing, click, drag a window, scroll, right-click, double-click all work on the other machine.
- [ ] Cmd on Mac acts as Ctrl on Windows (copy/paste), and back. Turn the swap off and confirm it stops.
- [ ] Different resolution or display scaling: pointer lines up proportionally; adjust pointer speed if needed.
- [ ] Does not cross while a mouse button is held (a drag).
- [ ] Clipboard follows the cursor when "Send my clipboard along" is on, and not when it is off.

## 4. Consent (every connection)

- [ ] First time the cursor crosses, the controlled machine shows **Allow remote control?** and a notification;
      the leader says it is waiting. Click Allow, cross again: it works.
- [ ] "Don't allow": further crossings stay refused until reconnect.
- [ ] Quit and restart either DevLink (or switch Wi-Fi off and on): you are asked **again**.
- [ ] While being controlled, a banner shows at the top of the screen with the take-back hint, the window title
      says "controlled by", and the Dock shows a badge (macOS). The banner never blocks clicks.
- [ ] With "Allow paired devices to control this machine" off, crossing is refused with a clear message.

## 5. Escape hotkey and take-back

- [ ] While leading, press **Ctrl + Option/Alt + Shift + Esc**: your own mouse and keyboard work again at once,
      on both Mac and Windows.
- [ ] Do the same while the other app is busy (macOS: pause DevLink with Activity Monitor → Sample, or
      `kill -STOP` the Electron process). Local input returns anyway.
- [ ] Move the controlled machine's own mouse or press a key: control returns to it.
- [ ] No keys or buttons left stuck on either machine afterwards (try with a modifier held during the release).

## 6. Watchdog and lost connection

- [ ] While leading, turn Wi-Fi off on the controlled machine: your input returns within about 2 s and a notice
      says contact was lost.
- [ ] While leading, `kill -STOP` the leader's Electron process for ~5 s, then `kill -CONT`: both sides end
      control and return to normal (no stuck "leading" or "being controlled" state).
- [ ] Kill the helper (`devlink-input`) while leading: control ends, the helper restarts, no stuck input.
- [ ] Windows: leave the app running for a while with input idle, then use the mouse. The hooks still work
      (logs may say "input hooks were removed by Windows; reinstalled").

## 7. Edge drop (flick)

- [ ] Start dragging a file toward the shared edge: a slim "Drop to send to <device>" strip appears there.
- [ ] Release **straight away** over it: nothing sends and it says to hold a moment. Hover ~0.5 s, then drop: the
      file arrives in the other machine's `Downloads/DevLink/<device>/` with a notification.
- [ ] The strip stays clear of the Dock or taskbar, and disappears after the drag (and within 15 s regardless).
- [ ] With "Accept files" **off** on the receiver: you get a "couldn't send" notification and the sender stops
      quickly (a 2 GB file must not stream for minutes).
- [ ] Drop a folder with nested files: structure arrives intact.

## 8. Cursor lag during a big Wi-Fi transfer

- [ ] Baseline: shared mouse over Wi-Fi with no transfer. Note how it feels, and measure if you can: film both
      screens with a phone in slow motion and count frames between the leader moving and the follower moving.
- [ ] Start sending `big.bin` (2 GB) from one machine to the other. While it runs, lead across and move in
      circles, click, type. Compare with the baseline.
- [ ] Repeat with the transfer going the opposite way, and with a folder of many small files.
- [ ] Result to record: baseline lag ____ ms, during transfer ____ ms. Anything above ~100 ms or visible
      stutter means input should get its own connection or a smaller transfer window.
- [ ] Transfer still finishes, with sensible speed and no memory growth in Task Manager / Activity Monitor.

## 9. Safety checks

- [ ] Unpair while being controlled: control ends immediately.
- [ ] Windows only: input does not reach an elevated (admin) window or a UAC prompt, and Ctrl+Alt+Del cannot be
      sent. This is expected; confirm the controlling side is never left holding input.
- [ ] macOS Secure Input (focus a password field or Terminal with Secure Keyboard Entry): a notice appears that
      typing cannot be forwarded.

## Results log

| section | pass / fail | what you saw |
|---|---|---|
| 1 Pairing | | |
| 2 Remote files | | |
| 3 Mouse and keyboard | | |
| 4 Consent | | |
| 5 Hotkey | | |
| 6 Watchdog | | |
| 7 Edge drop | | |
| 8 Lag (baseline / during) | | |
| 9 Safety | | |
