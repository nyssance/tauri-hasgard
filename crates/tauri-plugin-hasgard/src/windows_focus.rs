//! Confirms that a window took keyboard focus before keys are injected.
//!
//! `SendInput` delivers to whichever window is in the foreground, not to the
//! one a caller asked for. Windows may refuse an activation request, so asking
//! for focus is not evidence of having it: without this check a refused request
//! types into another application and still reports success.

use std::time::{Duration, Instant};

use windows::Win32::UI::WindowsAndMessaging::{GUITHREADINFO, GetForegroundWindow, GetGUIThreadInfo};

/// How long the window manager gets to bring the window forward.
const FOREGROUND_TIMEOUT: Duration = Duration::from_secs(2);
const FOREGROUND_POLL: Duration = Duration::from_millis(5);
/// Time for a focus change to reach the webview's own process before the
/// first key is posted. Only paid when focus actually moved.
const FOCUS_SETTLE: Duration = Duration::from_millis(80);

/// Where keyboard input currently goes: the foreground window and the control
/// inside it that holds focus.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct InputFocus {
    foreground: isize,
    focused: isize,
}

pub(crate) fn current() -> InputFocus {
    let foreground = unsafe { GetForegroundWindow() }.0 as isize;
    let size = u32::try_from(size_of::<GUITHREADINFO>()).expect("GUITHREADINFO size fits in u32");
    let mut info = GUITHREADINFO { cbSize: size, ..Default::default() };
    // Thread 0 is the foreground thread. With no foreground thread — a desktop
    // switch, a lock screen — the call fails and no control has focus.
    let focused = match unsafe { GetGUIThreadInfo(0, &raw mut info) } {
        Ok(()) => info.hwndFocus.0 as isize,
        Err(_) => 0,
    };
    InputFocus { foreground, focused }
}

/// Wait for `hwnd` to be the foreground window, then let a focus change settle.
///
/// `before` is the focus read ahead of the focus request. When nothing moved —
/// the common case of consecutive presses into one window — there is nothing
/// to settle and the call returns at once.
pub(crate) fn confirm(hwnd: isize, before: InputFocus) -> Result<(), String> {
    let deadline = Instant::now() + FOREGROUND_TIMEOUT;
    let mut now = current();
    while now.foreground != hwnd {
        if Instant::now() >= deadline {
            return Err("window did not become the foreground window; Windows refused the activation".to_owned());
        }
        std::thread::sleep(FOREGROUND_POLL);
        now = current();
    }
    if now != before {
        std::thread::sleep(FOCUS_SETTLE);
    }
    Ok(())
}
