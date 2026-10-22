//! macOS backend: CGEventTap for edge detection + capture, CGEventPost for injection.
//! Needs Accessibility (active event tap, posting events) and Input Monitoring permission.

use crate::keymap::{hid_from_mac, mac_from_hid};
use crate::*;
use std::ffi::c_void;
use std::ptr::null_mut;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::time::{Duration, Instant};

type CGEventRef = *mut c_void;
type CFMachPortRef = *mut c_void;
type CGEventSourceRef = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

type TapCallback = extern "C" fn(*mut c_void, u32, CGEventRef, *mut c_void) -> CGEventRef;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(tap: u32, place: u32, options: u32, mask: u64, cb: TapCallback, info: *mut c_void) -> CFMachPortRef;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventGetLocation(e: CGEventRef) -> CGPoint;
    fn CGEventGetIntegerValueField(e: CGEventRef, field: u32) -> i64;
    fn CGEventSetIntegerValueField(e: CGEventRef, field: u32, value: i64);
    fn CGEventGetFlags(e: CGEventRef) -> u64;
    fn CGEventSetFlags(e: CGEventRef, flags: u64);
    fn CGEventSetType(e: CGEventRef, t: u32);
    fn CGEventCreate(src: CGEventSourceRef) -> CGEventRef;
    fn CGEventCreateMouseEvent(src: CGEventSourceRef, t: u32, p: CGPoint, button: u32) -> CGEventRef;
    fn CGEventCreateKeyboardEvent(src: CGEventSourceRef, key: u16, down: bool) -> CGEventRef;
    fn CGEventCreateScrollWheelEvent2(src: CGEventSourceRef, units: u32, count: u32, w1: i32, w2: i32, w3: i32) -> CGEventRef;
    fn CGEventPost(tap: u32, e: CGEventRef);
    fn CGEventSourceCreate(state: i32) -> CGEventSourceRef;
    fn CGEventSourceSetLocalEventsSuppressionInterval(src: CGEventSourceRef, seconds: f64);
    fn CGAssociateMouseAndMouseCursorPosition(connected: u32) -> i32;
    fn CGWarpMouseCursorPosition(p: CGPoint) -> i32;
    fn CGGetActiveDisplayList(max: u32, ids: *mut u32, count: *mut u32) -> i32;
    fn CGDisplayBounds(id: u32) -> CGRect;
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
}
#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn IsSecureEventInputEnabled() -> bool;
}
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFMachPortCreateRunLoopSource(alloc: *const c_void, port: CFMachPortRef, order: isize) -> *mut c_void;
    fn CFRunLoopGetCurrent() -> *mut c_void;
    fn CFRunLoopAddSource(rl: *mut c_void, src: *mut c_void, mode: *const c_void);
    fn CFRunLoopRun();
    fn CFRelease(p: *const c_void);
    static kCFRunLoopCommonModes: *const c_void;
}

// event types
const LEFT_DOWN: u32 = 1;
const LEFT_UP: u32 = 2;
const RIGHT_DOWN: u32 = 3;
const RIGHT_UP: u32 = 4;
const MOVED: u32 = 5;
const LEFT_DRAGGED: u32 = 6;
const RIGHT_DRAGGED: u32 = 7;
const KEY_DOWN: u32 = 10;
const KEY_UP: u32 = 11;
const FLAGS_CHANGED: u32 = 12;
const SCROLL: u32 = 22;
const OTHER_DOWN: u32 = 25;
const OTHER_UP: u32 = 26;
const OTHER_DRAGGED: u32 = 27;
const TAP_DISABLED_TIMEOUT: u32 = 0xffff_fffe;
const TAP_DISABLED_USER: u32 = 0xffff_ffff;

// event fields
const F_CLICK_STATE: u32 = 1;
const F_BUTTON_NUMBER: u32 = 3;
const F_DELTA_X: u32 = 4;
const F_DELTA_Y: u32 = 5;
const F_KEYCODE: u32 = 9;
const F_USER_DATA: u32 = 42;
const F_SCROLL_POINT_Y: u32 = 96;
const F_SCROLL_POINT_X: u32 = 97;

// modifier flags
const FL_SHIFT: u64 = 0x20000;
const FL_CTRL: u64 = 0x40000;
const FL_ALT: u64 = 0x80000;
const FL_CMD: u64 = 0x100000;

/// (hid, generic flag, device-specific flag)
const MODS: &[(u16, u64, u64)] = &[
    (0xe0, FL_CTRL, 0x1),
    (0xe1, FL_SHIFT, 0x2),
    (0xe2, FL_ALT, 0x20),
    (0xe3, FL_CMD, 0x8),
    (0xe4, FL_CTRL, 0x2000),
    (0xe5, FL_SHIFT, 0x4),
    (0xe6, FL_ALT, 0x40),
    (0xe7, FL_CMD, 0x10),
];

static TAP: AtomicPtr<c_void> = AtomicPtr::new(null_mut());
static SOURCE: AtomicPtr<c_void> = AtomicPtr::new(null_mut());

struct Injected {
    buttons: u8,
    keys: Vec<u16>,
    device_flags: u64,
    last_click: Option<(Instant, u8, f64, f64, i64)>,
}
static INJ: Mutex<Injected> = Mutex::new(Injected { buttons: 0, keys: Vec::new(), device_flags: 0, last_click: None });
static SCREENS: Mutex<Option<(Vec<Rect>, Instant)>> = Mutex::new(None);

fn screens() -> Vec<Rect> {
    let mut cache = SCREENS.lock().unwrap();
    if let Some((s, at)) = cache.as_ref() {
        if at.elapsed() < Duration::from_secs(2) {
            return s.clone();
        }
    }
    let mut ids = [0u32; 16];
    let mut n = 0u32;
    let mut out = Vec::new();
    unsafe {
        if CGGetActiveDisplayList(16, ids.as_mut_ptr(), &mut n) == 0 {
            for &id in &ids[..n as usize] {
                let b = CGDisplayBounds(id);
                out.push(Rect { x: b.origin.x, y: b.origin.y, w: b.size.width, h: b.size.height });
            }
        }
    }
    *cache = Some((out.clone(), Instant::now()));
    out
}

fn source() -> CGEventSourceRef {
    let s = SOURCE.load(Ordering::Acquire);
    if !s.is_null() {
        return s;
    }
    unsafe {
        let s = CGEventSourceCreate(1); // HID system state
        CGEventSourceSetLocalEventsSuppressionInterval(s, 0.0);
        SOURCE.store(s, Ordering::Release);
        s
    }
}

fn generic_flags(device: u64) -> u64 {
    MODS.iter().filter(|m| device & m.2 != 0).fold(device, |acc, m| acc | m.1)
}

fn cursor() -> CGPoint {
    unsafe {
        let e = CGEventCreate(null_mut());
        let p = CGEventGetLocation(e);
        CFRelease(e);
        p
    }
}

fn post(e: CGEventRef) {
    if e.is_null() {
        return;
    }
    unsafe {
        CGEventSetIntegerValueField(e, F_USER_DATA, magic());
        CGEventPost(0, e);
        CFRelease(e);
    }
}

pub fn emit_ready() {
    let s = screens();
    let (ax, im) = unsafe { (AXIsProcessTrusted(), CGPreflightListenEventAccess()) };
    emit(serde_json::json!({ "ev": "ready", "platform": "macos", "screens": s, "accessibility": ax, "inputMonitoring": im }));
}

fn button_of(etype: u32, e: CGEventRef) -> (u8, bool) {
    match etype {
        LEFT_DOWN => (0, true),
        LEFT_UP => (0, false),
        RIGHT_DOWN => (1, true),
        RIGHT_UP => (1, false),
        _ => {
            let n = unsafe { CGEventGetIntegerValueField(e, F_BUTTON_NUMBER) }.clamp(2, 4) as u8;
            (n, etype == OTHER_DOWN)
        }
    }
}

extern "C" fn tap_cb(_proxy: *mut c_void, etype: u32, e: CGEventRef, _info: *mut c_void) -> CGEventRef {
    if etype == TAP_DISABLED_TIMEOUT || etype == TAP_DISABLED_USER {
        let t = TAP.load(Ordering::Acquire);
        if !t.is_null() {
            unsafe { CGEventTapEnable(t, true) };
        }
        return e;
    }
    let ours = unsafe { CGEventGetIntegerValueField(e, F_USER_DATA) } == magic();
    let capturing = SHARED.lock().unwrap().capturing;
    if capturing && !ours {
        // swallow: this input belongs to the other machine now (except releases of keys held before)
        return if captured(etype, e) { e } else { null_mut() };
    }
    unsafe {
        match etype {
            MOVED | LEFT_DRAGGED | RIGHT_DRAGGED | OTHER_DRAGGED => {
                let p = CGEventGetLocation(e);
                let dx = CGEventGetIntegerValueField(e, F_DELTA_X) as f64;
                let dy = CGEventGetIntegerValueField(e, F_DELTA_Y) as f64;
                on_local_pointer(&screens(), p.x, p.y, dx, dy, ours);
            }
            LEFT_DOWN | LEFT_UP | RIGHT_DOWN | RIGHT_UP | OTHER_DOWN | OTHER_UP => {
                let p = CGEventGetLocation(e);
                let (b, down) = button_of(etype, e);
                on_local_button(b, down, p.x, p.y, ours);
            }
            KEY_DOWN | KEY_UP | FLAGS_CHANGED => {
                if !ours {
                    if let Some((hid, down)) = key_of(etype, e) {
                        note_physical_key(hid, down);
                    }
                }
                on_local_key(ours);
            }
            SCROLL => on_local_key(ours),
            _ => {}
        }
    }
    e
}

/// (HID usage, down) for key and modifier events; caps lock is handled separately (it reports a toggle).
fn key_of(etype: u32, e: CGEventRef) -> Option<(u16, bool)> {
    unsafe {
        let code = CGEventGetIntegerValueField(e, F_KEYCODE) as u16;
        let hid = hid_from_mac(code)?;
        match etype {
            KEY_DOWN => Some((hid, true)),
            KEY_UP => Some((hid, false)),
            FLAGS_CHANGED if hid != 0x39 => {
                let m = MODS.iter().find(|m| m.0 == hid)?;
                Some((hid, CGEventGetFlags(e) & m.2 != 0))
            }
            _ => None,
        }
    }
}

/// Handles an input event while capturing. Returns true if it must still reach the local OS.
fn captured(etype: u32, e: CGEventRef) -> bool {
    unsafe {
        match etype {
            MOVED | LEFT_DRAGGED | RIGHT_DRAGGED | OTHER_DRAGGED => {
                captured_move(CGEventGetIntegerValueField(e, F_DELTA_X), CGEventGetIntegerValueField(e, F_DELTA_Y));
            }
            LEFT_DOWN | LEFT_UP | RIGHT_DOWN | RIGHT_UP | OTHER_DOWN | OTHER_UP => {
                let (b, down) = button_of(etype, e);
                flush_moves();
                emit(serde_json::json!({ "ev": "button", "b": b, "down": down }));
            }
            SCROLL => {
                let dy = CGEventGetIntegerValueField(e, F_SCROLL_POINT_Y);
                let dx = CGEventGetIntegerValueField(e, F_SCROLL_POINT_X);
                if dx != 0 || dy != 0 {
                    flush_moves();
                    emit(serde_json::json!({ "ev": "wheel", "dx": dx, "dy": dy }));
                }
            }
            KEY_DOWN | KEY_UP | FLAGS_CHANGED => {
                let code = CGEventGetIntegerValueField(e, F_KEYCODE) as u16;
                let flags = CGEventGetFlags(e);
                if etype == KEY_DOWN && code == 0x35 && flags & (FL_CTRL | FL_ALT | FL_SHIFT) == (FL_CTRL | FL_ALT | FL_SHIFT) {
                    hotkey_release();
                    set_capture(false);
                    return false;
                }
                flush_moves();
                if etype == FLAGS_CHANGED && hid_from_mac(code) == Some(0x39) {
                    emit(serde_json::json!({ "ev": "key", "hid": 0x39, "down": true }));
                    emit(serde_json::json!({ "ev": "key", "hid": 0x39, "down": false }));
                } else if let Some((hid, down)) = key_of(etype, e) {
                    if passthrough_release(hid, down) {
                        return true;
                    }
                    emit(serde_json::json!({ "ev": "key", "hid": hid, "down": down }));
                }
            }
            _ => {}
        }
    }
    false
}

pub fn set_capture(on: bool) {
    unsafe {
        CGAssociateMouseAndMouseCursorPosition(if on { 0 } else { 1 });
        if on && IsSecureEventInputEnabled() {
            emit(serde_json::json!({
                "ev": "notice",
                "msg": "Secure input is on (a password field or Terminal's Secure Keyboard Entry), so macOS won't let DevLink forward typing until it's off"
            }));
        }
    }
}

fn move_type(buttons: u8) -> (u32, u32) {
    if buttons & 1 != 0 {
        (LEFT_DRAGGED, 0)
    } else if buttons & 2 != 0 {
        (RIGHT_DRAGGED, 1)
    } else if buttons != 0 {
        (OTHER_DRAGGED, 2)
    } else {
        (MOVED, 0)
    }
}

fn post_move_to(p: CGPoint, dx: i64, dy: i64) {
    let inj = INJ.lock().unwrap();
    let (t, b) = move_type(inj.buttons);
    let flags = generic_flags(inj.device_flags);
    drop(inj);
    unsafe {
        let e = CGEventCreateMouseEvent(source(), t, p, b);
        if e.is_null() {
            return;
        }
        CGEventSetIntegerValueField(e, F_DELTA_X, dx);
        CGEventSetIntegerValueField(e, F_DELTA_Y, dy);
        CGEventSetFlags(e, flags);
        post(e);
    }
}

fn post_button(b: u8, down: bool) {
    let p = cursor();
    let mut inj = INJ.lock().unwrap();
    if down {
        inj.buttons |= 1 << b;
    } else {
        inj.buttons &= !(1 << b);
    }
    // double/triple click detection, like the window server does for physical clicks
    let count = if down {
        let n = match inj.last_click {
            Some((t, lb, x, y, n)) if lb == b && t.elapsed() < Duration::from_millis(450) && (x - p.x).abs() < 5.0 && (y - p.y).abs() < 5.0 => n + 1,
            _ => 1,
        };
        inj.last_click = Some((Instant::now(), b, p.x, p.y, n));
        n
    } else {
        inj.last_click.map(|c| c.4).unwrap_or(1)
    };
    let flags = generic_flags(inj.device_flags);
    drop(inj);
    let (t, cg_button) = match (b, down) {
        (0, true) => (LEFT_DOWN, 0),
        (0, false) => (LEFT_UP, 0),
        (1, true) => (RIGHT_DOWN, 1),
        (1, false) => (RIGHT_UP, 1),
        (n, true) => (OTHER_DOWN, n as u32),
        (n, false) => (OTHER_UP, n as u32),
    };
    unsafe {
        let e = CGEventCreateMouseEvent(source(), t, p, cg_button);
        if e.is_null() {
            return;
        }
        CGEventSetIntegerValueField(e, F_CLICK_STATE, count);
        CGEventSetFlags(e, flags);
        post(e);
    }
}

fn post_key(hid: u16, down: bool) {
    let Some(code) = mac_from_hid(hid) else { return };
    let mut inj = INJ.lock().unwrap();
    let modifier = MODS.iter().find(|m| m.0 == hid);
    if let Some(m) = modifier {
        if down {
            inj.device_flags |= m.2;
        } else {
            inj.device_flags &= !m.2;
        }
    }
    if down {
        if !inj.keys.contains(&hid) {
            inj.keys.push(hid);
        }
    } else {
        inj.keys.retain(|&k| k != hid);
    }
    let flags = generic_flags(inj.device_flags);
    drop(inj);
    unsafe {
        let e = CGEventCreateKeyboardEvent(source(), code, down);
        if e.is_null() {
            return;
        }
        if modifier.is_some() {
            CGEventSetType(e, FLAGS_CHANGED);
        }
        CGEventSetFlags(e, flags);
        post(e);
    }
}

fn release_all() {
    let (buttons, keys) = {
        let inj = INJ.lock().unwrap();
        (inj.buttons, inj.keys.clone())
    };
    for k in keys {
        post_key(k, false);
    }
    for b in 0..5u8 {
        if buttons & (1 << b) != 0 {
            post_button(b, false);
        }
    }
    INJ.lock().unwrap().device_flags = 0;
}

pub fn inject(cmd: Cmd) {
    match cmd {
        Cmd::Move { dx, dy } => {
            let cur = cursor();
            let s = screens();
            let ((x, y), hit) = clamp_move(&s, (cur.x, cur.y), dx as f64, dy as f64);
            post_move_to(CGPoint { x, y }, dx as i64, dy as i64);
            if let Some((side, pos)) = hit {
                on_injected_edge(side, pos);
            }
        }
        Cmd::Button { b, down } => post_button(b.min(4), down),
        Cmd::Wheel { dx, dy } => unsafe {
            let e = CGEventCreateScrollWheelEvent2(source(), 0, 2, dy, dx, 0);
            post(e);
        },
        Cmd::Key { hid, down } => post_key(hid, down),
        Cmd::Enter { side, pos } => {
            SCREENS.lock().unwrap().take(); // displays may have changed since we last looked
            if let Some((x, y)) = entry_point(&screens(), side, pos) {
                let p = CGPoint { x, y };
                unsafe { CGWarpMouseCursorPosition(p) };
                post_move_to(p, 0, 0);
            }
        }
        Cmd::ReleaseAll => release_all(),
        Cmd::Config { .. } | Cmd::Capture { .. } | Cmd::Ping | Cmd::Quit => {}
    }
}

pub fn shutdown() {
    set_capture(false);
    release_all();
}

pub fn run() {
    let mask: u64 = [LEFT_DOWN, LEFT_UP, RIGHT_DOWN, RIGHT_UP, MOVED, LEFT_DRAGGED, RIGHT_DRAGGED, KEY_DOWN, KEY_UP, FLAGS_CHANGED, SCROLL, OTHER_DOWN, OTHER_UP, OTHER_DRAGGED]
        .iter()
        .fold(0, |m, t| m | (1u64 << t));
    let mut warned = false;
    loop {
        // session tap, head insert, active filter (so captured input can be swallowed)
        let tap = unsafe { CGEventTapCreate(1, 0, 0, mask, tap_cb, null_mut()) };
        if !tap.is_null() {
            TAP.store(tap, Ordering::Release);
            if warned {
                emit_ready();
            }
            unsafe {
                let src = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
                CFRunLoopAddSource(CFRunLoopGetCurrent(), src, kCFRunLoopCommonModes);
                CGEventTapEnable(tap, true);
                CFRunLoopRun();
            }
            return;
        }
        if !warned {
            warned = true;
            unsafe { CGRequestListenEventAccess() };
            emit(serde_json::json!({
                "ev": "error",
                "msg": "macOS is blocking input access. Allow DevLink (or Terminal, when started with npm start) under System Settings → Privacy & Security → Accessibility and Input Monitoring."
            }));
        }
        std::thread::sleep(Duration::from_secs(3));
    }
}
