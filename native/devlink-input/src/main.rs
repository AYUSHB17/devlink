//! DevLink input helper.
//!
//! Spawned by the DevLink app. Talks JSON lines: commands on stdin, events on stdout (see src/main/input.ts).
//! It detects when the cursor pushes against a configured screen edge, captures local input while
//! DevLink is "leading" another machine, and injects input it receives while "following".
//! It has no networking of its own; exiting (or stdin closing) always releases everything.

mod keymap;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use windows as platform;

use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// Marks events we inject so our own hooks/taps can tell them apart from physical input.
/// Random per process, so other software can't forge "our" events by copying a known constant.
static MAGIC: AtomicI64 = AtomicI64::new(0);
pub fn magic() -> i64 {
    MAGIC.load(Ordering::Relaxed)
}
fn init_magic() {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u32(std::process::id());
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    MAGIC.store(((h.finish() >> 2) | 1) as i64, Ordering::Relaxed);
}

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Left,
    Right,
    Top,
    Bottom,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Cmd {
    Config { edges: Vec<Side>, follower: bool },
    Capture { on: bool },
    Enter { side: Side, pos: f64 },
    Move { dx: i32, dy: i32 },
    Button { b: u8, down: bool },
    Wheel { dx: i32, dy: i32 },
    Key { hid: u16, down: bool },
    ReleaseAll,
    /// heartbeat from the app; without it the watchdog releases everything
    Ping,
    Quit,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
    fn dist2(&self, x: f64, y: f64) -> f64 {
        let cx = x.clamp(self.x, self.x + self.w - 1.0);
        let cy = y.clamp(self.y, self.y + self.h - 1.0);
        (cx - x).powi(2) + (cy - y).powi(2)
    }
}

/// State shared between the command thread and the platform event thread.
pub struct Shared {
    pub edges: Vec<Side>,
    pub follower: bool,
    pub capturing: bool,
    /// physical/observed mouse buttons currently down (bit 0 = left, 1 = right, 2 = middle, 3/4 = back/fwd)
    pub buttons: u8,
    pub last_edge: Option<Instant>,
    pub drag_origin: Option<(f64, f64)>,
    pub dragging: bool,
    pub last_activity: Option<Instant>,
    pub activity_accum: f64,
    /// keys physically held (HID), tracked while not capturing
    pub held: Vec<u16>,
    /// keys that were already down when capture started: their release must reach the local OS
    pub pre_held: Vec<u16>,
}

pub static SHARED: Mutex<Shared> = Mutex::new(Shared {
    edges: Vec::new(),
    follower: false,
    capturing: false,
    buttons: 0,
    last_edge: None,
    drag_origin: None,
    dragging: false,
    last_activity: None,
    activity_accum: 0.0,
    held: Vec::new(),
    pre_held: Vec::new(),
});

static PENDING_MOVE: Mutex<(i64, i64)> = Mutex::new((0, 0));

static OUT: OnceLock<Mutex<SyncSender<String>>> = OnceLock::new();
static LAST_CMD: Mutex<Option<Instant>> = Mutex::new(None);
/// No command (the app pings every second) for this long while capturing or injecting: let go.
const WATCHDOG_MS: u128 = 3000;

/// Called from hook/tap callbacks when the escape hotkey is pressed: release locally, right away,
/// without waiting for the app (which may be hung or disconnected).
pub fn hotkey_release() {
    SHARED.lock().unwrap().capturing = false;
    emit(serde_json::json!({ "ev": "hotkey" }));
}

/// Never blocks the hook/tap thread: if the app stops reading, events are dropped (moves are coalesced anyway).
pub fn emit(v: serde_json::Value) {
    if let Some(tx) = OUT.get() {
        let _ = tx.lock().unwrap().try_send(v.to_string());
    }
}

/// Captured pointer motion: summed here and emitted by a ~250 Hz flusher, not per hook event.
pub fn captured_move(dx: i64, dy: i64) {
    let mut p = PENDING_MOVE.lock().unwrap();
    p.0 += dx;
    p.1 += dy;
}

/// Emit pending motion now; call before any button/key/wheel event so ordering is preserved.
pub fn flush_moves() {
    let (dx, dy) = std::mem::take(&mut *PENDING_MOVE.lock().unwrap());
    if dx != 0 || dy != 0 {
        emit(serde_json::json!({ "ev": "move", "dx": dx, "dy": dy }));
    }
}

/// Physical key seen while not capturing.
pub fn note_physical_key(hid: u16, down: bool) {
    let mut st = SHARED.lock().unwrap();
    if down {
        if !st.held.contains(&hid) && st.held.len() < 64 {
            st.held.push(hid);
        }
    } else {
        st.held.retain(|&k| k != hid);
    }
}

/// While capturing: is this the release of a key that was held before capture began? Then it must go to
/// the local OS (it saw the press), not to the peer, or the key would stay stuck down here.
pub fn passthrough_release(hid: u16, down: bool) -> bool {
    if down {
        return false;
    }
    let mut st = SHARED.lock().unwrap();
    if st.pre_held.contains(&hid) {
        st.pre_held.retain(|&k| k != hid);
        st.held.retain(|&k| k != hid);
        return true;
    }
    false
}

pub fn log(msg: &str) {
    emit(serde_json::json!({ "ev": "log", "msg": msg }));
}

// ---------------------------------------------------------------- geometry shared by both platforms

fn screen_for(screens: &[Rect], x: f64, y: f64) -> Option<Rect> {
    screens
        .iter()
        .find(|s| s.contains(x, y))
        .or_else(|| screens.iter().min_by(|a, b| a.dist2(x, y).total_cmp(&b.dist2(x, y))))
        .copied()
}

fn any_contains(screens: &[Rect], x: f64, y: f64) -> bool {
    screens.iter().any(|s| s.contains(x, y))
}

/// Physical cursor at (x, y) moving by (dx, dy): is it pushing against an outer edge of the desktop?
pub fn edge_push(screens: &[Rect], x: f64, y: f64, dx: f64, dy: f64) -> Option<(Side, f64)> {
    let s = screen_for(screens, x, y)?;
    let cx = x.clamp(s.x, s.x + s.w - 1.0);
    let cy = y.clamp(s.y, s.y + s.h - 1.0);
    let along_y = ((cy - s.y) / s.h).clamp(0.0, 1.0);
    let along_x = ((cx - s.x) / s.w).clamp(0.0, 1.0);
    if dx > 0.0 && x >= s.x + s.w - 1.0 && !any_contains(screens, cx + 2.0, cy) {
        return Some((Side::Right, along_y));
    }
    if dx < 0.0 && x <= s.x && !any_contains(screens, cx - 2.0, cy) {
        return Some((Side::Left, along_y));
    }
    if dy < 0.0 && y <= s.y && !any_contains(screens, cx, cy - 2.0) {
        return Some((Side::Top, along_x));
    }
    if dy > 0.0 && y >= s.y + s.h - 1.0 && !any_contains(screens, cx, cy + 2.0) {
        return Some((Side::Bottom, along_x));
    }
    None
}

/// Injected move from `from` by (dx, dy): where the cursor ends up, and which outer edge it ran into (if any).
pub fn clamp_move(screens: &[Rect], from: (f64, f64), dx: f64, dy: f64) -> ((f64, f64), Option<(Side, f64)>) {
    let (tx, ty) = (from.0 + dx, from.1 + dy);
    if any_contains(screens, tx, ty) {
        return ((tx, ty), None);
    }
    let Some(s) = screen_for(screens, from.0, from.1) else { return (from, None) };
    let cx = tx.clamp(s.x, s.x + s.w - 1.0);
    let cy = ty.clamp(s.y, s.y + s.h - 1.0);
    // moved onto a neighbouring screen diagonally around a corner: let the clamped point stand
    let hit = edge_push(screens, cx, cy, dx, dy);
    ((cx, cy), hit)
}

/// Where the cursor appears when entering through `side` at fraction `pos` along that edge.
pub fn entry_point(screens: &[Rect], side: Side, pos: f64) -> Option<(f64, f64)> {
    let pos = pos.clamp(0.0, 1.0);
    let pick = |key: fn(&Rect) -> f64, max: bool| {
        screens
            .iter()
            .copied()
            .max_by(|a, b| if max { key(a).total_cmp(&key(b)) } else { key(b).total_cmp(&key(a)) })
    };
    let inset = 3.0;
    Some(match side {
        Side::Right => {
            let s = pick(|r| r.x + r.w, true)?;
            (s.x + s.w - inset, s.y + pos * (s.h - 1.0))
        }
        Side::Left => {
            let s = pick(|r| r.x, false)?;
            (s.x + inset - 1.0, s.y + pos * (s.h - 1.0))
        }
        Side::Top => {
            let s = pick(|r| r.y, false)?;
            (s.x + pos * (s.w - 1.0), s.y + inset - 1.0)
        }
        Side::Bottom => {
            let s = pick(|r| r.y + r.h, true)?;
            (s.x + pos * (s.w - 1.0), s.y + s.h - inset)
        }
    })
}

/// Called by platforms for every physical (not self-injected) pointer move while not capturing.
pub fn on_local_pointer(screens: &[Rect], x: f64, y: f64, dx: f64, dy: f64, injected_by_us: bool) {
    let mut st = SHARED.lock().unwrap();
    // drag detection (any source, so it also works while we are being remote controlled)
    if st.buttons & 1 != 0 {
        if let Some((ox, oy)) = st.drag_origin {
            if !st.dragging && ((x - ox).powi(2) + (y - oy).powi(2)) > 64.0 {
                st.dragging = true;
                emit(serde_json::json!({ "ev": "drag", "active": true }));
            }
        }
    }
    if injected_by_us {
        return;
    }
    if st.follower {
        st.activity_accum += dx.abs() + dy.abs();
        if st.activity_accum > 12.0 {
            st.activity_accum = 0.0;
            report_activity(&mut st);
        }
        return;
    }
    if let Some((side, pos)) = edge_push(screens, x, y, dx, dy) {
        if !st.edges.contains(&side) {
            return;
        }
        let now = Instant::now();
        if st.last_edge.map_or(true, |t| now.duration_since(t).as_millis() > 300) {
            st.last_edge = Some(now);
            emit(serde_json::json!({ "ev": "edge", "side": side, "pos": pos, "buttons": st.buttons }));
        }
    }
}

/// Mouse button seen by a hook/tap (physical or injected) while not capturing.
pub fn on_local_button(b: u8, down: bool, x: f64, y: f64, injected_by_us: bool) {
    let mut st = SHARED.lock().unwrap();
    if down {
        st.buttons |= 1 << b;
        if b == 0 {
            st.drag_origin = Some((x, y));
        }
    } else {
        st.buttons &= !(1 << b);
        if b == 0 {
            st.drag_origin = None;
            if st.dragging {
                st.dragging = false;
                emit(serde_json::json!({ "ev": "drag", "active": false }));
            }
        }
    }
    if !injected_by_us && st.follower {
        report_activity(&mut st);
    }
}

/// Physical keyboard use while following.
pub fn on_local_key(injected_by_us: bool) {
    let mut st = SHARED.lock().unwrap();
    if !injected_by_us && st.follower {
        report_activity(&mut st);
    }
}

fn report_activity(st: &mut Shared) {
    let now = Instant::now();
    if st.last_activity.map_or(true, |t| now.duration_since(t).as_millis() > 300) {
        st.last_activity = Some(now);
        emit(serde_json::json!({ "ev": "local_activity" }));
    }
}

/// Edge hit by an injected move (follower side).
pub fn on_injected_edge(side: Side, pos: f64) {
    let mut st = SHARED.lock().unwrap();
    if !st.edges.contains(&side) {
        return;
    }
    let now = Instant::now();
    if st.last_edge.map_or(true, |t| now.duration_since(t).as_millis() > 150) {
        st.last_edge = Some(now);
        emit(serde_json::json!({ "ev": "edge", "side": side, "pos": pos, "buttons": 0 }));
    }
}

fn main() {
    init_magic();
    let (tx, rx) = sync_channel::<String>(4096);
    OUT.set(Mutex::new(tx)).ok();
    // writer thread: never block the hook/tap thread on stdout
    let writer = std::thread::spawn(move || {
        let stdout = std::io::stdout();
        for line in rx {
            let mut out = stdout.lock();
            if writeln!(out, "{line}").and_then(|_| out.flush()).is_err() {
                break;
            }
        }
    });

    if std::env::args().any(|a| a == "--probe") {
        platform::emit_ready();
        // let the writer drain, then exit
        OUT.get().map(|m| drop(m.lock().unwrap().clone()));
        std::thread::sleep(std::time::Duration::from_millis(50));
        drop(writer);
        return;
    }

    platform::emit_ready();
    *LAST_CMD.lock().unwrap() = Some(Instant::now());
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_millis(4));
        flush_moves();
    });
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let stale = LAST_CMD.lock().unwrap().map_or(false, |t| t.elapsed().as_millis() > WATCHDOG_MS);
        if !stale {
            continue;
        }
        let was_capturing = std::mem::replace(&mut SHARED.lock().unwrap().capturing, false);
        if was_capturing {
            platform::set_capture(false);
            emit(serde_json::json!({ "ev": "error", "msg": "DevLink stopped responding; mouse and keyboard released" }));
        }
        platform::inject(Cmd::ReleaseAll);
        *LAST_CMD.lock().unwrap() = None; // fire once until the app talks again
    });
    std::thread::spawn(|| {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            *LAST_CMD.lock().unwrap() = Some(Instant::now());
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Cmd>(&line) {
                Ok(Cmd::Quit) => break,
                Ok(cmd) => handle(cmd),
                Err(e) => emit(serde_json::json!({ "ev": "error", "msg": format!("bad command: {e}") })),
            }
        }
        // parent gone or asked us to quit: give back the mouse and keyboard
        platform::shutdown();
        std::process::exit(0);
    });
    platform::run();
}

fn handle(cmd: Cmd) {
    match cmd {
        Cmd::Config { edges, follower } => {
            let mut st = SHARED.lock().unwrap();
            st.edges = edges;
            st.follower = follower;
            st.activity_accum = 0.0;
        }
        Cmd::Capture { on } => {
            {
                let mut st = SHARED.lock().unwrap();
                st.capturing = on;
                st.pre_held = if on { st.held.clone() } else { Vec::new() };
            }
            if !on {
                *PENDING_MOVE.lock().unwrap() = (0, 0);
            }
            platform::set_capture(on);
        }
        Cmd::Ping => {}
        // the app already validates, but never trust input blindly: clamp again here
        Cmd::Move { dx, dy } => platform::inject(Cmd::Move { dx: dx.clamp(-4000, 4000), dy: dy.clamp(-4000, 4000) }),
        Cmd::Wheel { dx, dy } => platform::inject(Cmd::Wheel { dx: dx.clamp(-10000, 10000), dy: dy.clamp(-10000, 10000) }),
        Cmd::Key { hid, down } if (0x04..=0xe7).contains(&hid) => platform::inject(Cmd::Key { hid, down }),
        Cmd::Key { .. } => {}
        Cmd::Button { b, down } if b <= 4 => platform::inject(Cmd::Button { b, down }),
        Cmd::Button { .. } => {}
        other => platform::inject(other),
    }
}
