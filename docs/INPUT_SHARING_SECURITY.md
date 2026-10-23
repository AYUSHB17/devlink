# Shared mouse & keyboard: security review and wire spec

Companion to [INPUT_SHARING.md](INPUT_SHARING.md). Written as a review of that design, not a replacement.

Sources: the DevLink code as of this branch, plus background knowledge. Items marked **(verify)** come from background
knowledge or thin search results and must be checked against Apple/Microsoft documentation or by testing before relying
on them.

## 1. What changes in the threat model

Until now a paired device could, at worst, write files into one folder, reach `localhost` (both now off by default) and
write the clipboard. Remote input is different: **injected keystrokes can open a terminal and run anything.** A paired
peer that is compromised, or a stolen unlocked laptop, becomes full control of the machine it leads.

So the pairing trust boundary is no longer enough on its own. Decisions the user already made:

* Either machine may lead.
* Control must be **confirmed every session**, not granted once.
* First flick = drag a file to the screen edge.

## 2. Required changes to the current design

### 2.1 Per-session consent (not a single boolean)

`Settings.allowRemoteInput` is one global switch. Keep it as "this machine is willing to be controlled at all", but add
a **per-session confirmation**:

1. A peer sends `input-enter` while we are `local` and have no live approval for this session.
2. We show a modal: *"<peer name> wants to control this <Mac/PC>. Allow for this session / Deny"*, and reply
   `input-deny` until answered (or `input-wait` so the leader shows "waiting for approval").
3. Approval is stored **in memory only**, keyed by the session object. It is cleared when the session closes, the app
   restarts, or the user clicks "Stop being controlled". A reconnect needs a new approval.
4. The prompt must not be answerable by injected input. While a prompt is open, drop `input-ev` and do not inject
   anything (otherwise a leader could press the Allow button itself). The prompt should require a **physical** click,
   so the helper must report injected-vs-physical (see 2.4).

### 2.2 Gate on state, not only on the setting

The follower handler must ignore `input-ev` unless the machine is in `following(peer)` for that exact peer, reached via
consent. Checking only `allowRemoteInput` would let a peer skip `input-enter` and stream events directly.

### 2.3 Kill switch lives in the helper

If the leader's helper swallows local input and then hangs, the user is locked out of their own machine. So:

* The escape hotkey (`Ctrl+Alt/Option+Shift+Esc`) is detected **inside the helper's hook callback**, synchronously,
  and releases capture without any round trip to Electron or the network.
* Watchdog: Electron sends a heartbeat to the helper (e.g. every 250 ms). If none arrives for ~1 s the helper stops
  swallowing input and goes back to `local`.
* macOS may disable an event tap whose callback is too slow (`kCGEventTapDisabledByTimeout`), and Windows removes a
  low-level hook whose callback exceeds the hook timeout. Callbacks must only enqueue and return. Re-enable the tap on
  the disable notification. **(verify exact timeouts)**

### 2.4 Distinguish physical from injected input

Takeback relies on `local_activity`, but the follower's own helper sees the events it injects. It must tag its own
injected events and ignore them: Windows hooks carry an injected flag (`LLMHF_INJECTED` / `LLKHF_INJECTED`); on macOS
set a marker in the event's user-data field and filter on it. **(verify)** Without this, either takeback fires
immediately or, if filtered wrongly, a malicious leader could suppress takeback.

### 2.5 Validate everything the leader sends

The follower treats the leader as untrusted. Reject or clamp:

| field | rule |
|---|---|
| position fractions | finite, clamped to 0..1 |
| key code | integer in the supported HID usage range only |
| button | one of left/right/middle/x1/x2 |
| scroll delta | integer, clamped (e.g. ±2000 px per event) |
| event rate | cap (e.g. 1500 events/s); drop and log beyond that |
| held keys/buttons | cap the number held; release all on leave, deny, takeback, session close |
| message size | one event per message, small JSON; coalesce moves in batches of at most ~16 |

### 2.6 Leader and follower race

If we are `leading` or `following` and receive `input-enter`, answer `input-deny`. With two devices this is enough;
with more, define a single tie-break (lowest device id leads), as `core.adopt` already does for sessions.

### 2.7 One shared TCP connection (functional problem)

All traffic uses one TCP connection per peer. Two consequences:

* **Head-of-line blocking.** Input events queue behind file chunks already in the socket. During a large transfer the
  cursor will lag.
* **Backpressure freezes input.** The new receive-side flow control in `files.ts` calls `sock.pause()` on the shared
  socket while the disk catches up. That stops reading *every* frame, including mouse and key events from the peer,
  and for more than 35 s the paused side stops updating `lastRx` and may drop the session.

Options, in order of preference:

1. **A second authenticated connection for input** (same handshake and identities, marked as the `input` channel).
   Input never waits behind file data, and pausing the file socket cannot stall it. Costs one more handshake and a
   rule that the input channel only exists while a file or consent session exists.
2. Keep one connection but window file transfers at the application level (a credit-based "send at most N KB, wait
   for an ack"), and never call `sock.pause()` for flow control.
3. Accept lag during big transfers and document it. Not recommended for a "one desktop" feature.

## 3. Wire spec (additions)

Messages are JSON on the existing encrypted session (or the input channel from 2.7). `Core` dispatches on the prefix
before the first `-`, so everything below uses the `input` prefix.

| message | direction | fields | notes |
|---|---|---|---|
| `input-enter` | leader → follower | `pos` (0..1), `side` | requests control; triggers 2.1 |
| `input-ok` | follower → leader | | consent given and cursor placed |
| `input-deny` | follower → leader | `reason` | busy, not allowed, declined |
| `input-wait` | follower → leader | | prompt is showing |
| `input-ev` | leader → follower | `e`: array of events | see below |
| `input-leave` | follower → leader | `pos` | cursor hit the return edge |
| `input-takeback` | follower → leader | | physical input detected on follower |
| `input-end` | either | `reason` | release everything |
| `input-layout` | either | `side` | mirror image stored by peer |
| `input-clip` | leader → follower | uses the existing `clip` payload | only if "clipboard on cross" is on |

Events in `e`: `{k:"m", dx, dy}`, `{k:"b", b, d}` (button, down/up), `{k:"w", dx, dy}`, `{k:"k", c, d}` (HID code,
down/up). Mouse moves are relative while following; absolute positions are only used in `input-enter` and
`input-leave`.

## 4. Other findings

* **Clipboard on crossing.** Honour "concealed" clipboard content so a password manager entry is not pushed to the
  other machine. macOS password managers mark such items with the `org.nspasteboard.ConcealedType` convention and
  Windows has `ExcludeClipboardContentFromMonitorProcessing`. **(verify)**
* **File flick vs the new defaults.** Dropping a file on the edge strip only works if the other machine has "Accept
  files" on, which is now off by default. The strip must show the `file-reject` reason ("receiving is turned off on
  that device") instead of silently doing nothing.
* **Development permissions.** If the helper runs under Terminal during development, macOS grants Accessibility and
  Input Monitoring to *Terminal*, so every script run from Terminal inherits them. Revoke afterwards, and in release
  builds grant them to the signed DevLink app/helper only.
* **Helper integrity.** Electron should spawn the helper from its own resources directory by absolute path, never from
  `PATH` or a user-writable folder. The IPC is the child's stdin/stdout, so other local users cannot reach it.
* **Visible indicator.** The follower shows a persistent banner ("Being controlled by <peer>. Press <hotkey> or move
  your mouse to take back control") for as long as it is `following`. Keep an audit log of the last N sessions
  (peer, start, end, how it ended).
* **macOS secure input.** Password fields and some apps enable Secure Input, which stops event taps from seeing
  keystrokes system-wide. Reports exist of apps (including password managers) leaving it stuck on, which would make
  typing on the leader silently stop crossing. Detect it (`IsSecureEventInputEnabled`) and show a warning in the UI
  instead of failing silently. **(verify)**
* **Windows elevation.** Injected input cannot reach elevated windows, UAC prompts or the lock screen unless the
  helper is elevated. Elevating a helper that accepts network-driven input raises the stakes, so do that last, as a
  separate service with its own consent.
* **Crates.** `rdev` (listen, send, optional `unstable_grab`) exists but the search showed it needs the process to
  have Accessibility on macOS and is lightly maintained, with forks. A thin hand-written layer over the platform
  APIs is likely safer for a security-sensitive helper. **(verify before choosing)**

## 5. Test plan (security-relevant)

* Fake-helper unit tests for the state machine, including: events with no `input-enter`; events after `input-end`;
  events from a peer that is not the current leader; consent cleared on session close; simultaneous `input-enter`.
* Fuzz the follower validation table in 2.5.
* Manual: kill the helper while leading and confirm local input returns within ~1 s; press the escape hotkey; unplug
  the network while leading; start a large file transfer and watch cursor latency.

## 6. Review of the implementation (input.ts, input-helper.ts, native/devlink-input)

Reviewed by reading the code as it stood while the author was still mid-change, so items the author already has queued
(per-session consent, helper-side hotkey and watchdog, event/held-key caps, file flow control, edge-drop reject
notice) are noted but not repeated in detail. Line numbers refer to that snapshot. Items marked **(verify)** need a
test on real hardware.

### What is solid

* Remote events are only injected in `following(peer)` for the matching peer (`input.ts` `input-ev` case), not merely
  because a setting is on.
* The helper only talks over its own stdin/stdout pipes, has no socket, releases everything when stdin closes or on
  `quit`, and only injects keys that exist in the keymap.
* Injected events are tagged so `local_activity` ignores them; the macOS tap re-enables itself after a timeout.
* Moves, wheel and buttons are clamped in `inject`, the follower position fractions are clamped, and `input-ev` per
  message is capped at 256.

### Findings

| # | severity | where | issue | fix |
|---|---|---|---|---|
| 1 | medium-high | `input.ts` leading state | No liveness check while leading. If Wi-Fi drops mid-control the leader keeps swallowing local input until `core` notices after 35 s. The ack timer only covers the first 1.5 s. | Follower sends `input-alive` every ~500 ms; leader releases after ~2 s of silence. |
| 2 | medium | `macos.rs` ~268, `windows.rs` ~176 | The escape hotkey only emits `hotkey`; `capturing` stays true until Electron answers. A busy or hung main process means no escape. (Queued by the author.) | In the callback itself: set `capturing=false`, re-associate the cursor, then emit. |
| 3 | medium | `core.ts` `adopt` ~272, ~287 | When a session is replaced, the old one is deleted from the map before it closes, so the "peer down" handlers never run. Input state (and any consent keyed by peer id) survives a reconnect. | Key consent to the `Session` object; in `input.ts` reset in `onPeerUp` if `m.peer === peerId`; or have `adopt` run the down handlers on replacement. |
| 4 | medium | `input.ts` `input-layout` ~288 | Any paired peer can silently rewrite this machine's screen layout (and evict another peer from a side). With `input-hello allow:true`, an accidental push on that screen edge hands the peer the mouse **and every keystroke**, including passwords. | Do not accept layout from the peer, or only when none is set, or ask the user. Layout is set from the local UI on both sides. |
| 5 | low-medium | `input.ts` `onEdge` ~239, `clipboard.ts` `force` | Clipboard is pushed right after `input-enter`, before the ack or consent, with `force:true`, which also overrides the peer's "clipboard sync off". A denied peer still receives it. | Push only after `input-ack`; honour `force` only inside an active control session. |
| 6 | low-medium | `windows.rs` `run` ~330 | Windows silently removes a low-level hook whose callback exceeds the timeout. Nothing notices, so capture and edge detection just stop. **(verify)** | Time the callbacks, or periodically verify and re-install hooks, and report an `error` event. |
| 7 | low-medium | `main.rs` ~96-102, ~276 | Every mouse move is serialised to JSON on the hook thread and queued on an unbounded channel. If Electron stalls, memory grows and cursor lag builds. | Coalesce moves inside the helper (sum deltas per ~8 ms), use a bounded channel and drop stale moves. |
| 8 | low | `main.rs` `MAGIC` | A fixed, public marker. Any local process can tag events to bypass swallowing and takeback detection; two DevLink instances on one machine also ignore each other. | Random per-process value generated at start. |
| 9 | low | native capture | **(verify)** Swallowed key-ups on Windows can leave the OS believing a modifier is held; macOS Secure Input silently stops key capture, so typing stays local while the mouse is captured. | Synthesise key-ups for physically held keys when capture toggles; detect Secure Input and warn. |
| 10 | low | `windows.rs` Wheel ~307 | `(dy * 120 / 100) as u32` trusts the TypeScript clamp. | Clamp inside the helper too (defence in depth). |
| 11 | low | `input-helper.ts` | The restart counter is never reset after a healthy run, so after five crashes ever the helper stops restarting. `DEVLINK_INPUT_HELPER` and the `target/debug` fallback are honoured in packaged builds. | Reset the counter after a stable period; ignore env and dev paths when `app.isPackaged`. |

### Also noticed in code I wrote

`RemoteFs` requests that are waiting when a session is *replaced* (finding 3) are not failed immediately; they time
out after 15 s. Harmless, but the same fix to `adopt` would cover it.

## 7. Re-review (checkpoint, other session still mid-pass)

Checked against the tree as it stood after the author's first fix pass. TypeScript tests: 35 of 35 pass. Rust:
`cargo test` passes on macOS (one keymap test; the Windows backend cannot be built or run on a Mac, so everything
Windows-specific below is read-only review). Nothing here was tested on two real machines.

### Status of the section 6 findings

| # | finding | status |
|---|---|---|
| 1 | no liveness check while leading | **fixed**: `input-hb` both ways every 500 ms, release after 2 s (`input.ts`) |
| 2 | hotkey needs the app to answer | **fixed**: `hotkey_release()` clears capture in the callback; macOS also re-associates the cursor |
| 3 | replaced session skips down handlers | **fixed**: `core.adopt` now runs them; consent is also checked against the live `Session` object |
| 4 | peer can rewrite our layout | **fixed**: a new side from a peer is only a suggestion the local user must accept; removal is applied |
| 5 | clipboard sent before consent | **fixed**: pushed after `input-ack`, as `cross`, which the receiver honours only if clipboard-on-cross is on |
| 6 | Windows hooks silently removed | **implemented, untested here**: reinstall when `GetLastInputInfo` shows input the hooks missed |
| 7 | unbounded output queue | **fixed**: bounded channel, moves summed in the helper and flushed at ~250 Hz |
| 8 | fixed public MAGIC | **fixed**: random per process |
| 9 | stuck modifiers, Secure Input | **mostly fixed**: `pre_held` keys' releases reach the OS; macOS reports Secure Input. Verify on Windows |
| 10 | Wheel arithmetic trusts TS | **fixed**: clamped again in the helper (also keys 0x04..0xe7 and buttons 0..4) |
| 11 | restart counter, packaged lookup | **still open** (`input-helper.ts`: `restarts` never reset; `DEVLINK_INPUT_HELPER` honoured when packaged) |

Also good: caps on events per second (3000) and held keys (32), consent that must come from a click while not being
controlled, per-session denial that stays denied until reconnect, and a flow-control window in `files.ts` instead of
`sock.pause()`.

### Still open or new

| # | severity | where | issue | fix |
|---|---|---|---|---|
| A | medium | `main.rs` watchdog vs `input.ts` `case 'error'` | When the watchdog fires (no command for 3 s, for example because the main process is busy), the helper drops capture and emits only an `error`. `input.ts` stays in `leading`, keeps sending heartbeats, and the peer stays in `following`. The user's own input works again but neither side leaves control mode. | Emit a distinct `{ev:'released', reason}` from the watchdog and handle it like `hotkey`: send `input-release`, then `release()`. |
| B | medium-low | `files.ts` `sendPaths` | After a `file-reject` (receiving is off, now the default) the sender keeps streaming the whole folder, the receiver discards and acks it, and it sends one `file-reject` per file. | Stop the batch when a reject arrives (`t.state === 'error'`); send one reject per batch. |
| C | low-medium | `files.ts` receiver | The window is cooperative. A paired peer with receiving on can ignore it and send unbounded data into the write stream's memory, or announce huge sizes (no quota, no free-space check). | Close the session if unacknowledged bytes exceed about twice the window; check announced size against free space. |
| D | low | `edge-strip.ts` / `strip.js` | A drop on the strip sends immediately with no dwell or confirmation, and the strip covers a 40 px edge, so a drop meant for a Dock or panel on that edge can send the file to the other device. The strip is shown for any left-drag, and stays up if a mouse-up is missed. The strip window gets the full `window.devlink` API (`answerConsent`, `runCommand`, `rfs.*`). | Require a short hover before accepting, auto-hide after ~15 s, and give the strip its own minimal preload (`pathForFile`, `sendPaths`). |
| E | low | `files.ts` | 16 MB window plus one connection for everything. I could not measure whether a large transfer makes the cursor lag; sockets are drained (`sendBin` waits), so the queue ahead of an input event is probably small. | Measure cursor latency during a big transfer over Wi-Fi; if it lags, shrink `WINDOW`/chunks or move input to its own connection. |
| F | info | `windows.rs` `check_hooks` | The reinstall heuristic compares `GetLastInputInfo` with the last tick the hooks saw. Plausible, but it can reinstall during capture (a gap in swallowing) and it needs a Windows test. | Test with a long-running hook and during capture. |

## 8. Second pass re-review

Tree after the author's second pass. TypeScript tests 35 of 35, `cargo test` passes on macOS; Windows code is review-only.

* **Section 6 findings 1-11: all fixed or implemented.** Item 11 is now done: restarts reset after 60 s of uptime, and
  a packaged app only uses the helper bundled in its resources (no env override, no dev paths).
* **Added in this pass:** consent notification, and a "controlled by <peer>" window title and macOS Dock badge.
* **Section 7 items still open** (the author's second pass did not touch them; they may have been queued behind it):

| # | severity | status |
|---|---|---|
| A | medium | **open.** The watchdog still reports only `{ev:'error'}`, and `input.ts` `case 'error'` just logs, so a fired watchdog leaves `leading`/`following` stuck on both machines. Needs a `released` event handled like `hotkey`. |
| B | medium-low | **open.** `files.ts` still streams a whole rejected folder and sends one `file-reject` per file. |
| C | low-medium | **open.** No receiver-side limit on unacknowledged data or announced size. |
| D | low | **open.** Edge strip has no hover dwell or maximum-visible timer and still uses the full preload. |
| E | low | **open.** Cursor latency during a large transfer over Wi-Fi is unmeasured. |
| F | info | **open.** The Windows hook-health heuristic needs a test on Windows. |

* **New, low:** the "being controlled" indicator is a window title and Dock badge. If the DevLink window is behind other
  windows, the person at the controlled machine gets no strong visual cue beyond the consent notification. An
  always-on-top banner with the escape hotkey hint would match the original spec.

## 9. Final re-review of the checkpoint items

Diffed the working tree against the author's commit `1e6d1b6`. TypeScript tests 37 of 37, `cargo test` passes on macOS,
Windows code is review-only.

| item | result |
|---|---|
| A watchdog desync | **fixed.** The helper emits `released`; `input.ts` ends control on both sides (leader sends `input-release`, follower `input-takeback`). A test covers it. |
| B rejected transfer keeps streaming | **fixed.** The file and chunk loops stop on reject, the receiver rejects once per batch, and the reject names the batch. A test covers it. |
| C receiver limits | **fixed.** The session is closed if unwritten bytes exceed 2x the window; free space is checked per batch and per file with 256 MB headroom. |
| D edge strip | **fixed.** Strip-only preload (`pathForFile`, `drop`), target chosen by the main process from the strip's window id, 400 ms hover before a drop counts, 15 s maximum visible, work area so the Dock and taskbar are left alone. |
| 11 helper restarts and packaged lookup | **fixed** (previous pass). |
| E latency during a transfer | **unmeasured.** Needs two real machines over Wi-Fi. |
| F Windows hook health | **untested.** Needs a Windows test. |

### Remaining, all low

* `files.ts` `rejected` set is keyed by a peer-supplied batch string with no length or size limit. A paired peer with
  receiving off could grow it (a batch string can be up to one 16 MB frame). Require a string of at most ~64
  characters and cap the set size.
* The "being controlled" cue is still only the window title and Dock badge; an always-on-top banner with the escape
  hotkey hint would be a stronger cue on the controlled machine.
* Nothing has been run on two physical machines or on Windows. That is the real remaining risk.

### 9.1 Control banner (`control-banner.ts`, `banner.html/css/js`)

Read, not rendered (I could not get a local preview server running, and a real "following" session is needed to see
it in the app). Security-wise it is fine: no preload and no API, sandboxed, strict page policy, click-through
(`setIgnoreMouseEvents`), non-focusable, always on top, device name written with `textContent`. This closes the weak
"controlled by" cue from section 8.

Cosmetic risk, estimated from the CSS only: the window is 560 x 44 px and the message is roughly 105 characters at 13 px
bold, so it likely wraps to two lines, and a long device name (up to 100 characters) could be clipped by
`overflow: hidden`. Shorten the text or truncate the name. Check it once in a live session.

The `rejected` set limit from section 9 ("Remaining, all low") is not in yet.

## 10. Review: links, browser extension, send-and-open, screen view

Read-only review of the uncommitted tree (`browser-bridge.ts`, `links.ts`, `screen.ts`, `screen-windows.ts`,
`screen-preload.ts`, `extension/`, the new parts of `main.ts`, `files.ts`, edge strip and banner). TypeScript tests
44 of 44 pass. Nothing was run on two real machines, and WebRTC has only been tried between two instances on one
Mac with a fake screen.

### Good (verified in the code)

* **Bridge:** 127.0.0.1 only, off by default, token in a header compared in constant time, `Host` must be
  localhost/127.0.0.1 (DNS rebinding), web-page `Origin` refused, `OPTIONS` refused, no CORS headers, 64 KB body cap,
  request rate limit, and the first extension to use the token is pinned (others refused until a new token).
* **Links:** `cleanUrl` allows http/https only, no embedded credentials, 4096 characters; off by default; capped per
  send and per minute; the extension and the edge strip both go through the same checks.
* **Send and open:** off by default; allowlist of document/media types, single file only; everything else is only
  shown in its folder; opened files get the macOS quarantine flag or the Windows mark-of-the-web first.
* **Tab hotkey:** the browser name is checked against a fixed list before it goes into AppleScript, `execFile`
  (no shell), no user text is interpolated.
* **Screen view:** off by default; consent per connection kept in memory against the `Session` object; consent
  clicks ignored while this machine is being remotely controlled; signalling only over the encrypted session;
  `iceServers: []`; the window-to-stream mapping lives in the main process; the preload exposes only that stream's
  controls; the banner is excluded from screen capture and has its own stop button; streams end on connection loss
  or replacement.

### Still open

| # | severity | where | issue | fix |
|---|---|---|---|---|
| 1 | medium-low | `screen.ts` `screen-req` | While a consent prompt is open, every new `screen-req` from the same peer is pushed onto `prompt.sids` with no limit, and the `MAX_SHARES` check only counts streams already started. One click on Allow then starts all of them, each with its own capture window. | Cap pending requests (count them with the started streams) and re-check `MAX_SHARES` in `startSharing`. |
| 2 | medium-low | `main.ts` `markFromNetwork` | Quarantine and mark-of-the-web are applied only to a single file that is being auto-opened. Everything else received (files, and every file inside a received folder) is unmarked, so Gatekeeper, SmartScreen and Office Protected View do not apply when you open it later. | Mark every received file (including folder contents) when its transfer completes. |
| 3 | low | `main.ts` `screen.on('consent')` | A screen-view request restores and focuses the DevLink window and raises a notification, and a peer can repeat it. That steals focus, and a stray keypress can land on the dialog. | Notification and Dock bounce only; keep the default button on "Don't allow". |
| 4 | low | `control-banner.ts` | If the same device both controls and views this machine, the banner shows only the control message and is click-through, so the viewing cue and the Stop button disappear exactly then. | Show a combined message; keep Stop usable when not remotely controlled. |
| 5 | low | `screen-send.js`, `screen-view.js`, `screen.ts` `screen-sig` | ICE candidates from the peer go straight into `addIceCandidate`, so a peer can make this machine probe an arbitrary non-LAN address; the incoming signal size is not capped (only outgoing). | Accept only private, link-local and loopback candidates; cap incoming signal size. |
| 6 | low | `screen.ts` | Sharing continues while the sharer's screen is locked or the machine sleeps. | Stop on lock-screen and suspend (Electron `powerMonitor`). |
| 7 | low | `browser-bridge.ts` + extension | The extension sends the token to whatever answers on `127.0.0.1:<port>`. A local process that grabs the port first would receive it. | Low practical risk (needs a hostile process on the same machine); document it, or answer a challenge before the token is sent. |
| 8 | low | `links.ts` | Pending sends are keyed by the id only, not by peer, so with several paired devices one could acknowledge another's links. | Key by peer id and link id. |
| 9 | info | `main.ts` `banner:stop` | The banner's Stop ends all screen streams, including ones where this machine is the viewer. | Stop only streams being shared from this machine. |

### Functional risk, not security

* WebRTC between **two real machines** is untested. Chromium hides host IPs behind `.local` names by default, which
  can fail on Windows or locked-down networks, and there is no STUN or relay to fall back on. Windows will also ask
  for a UDP firewall rule. Test cross-machine first; if it fails, disable the mDNS-obfuscation feature flag for the
  capture/view windows (acceptable on a trusted LAN).
* An 8 Mbit/s stream shares Wi-Fi with input events; check cursor lag while it runs (same measurement as TEST_CHECKLIST
  section 8).
* Add to the test checklist (after the other session finishes editing it): links, tab hotkey, send and open,
  extension setup, screen view consent, banner, and stopping.

## 11. Re-review of the section 10 findings

Diffed the working tree against `eec12f7`. TypeScript tests 49 of 49. Not run on two real machines.

| # | finding | result |
|---|---|---|
| 1 | queued screen requests | **fixed.** Started plus queued requests count against `MAX_SHARES`, and `startSharing` re-checks. A test sends 10 requests behind one prompt and at most 3 start. |
| 2 | received files not marked | **fixed.** `markFromNetwork` runs in `files.ts` on every completed received file (folder contents too), on the success path only, before `received` is emitted. |
| 3 | focus stealing | **fixed.** Consent prompts bounce the Dock or flash the taskbar without focusing the window; "Don't allow" gets focus when a modal opens. |
| 4 | banner hid the viewing cue | **fixed** for one device (a "both" mode with Stop and mouse events). |
| 5 | ICE candidates and signal size | **mostly fixed** (see below); incoming `screen-sig` is capped at 64 KB. |
| 6 | lock and sleep | **fixed.** Sharing stops on lock-screen and suspend. |
| 7 | extension token and port | **accepted as documented.** The token only works against DevLink's own bridge. |
| 8 | link acknowledgements | **fixed.** Keyed by peer id and link id. |
| 9 | banner Stop scope | **fixed.** `stopSharing()` ends only streams where this machine is shared. |
| - | mDNS names on the LAN | **handled.** `WebRtcHideLocalIpsWithMdns` is disabled app-wide so candidates carry real LAN addresses (the app only loads local pages). Still needs a real two-machine test. |

### Small things left (all low)

* **Candidate filter matches text, not a real address.** `lanCandidate` tests prefixes such as `^10\.` and
  `^192\.168\.`, so a hostname like `10.attacker.example` would pass. Check the address is a real IPv4 (four numbers)
  or a real IPv6 literal before looking at the range.
* **Banner attribution with several devices.** In "both" mode the name shown is the controller's even if a
  different device is the viewer. Harmless with two machines.
* **Not tested on hardware:** WebRTC across two machines (including the Windows UDP firewall prompt), cursor lag while
  a stream runs, the Windows `Zone.Identifier` marking, and macOS quarantine behaviour for opened files.
