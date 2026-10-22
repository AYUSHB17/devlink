# Shared mouse & keyboard (design)

Goal: the Mac and the Windows PC behave like two monitors of one desktop. The cursor leaves one screen at the edge
facing the other machine and appears on the other machine; the keyboard follows the cursor. Files dragged to that edge
are sent to the other machine. Either machine can lead: whichever machine's physical mouse/keyboard you touch drives.

## Pieces

```
 Electron main (TypeScript)                        native helper (Rust, one per machine)
 ┌───────────────────────────────┐  JSON lines   ┌──────────────────────────────────────┐
 │ input.ts  InputShare          │◀─ stdout ───── │ macOS: CGEventTap + CGEventPost       │
 │  - layout (which side is who) │── stdin ─────▶ │ Windows: WH_MOUSE_LL/WH_KEYBOARD_LL   │
 │  - crossing state machine     │               │          + SendInput                   │
 │  - key/scroll mapping         │               │ edge detection, capture, injection     │
 └──────────────┬────────────────┘               └──────────────────────────────────────┘
                │ existing encrypted, paired session (AES-256-GCM)
                ▼
            other machine
```

* The helper knows nothing about networking or peers. It reports edge hits and (while capturing) raw input; it
  injects what it is told to. All policy lives in `input.ts`, which is unit-tested with a fake helper.
* Input only ever travels inside an authenticated DevLink session. A machine accepts remote input only if
  **Settings → Allow paired devices to control this machine** is on (off by default).

## States (per machine)

| state | meaning |
|---|---|
| `local` | cursor is here, nobody is remote-controlled |
| `leading(peer)` | our physical input is captured (swallowed locally) and forwarded to `peer` |
| `following(peer)` | `peer` is driving us; we inject what it sends |

Transitions:

1. `local` → helper reports `edge(side, pos)`, a paired online peer sits on `side`, it allows control, no mouse
   button is held → send `input-enter{pos}`, start capture → `leading`.
2. Peer receives `input-enter`: it must allow control (setting), be `local`, and have **consent for this
   connection**: the first attempt on each new connection shows "Allow <peer> to control this machine?" and is
   denied until the local user clicks Allow (answers are ignored while this machine is being controlled, so the
   click is physical). Consent lives in memory only and is asked again after a reconnect or restart. Then it warps
   its cursor to the edge facing us at the same relative position → `following`; otherwise `input-deny`.
3. While `leading`: captured events are forwarded as `input-ev` (mouse moves coalesced every ~8 ms; buttons, wheel
   and keys immediately, in order).
4. Follower's injected cursor hits the edge facing the leader → `input-leave{pos}` → follower `local`; leader stops
   capture, warps its own cursor just inside its edge at `pos` → `local`.
5. Follower's own physical mouse/keyboard is used (helper reports `local_activity`) → `input-takeback` → leader
   releases; follower becomes `local`. This is what makes "either can lead" work.
6. Safety: session drop, helper crash, no ack within 1.5 s, or no `input-hb` heartbeat (both sides send one every
   500 ms) for 2 s → leader releases capture; follower releases all held keys/buttons. `Ctrl+Alt/Option+Shift+Esc`
   is handled **inside the helper's hook**, which releases capture immediately without the app. The helper also has
   a watchdog: if the app stops pinging it for 3 s it releases capture and every injected key/button.
7. The follower validates everything it injects: HID keyboard range only, buttons 0–4, clamped deltas/scroll,
   at most 3000 events/s and 32 held keys.

File transfers use acknowledgement windowing (16 MB in flight per peer) instead of pausing the socket, so a slow
disk never stalls input events, clipboard or heartbeats on the same connection.

## Layout

Each machine stores, per peer, which side that peer is on (`left/right/top/bottom`). Setting it on one machine sends
`input-layout` so the other stores the mirror image. Positions along the shared edge are exchanged as 0..1 fractions
of the monitor at that edge, so different resolutions and DPI scales line up proportionally. Pointer speed can be
scaled per machine. Multiple monitors work as long as the outermost monitor on that side is the one facing the
other machine.

## Keys, buttons, scroll

* Keys are sent as **USB HID usage codes** (physical key position), mapped from/to macOS virtual key codes and
  Windows set-1 scan codes in the helper. Layout-dependent characters therefore come out according to the
  *receiving* machine's keyboard layout (same as a USB keyboard plugged into it).
* `Cmd ↔ Ctrl` swap (default on) is applied by the receiver when the two OSes differ, so `Cmd+C` on the Mac keyboard
  is `Ctrl+C` on Windows and vice versa.
* Scroll is exchanged in pixels (Windows wheel notch = 120 units ≈ 100 px). Invert option for natural scrolling.

## Clipboard follows the cursor

When the cursor crosses, the leader pushes its clipboard to the peer (setting "Send clipboard when crossing", on by
default), and when it comes back the follower pushes back. This works even with continuous clipboard sync off.

## Edge drop ("flick")

While a mouse button is held the cursor does not cross (otherwise drags would break). Instead, when the helper sees a
drag in progress near an edge that faces a peer, DevLink shows a slim always-on-top drop strip along that edge
("Drop to send to <peer>"). Files dropped there go through the existing `files.ts` transfer into the other machine's
`Downloads/DevLink/<device>/` folder, and the receiver gets a notification. The strip is only shown during drags, so
it never blocks normal clicks near the screen edge.

## Permissions & platform limits

* **macOS:** the app (Electron, or Terminal when run from `npm start`) needs **Accessibility** and **Input
  Monitoring** (System Settings → Privacy & Security). Secure input (password fields, some terminals with Secure
  Keyboard Entry) blocks capture of typing. The local cursor is frozen at the edge while leading, not hidden.
* **Windows:** injected input cannot reach elevated (admin) windows, UAC prompts or the lock screen unless DevLink
  runs elevated. Ctrl+Alt+Del can never be injected.

## Ideas worth exploring later (from looking at Deskflow, Mouse Without Borders, Universal Control, Deskin…)

* Cursor "throw": fast flick toward an edge crosses even if the user didn't quite reach it.
* Lazy file clipboard: copy files in Finder, paste in Explorer; bytes stream only when pasted.
* Drag across and drop *into* the target app (synthesised OLE / NSDraggingSession on the follower).
* Automatic layout detection by moving the cursor across both screens once.
* Show a ghost of the remote cursor on the local edge so you can see where you'll enter.
