//! Windows backend: WH_MOUSE_LL / WH_KEYBOARD_LL hooks for edge detection + capture, SendInput for injection.
//! Coordinates are physical pixels (per-monitor DPI aware). Injected input can't reach elevated windows
//! unless this process is elevated too.

use crate::keymap::{hid_from_win, win_from_hid, HID_NUMLOCK, HID_PAUSE};
use crate::*;
use std::mem::size_of;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU32, Ordering};
use std::sync::Once;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

static DPI: Once = Once::new();
static PARK: Mutex<(i32, i32)> = Mutex::new((0, 0));
static LAST_PT: Mutex<Option<(i32, i32)>> = Mutex::new(None);
static CTRL: AtomicBool = AtomicBool::new(false);
static ALT: AtomicBool = AtomicBool::new(false);
static SHIFT: AtomicBool = AtomicBool::new(false);
static SCREENS: Mutex<Option<(Vec<Rect>, Instant)>> = Mutex::new(None);
static MOUSE_HOOK: AtomicPtr<core::ffi::c_void> = AtomicPtr::new(null_mut());
static KBD_HOOK: AtomicPtr<core::ffi::c_void> = AtomicPtr::new(null_mut());
/// tick (ms) of the last event our hooks saw; compared with the system's last-input tick to detect removed hooks
static LAST_HOOK_TICK: AtomicU32 = AtomicU32::new(0);

struct Injected {
    buttons: u8,
    keys: Vec<u16>,
}
static INJ: Mutex<Injected> = Mutex::new(Injected { buttons: 0, keys: Vec::new() });
/// Sub-pixel position of the injected pointer (see `follower_step`), and how many moves were logged since entering.
static VIRT: Mutex<Option<Virt>> = Mutex::new(None);
static MOVES_LOGGED: AtomicU32 = AtomicU32::new(0);

fn dpi_aware() {
    DPI.call_once(|| unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    });
}

unsafe extern "system" fn monitor_cb(hmon: HMONITOR, _hdc: HDC, _rc: *mut RECT, data: LPARAM) -> windows_sys::core::BOOL {
    let out = &mut *(data as *mut Vec<Rect>);
    let mut mi: MONITORINFO = std::mem::zeroed();
    mi.cbSize = size_of::<MONITORINFO>() as u32;
    if GetMonitorInfoW(hmon, &mut mi) != 0 {
        let r = mi.rcMonitor;
        out.push(Rect { x: r.left as f64, y: r.top as f64, w: (r.right - r.left) as f64, h: (r.bottom - r.top) as f64 });
    }
    1
}

fn screens() -> Vec<Rect> {
    let mut cache = SCREENS.lock().unwrap();
    if let Some((s, at)) = cache.as_ref() {
        if at.elapsed() < Duration::from_secs(2) {
            return s.clone();
        }
    }
    let mut out: Vec<Rect> = Vec::new();
    unsafe {
        EnumDisplayMonitors(null_mut(), null(), Some(monitor_cb), &mut out as *mut Vec<Rect> as LPARAM);
    }
    *cache = Some((out.clone(), Instant::now()));
    out
}

fn cursor() -> (i32, i32) {
    let mut p = POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut p) };
    (p.x, p.y)
}

pub fn emit_ready() {
    dpi_aware();
    let s = screens();
    // Windows has no per-app permission for hooks/SendInput
    emit(serde_json::json!({ "ev": "ready", "platform": "windows", "screens": s, "accessibility": true, "inputMonitoring": true }));
}

fn button_of(msg: u32, data: u32) -> Option<(u8, bool)> {
    let x = ((data >> 16) & 0xffff) as u16;
    Some(match msg {
        WM_LBUTTONDOWN => (0, true),
        WM_LBUTTONUP => (0, false),
        WM_RBUTTONDOWN => (1, true),
        WM_RBUTTONUP => (1, false),
        WM_MBUTTONDOWN => (2, true),
        WM_MBUTTONUP => (2, false),
        WM_XBUTTONDOWN => (if x == 2 { 4 } else { 3 }, true),
        WM_XBUTTONUP => (if x == 2 { 4 } else { 3 }, false),
        _ => return None,
    })
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code < 0 {
        return CallNextHookEx(null_mut(), code, wparam, lparam);
    }
    let info = &*(lparam as *const MSLLHOOKSTRUCT);
    let ours = info.flags & LLMHF_INJECTED != 0 && tag_matches(info.dwExtraInfo as u64);
    let msg = wparam as u32;
    let (x, y) = (info.pt.x, info.pt.y);
    LAST_HOOK_TICK.store(info.time, Ordering::Relaxed);
    let capturing = SHARED.lock().unwrap().capturing;
    if capturing && !ours {
        match msg {
            WM_MOUSEMOVE => {
                let park = *PARK.lock().unwrap();
                captured_move((x - park.0) as i64, (y - park.1) as i64);
            }
            WM_MOUSEWHEEL | WM_MOUSEHWHEEL => {
                let d = ((info.mouseData >> 16) & 0xffff) as u16 as i16 as i32;
                let px = d * 100 / 120; // a notch (120) ~ 100 px
                flush_moves();
                if msg == WM_MOUSEWHEEL {
                    emit(serde_json::json!({ "ev": "wheel", "dx": 0, "dy": px }));
                } else {
                    emit(serde_json::json!({ "ev": "wheel", "dx": px, "dy": 0 }));
                }
            }
            _ => {
                if let Some((b, down)) = button_of(msg, info.mouseData) {
                    flush_moves();
                    emit(serde_json::json!({ "ev": "button", "b": b, "down": down }));
                }
            }
        }
        return 1; // swallow: this input belongs to the other machine now
    }
    match msg {
        WM_MOUSEMOVE => {
            let last = LAST_PT.lock().unwrap().replace((x, y)).unwrap_or((x, y));
            on_local_pointer(&screens(), x as f64, y as f64, (x - last.0) as f64, (y - last.1) as f64, ours);
        }
        WM_MOUSEWHEEL | WM_MOUSEHWHEEL => on_local_key(ours),
        _ => {
            if let Some((b, down)) = button_of(msg, info.mouseData) {
                on_local_button(b, down, x as f64, y as f64, ours);
            }
        }
    }
    CallNextHookEx(null_mut(), code, wparam, lparam)
}

fn hid_for(k: &KBDLLHOOKSTRUCT) -> Option<u16> {
    match k.vkCode as u16 {
        VK_NUMLOCK => Some(HID_NUMLOCK),
        VK_PAUSE => Some(HID_PAUSE),
        _ => {
            let sc = (k.scanCode & 0xff) as u16;
            if k.flags & LLKHF_EXTENDED != 0 {
                // some keys (e.g. right shift) are reported as extended although they aren't
                hid_from_win(0xe000 | sc).or_else(|| hid_from_win(sc))
            } else {
                hid_from_win(sc)
            }
        }
    }
}

unsafe extern "system" fn kbd_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code < 0 {
        return CallNextHookEx(null_mut(), code, wparam, lparam);
    }
    let k = &*(lparam as *const KBDLLHOOKSTRUCT);
    let ours = k.flags & LLKHF_INJECTED != 0 && tag_matches(k.dwExtraInfo as u64);
    let up = k.flags & LLKHF_UP != 0;
    LAST_HOOK_TICK.store(k.time, Ordering::Relaxed);
    let capturing = SHARED.lock().unwrap().capturing;
    if !ours && !capturing {
        if let Some(hid) = hid_for(k) {
            note_physical_key(hid, !up);
        }
    }
    if !ours {
        match k.vkCode as u16 {
            VK_CONTROL | VK_LCONTROL | VK_RCONTROL => CTRL.store(!up, Ordering::Relaxed),
            VK_MENU | VK_LMENU | VK_RMENU => ALT.store(!up, Ordering::Relaxed),
            VK_SHIFT | VK_LSHIFT | VK_RSHIFT => SHIFT.store(!up, Ordering::Relaxed),
            _ => {}
        }
    }
    if capturing && !ours {
        let hotkey = CTRL.load(Ordering::Relaxed) && ALT.load(Ordering::Relaxed) && SHIFT.load(Ordering::Relaxed);
        if !up && k.vkCode as u16 == VK_ESCAPE && hotkey {
            hotkey_release();
            return 1;
        }
        if let Some(hid) = hid_for(k) {
            // Windows saw the press of keys held before capture; it must see their release too
            if passthrough_release(hid, !up) {
                return CallNextHookEx(null_mut(), code, wparam, lparam);
            }
            flush_moves();
            emit(serde_json::json!({ "ev": "key", "hid": hid, "down": !up }));
        }
        return 1;
    }
    on_local_key(ours);
    CallNextHookEx(null_mut(), code, wparam, lparam)
}

// ---------------------------------------------------------------- injection
// Never hold a lock across SendInput: it waits for our own hooks, which take the same locks.

fn send(inputs: &[INPUT]) {
    unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), size_of::<INPUT>() as i32) };
}

fn mouse(dx: i32, dy: i32, data: u32, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: magic() as usize } },
    }
}

fn move_abs(x: f64, y: f64) {
    let (vx, vy, vw, vh) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN).max(2),
            GetSystemMetrics(SM_CYVIRTUALSCREEN).max(2),
        )
    };
    let nx = ((x - vx as f64) * 65535.0 / (vw - 1) as f64).round() as i32;
    let ny = ((y - vy as f64) * 65535.0 / (vh - 1) as f64).round() as i32;
    send(&[mouse(nx, ny, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)]);
}

fn post_button(b: u8, down: bool) {
    {
        let mut inj = INJ.lock().unwrap();
        if down {
            inj.buttons |= 1 << b;
        } else {
            inj.buttons &= !(1 << b);
        }
    }
    let (flags, data) = match (b, down) {
        (0, true) => (MOUSEEVENTF_LEFTDOWN, 0),
        (0, false) => (MOUSEEVENTF_LEFTUP, 0),
        (1, true) => (MOUSEEVENTF_RIGHTDOWN, 0),
        (1, false) => (MOUSEEVENTF_RIGHTUP, 0),
        (2, true) => (MOUSEEVENTF_MIDDLEDOWN, 0),
        (2, false) => (MOUSEEVENTF_MIDDLEUP, 0),
        (n, true) => (MOUSEEVENTF_XDOWN, if n == 4 { 2 } else { 1 }),
        (n, false) => (MOUSEEVENTF_XUP, if n == 4 { 2 } else { 1 }),
    };
    send(&[mouse(0, 0, data, flags)]);
}

fn post_key(hid: u16, down: bool) {
    {
        let mut inj = INJ.lock().unwrap();
        if down {
            if !inj.keys.contains(&hid) {
                inj.keys.push(hid);
            }
        } else {
            inj.keys.retain(|&k| k != hid);
        }
    }
    let up = if down { 0 } else { KEYEVENTF_KEYUP };
    let ki = if hid == HID_NUMLOCK || hid == HID_PAUSE {
        let vk = if hid == HID_NUMLOCK { VK_NUMLOCK } else { VK_PAUSE };
        let ext = if hid == HID_NUMLOCK { KEYEVENTF_EXTENDEDKEY } else { 0 };
        KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: up | ext, time: 0, dwExtraInfo: magic() as usize }
    } else {
        let Some(sc) = win_from_hid(hid) else { return };
        let ext = if sc & 0xe000 != 0 { KEYEVENTF_EXTENDEDKEY } else { 0 };
        KEYBDINPUT { wVk: 0, wScan: sc & 0xff, dwFlags: KEYEVENTF_SCANCODE | ext | up, time: 0, dwExtraInfo: magic() as usize }
    };
    send(&[INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki } }]);
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
}

pub fn set_capture(on: bool) {
    if !on {
        return;
    }
    // Park the cursor mid-screen: deltas are measured from here (at an edge they'd be clipped to 0).
    let (x, y) = cursor();
    let s = screens();
    let r = s.iter().find(|r| r.contains(x as f64, y as f64)).or(s.first()).copied();
    if let Some(r) = r {
        let park = ((r.x + r.w / 2.0) as i32, (r.y + r.h / 2.0) as i32);
        *PARK.lock().unwrap() = park;
        unsafe { SetCursorPos(park.0, park.1) };
    }
}

pub fn inject(cmd: Cmd) {
    match cmd {
        Cmd::Move { dx, dy } => {
            let (x, y) = cursor();
            let prev = *VIRT.lock().unwrap();
            let (v, hit) = follower_step(&screens(), prev, (x, y), dx as f64, dy as f64);
            *VIRT.lock().unwrap() = Some(v);
            move_abs(v.pos.0, v.pos.1);
            // a few lines after each entry, so a pointer that does not move can be diagnosed from the log
            if MOVES_LOGGED.load(Ordering::Relaxed) < 3 {
                MOVES_LOGGED.fetch_add(1, Ordering::Relaxed);
                let (ax, ay) = cursor();
                log(&format!("follower move ({dx},{dy}): pointer ({x},{y}) asked for ({:.1},{:.1}) now ({ax},{ay})", v.pos.0, v.pos.1));
            }
            if let Some((side, pos)) = hit {
                on_injected_edge(side, pos);
            }
        }
        Cmd::Button { b, down } => post_button(b.min(4), down),
        Cmd::Wheel { dx, dy } => {
            // widen before scaling so no input can overflow
            let units = |px: i32| ((px as i64 * 120 / 100).clamp(i32::MIN as i64, i32::MAX as i64) as i32) as u32;
            if dy != 0 {
                send(&[mouse(0, 0, units(dy), MOUSEEVENTF_WHEEL)]);
            }
            if dx != 0 {
                send(&[mouse(0, 0, units(dx), MOUSEEVENTF_HWHEEL)]);
            }
        }
        Cmd::Key { hid, down } => post_key(hid, down),
        Cmd::Enter { side, pos } => {
            SCREENS.lock().unwrap().take();
            if let Some((x, y)) = entry_point(&screens(), side, pos) {
                move_abs(x, y);
                *VIRT.lock().unwrap() = Some(Virt::at(x, y));
                MOVES_LOGGED.store(0, Ordering::Relaxed);
            }
        }
        Cmd::ReleaseAll => release_all(),
        Cmd::Config { .. } | Cmd::Capture { .. } | Cmd::Ping | Cmd::Quit => {}
    }
}

pub fn shutdown() {
    SHARED.lock().unwrap().capturing = false;
    release_all();
}

unsafe fn install_hooks() -> bool {
    let hmod = GetModuleHandleW(null());
    let m = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), hmod, 0);
    let k = SetWindowsHookExW(WH_KEYBOARD_LL, Some(kbd_proc), hmod, 0);
    MOUSE_HOOK.store(m, Ordering::Release);
    KBD_HOOK.store(k, Ordering::Release);
    !m.is_null() && !k.is_null()
}

/// Windows silently removes low-level hooks that time out. If the system has seen input our hooks
/// didn't, put them back (and say so).
unsafe fn check_hooks() {
    let mut li = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    if GetLastInputInfo(&mut li) == 0 {
        return;
    }
    let seen = LAST_HOOK_TICK.load(Ordering::Relaxed);
    if seen != 0 && li.dwTime.wrapping_sub(seen) > 1500 && li.dwTime.wrapping_sub(seen) < u32::MAX / 2 {
        for h in [MOUSE_HOOK.swap(null_mut(), Ordering::AcqRel), KBD_HOOK.swap(null_mut(), Ordering::AcqRel)] {
            if !h.is_null() {
                UnhookWindowsHookEx(h);
            }
        }
        let ok = install_hooks();
        LAST_HOOK_TICK.store(li.dwTime, Ordering::Relaxed);
        log(if ok { "input hooks were removed by Windows (timeout); reinstalled" } else { "input hooks were removed and could not be reinstalled" });
    }
}

pub fn run() {
    dpi_aware();
    unsafe {
        if !install_hooks() {
            emit(serde_json::json!({ "ev": "error", "msg": "could not install input hooks" }));
        }
        SetTimer(null_mut(), 0, 2000, None);
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
            if msg.message == WM_TIMER {
                check_hooks();
                continue;
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
