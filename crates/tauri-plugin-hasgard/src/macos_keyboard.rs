use objc2::{rc::Retained, runtime::AnyObject};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};
use objc2_core_graphics::{CGEvent, CGEventField};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use tauri::{Manager, Runtime};
use tauri_runtime_wry::WebviewWryExt;

/// Read actual `AppKit` focus on the main thread; a queued `set_focus` request alone
/// does not prove that the application owns the keyboard.
#[cfg(all(target_os = "macos", debug_assertions))]
pub(crate) fn macos_window_is_focused<R: tauri::Runtime>(
    window: &tauri::Window<R>, activate: bool,
) -> Result<bool, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSWindow};
    let main = MainThreadMarker::new().ok_or("AppKit focus must run on the main thread")?;
    let application = NSApplication::sharedApplication(main);
    let native = window.ns_window().map_err(|e| e.to_string())?;
    if native.is_null() {
        return Err("native window pointer is null".to_owned());
    }
    // SAFETY: Tauri owns the NSWindow and we hold its WebviewWindow handle;
    // all AppKit access occurs on the verified main thread.
    let native = unsafe { &*native.cast::<NSWindow>() };
    if delivery()? == Delivery::Window {
        // Window delivery hands events to this window itself and never activates the
        // application, so the developer's own focus is left alone. The window is still made
        // key among the application's own windows: text input follows the key window.
        if activate && !native.isKeyWindow() {
            native.makeKeyWindow();
        }
        return Ok(true);
    }
    if activate {
        if native.isMiniaturized() {
            native.deminiaturize(None);
        }
        if !native.isKeyWindow() || !native.isVisible() {
            native.makeKeyAndOrderFront(None);
        }
        if !application.isActive() {
            #[expect(deprecated, reason = "supports Tauri's older macOS deployment targets")]
            application.activateIgnoringOtherApps(true);
        }
    }
    Ok(application.isActive() && native.isKeyWindow())
}

#[cfg(all(target_os = "macos", debug_assertions))]
pub(crate) fn focus<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String>
where
    R::Handle: tauri_runtime_wry::AsWryHandle,
{
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let mut activate = true;
    loop {
        let target = window.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        window
            .with_wry_webview(move |webview| {
                let result = if std::time::Instant::now() >= deadline {
                    Err("focus request expired before reaching the main thread".to_owned())
                } else {
                    macos_window_is_focused(&target.as_ref().window(), activate).and_then(|focused| {
                        if !focused {
                            return Ok(false);
                        }
                        // A key NSWindow can still have Tao's container as its
                        // first responder. Focus the actual native WKWebView.
                        let native = target.ns_window().map_err(|e| e.to_string())?;
                        if native.is_null() || webview.inner().is_null() {
                            return Err("native window or webview pointer is null".to_owned());
                        }
                        // SAFETY: with_wry_webview runs on the main thread and
                        // retains the WKWebView for this callback.
                        let (native, view) = unsafe {
                            (
                                &*native.cast::<objc2_app_kit::NSWindow>(),
                                &*webview.inner().cast::<objc2_app_kit::NSView>(),
                            )
                        };
                        if !native.makeFirstResponder(Some(view)) {
                            return Err("native webview refused keyboard focus".to_owned());
                        }
                        Ok(true)
                    })
                };
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        if rx
            .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
            .map_err(|e| format!("native window focus timed out: {e}"))??
        {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err("application did not acquire native keyboard focus".to_owned());
        }
        activate = false;
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

thread_local! {
    static MONITORS: RefCell<HashMap<i64, Retained<AnyObject>>> = RefCell::new(HashMap::new());
}

fn remove_monitor(marker: i64) {
    MONITORS.with(|monitors| {
        if let Some(monitor) = monitors.borrow_mut().remove(&marker) {
            // SAFETY: the token came from NSEvent's monitor API; this function
            // only runs on the AppKit main thread.
            unsafe { NSEvent::removeMonitor(&monitor) };
        }
    });
}

fn check_dispatch<R: tauri::Runtime>(target: &tauri::Window<R>, deadline: std::time::Instant) -> Result<(), String> {
    if std::time::Instant::now() >= deadline {
        return Err("key injection expired before reaching the main thread".to_owned());
    }
    if !macos_window_is_focused(target, false)? {
        return Err("target window lost focus before key injection".to_owned());
    }
    if delivery()? == Delivery::Window {
        // The events carry their own modifier flags; keys the developer is holding are not part of them.
        return Ok(());
    }
    let held = NSEvent::modifierFlags_class().intersection(
        NSEventModifierFlags::Shift
            | NSEventModifierFlags::Control
            | NSEventModifierFlags::Option
            | NSEventModifierFlags::Command,
    );
    if !held.is_empty() {
        return Err(format!("modifiers remain held before key injection: 0x{:x}", held.bits()));
    }
    Ok(())
}

pub(crate) fn inject<R: tauri::Runtime>(
    window: &tauri::Window<R>, marker: i64, confirm_delivery: bool, task: crate::server::InjectionTask,
) -> Result<(), crate::server::InjectionError> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    // Pending -> started or cancelled is atomic: a timeout before dispatch
    // cannot report non-injection and then allow a queued task to inject later.
    let state = std::sync::Arc::new(AtomicU8::new(0));
    let task_state = state.clone();
    let task = move || {
        task_state
            .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "key injection was cancelled before dispatch".to_owned())?;
        task()
    };
    let target = window.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    // Preserve evidence for interrupted desktop input without changing delivery
    // semantics or retrying a gesture that may already have been injected.
    let observation = std::sync::Arc::new(std::sync::Mutex::new(None));
    let observed = observation.clone();
    window
        .run_on_main_thread(move || {
            let start = (|| -> Result<(), String> {
                check_dispatch(&target, deadline)?;
                if delivery()? == Delivery::Window {
                    let _ = tx.send(run_in_window(&target, task)?);
                    return Ok(());
                }
                if !confirm_delivery {
                    let result = task();
                    let _ = tx.send(result);
                    return Ok(());
                }
                let native = target.ns_window().map_err(|e| e.to_string())?;
                if native.is_null() {
                    return Err("native window pointer is null".to_owned());
                }
                // SAFETY: Tauri retains this NSWindow and we are on the main thread.
                let number = unsafe { &*native.cast::<objc2_app_kit::NSWindow>() }.windowNumber();
                let delivered = tx.clone();
                let callback = block2::RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| {
                    // SAFETY: AppKit supplies a valid event for the monitor callback.
                    let value = unsafe { event.as_ref() };
                    if let Some(cg) = value.CGEvent()
                        && CGEvent::integer_value_field(Some(&cg), CGEventField::EventSourceUserData) == marker
                    {
                        let flags = value.modifierFlags().intersection(
                            NSEventModifierFlags::Shift
                                | NSEventModifierFlags::Control
                                | NSEventModifierFlags::Option
                                | NSEventModifierFlags::Command,
                        );
                        if let Ok(mut last) = observed.lock() {
                            *last = Some((value.windowNumber(), number, flags.bits()));
                        }
                        if !flags.is_empty() {
                            return event.as_ptr();
                        }
                        let result = if value.windowNumber() == number {
                            Ok(())
                        } else {
                            Err("native key event reached a different window".to_owned())
                        };
                        let _ = delivered.send(result);
                    }
                    event.as_ptr()
                });
                // SAFETY: the block returns the original live event without changing
                // or consuming it. NSEvent retains the block until removal.
                let monitor = unsafe {
                    NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                        NSEventMask::KeyUp | NSEventMask::FlagsChanged,
                        &callback,
                    )
                }
                .ok_or("could not install native key delivery monitor")?;
                MONITORS.with(|monitors| monitors.borrow_mut().insert(marker, monitor));
                task()
            })();
            if let Err(error) = start {
                remove_monitor(marker);
                let _ = tx.send(Err(error));
            }
        })
        .map_err(|e| crate::server::InjectionError {
            message: format!("could not reach the main thread: {e}"),
            started: false,
        })?;
    let result = rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())).map_err(|e| {
        let evidence = match observation.lock() {
            Ok(last) => match *last {
                Some((actual, expected, flags)) => {
                    format!("last marked event window={actual}, expected={expected}, held modifiers=0x{flags:x}")
                }
                None => "no marked release event observed".to_owned(),
            },
            Err(error) => format!("event diagnostics unavailable: {error}"),
        };
        format!("native key delivery was not acknowledged before its deadline: {e}; {evidence}")
    });
    let cleanup = window
        .run_on_main_thread(move || remove_monitor(marker))
        .map_err(|e| format!("could not remove key delivery monitor: {e}"));
    // Cancel a task that has not started before exposing injected=false.
    let started = state.compare_exchange(0, 2, Ordering::SeqCst, Ordering::SeqCst).is_err();
    match (result.and_then(|delivery| delivery), cleanup) {
        (Ok(()), cleanup) => cleanup,
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(cleanup)) => Err(format!("{error}; {cleanup}")),
    }
    .map_err(|message| crate::server::InjectionError { message, started })
}

/// Run a press task with `window` as the target of [`deliver`].
///
/// Delivery is synchronous: the window has processed the events when the task returns, so there is no
/// asynchronous arrival to confirm with an event monitor.
fn run_in_window<R: tauri::Runtime>(
    window: &tauri::Window<R>, task: impl FnOnce() -> Result<(), String>,
) -> Result<Result<(), String>, String> {
    let native = window.ns_window().map_err(|e| e.to_string())?;
    if native.is_null() {
        return Err("native window pointer is null".to_owned());
    }
    DIRECT_TARGET.with(|slot| slot.set(native.cast::<objc2_app_kit::NSWindow>()));
    let result = task();
    DIRECT_TARGET.with(|slot| slot.set(std::ptr::null_mut()));
    Ok(result)
}

/// Where `press` sends its key events on macOS, chosen by `TAURI_HASGARD_PRESS`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Delivery {
    /// The system input layer (the default): the events take the same path as a physical keyboard, so the
    /// application has to be frontmost and the target window key.
    System,
    /// `TAURI_HASGARD_PRESS=window`: the events are handed to the target window on the main thread, through the
    /// same key-equivalent and responder dispatch `NSApplication` performs. Nothing is activated, so a run does
    /// not compete with whoever is using the machine. System-wide shortcuts are registered below `AppKit` and do
    /// not see these events.
    Window,
}

pub(crate) const DELIVERY_ENV: &str = "TAURI_HASGARD_PRESS";

pub(crate) fn parse_delivery(value: Option<&str>) -> Result<Delivery, String> {
    match value {
        None | Some("system") => Ok(Delivery::System),
        Some("window") => Ok(Delivery::Window),
        Some(other) => Err(format!("{DELIVERY_ENV} must be `system` or `window`, got `{other}`")),
    }
}

pub(crate) fn delivery() -> Result<Delivery, String> {
    match std::env::var(DELIVERY_ENV) {
        Ok(value) => parse_delivery(Some(&value)),
        Err(std::env::VarError::NotPresent) => parse_delivery(None),
        Err(error) => Err(format!("{DELIVERY_ENV}: {error}")),
    }
}

thread_local! {
    /// The window of the press being delivered; set by `inject` around its task, on the main thread.
    static DIRECT_TARGET: std::cell::Cell<*mut objc2_app_kit::NSWindow> = const { std::cell::Cell::new(std::ptr::null_mut()) };
}

const MODIFIER_FLAGS: [(enigo::Key, objc2_core_graphics::CGEventFlags, u16); 4] = [
    (enigo::Key::Shift, objc2_core_graphics::CGEventFlags::MaskShift, 56),
    (enigo::Key::Control, objc2_core_graphics::CGEventFlags::MaskControl, 59),
    (enigo::Key::Alt, objc2_core_graphics::CGEventFlags::MaskAlternate, 58),
    (enigo::Key::Meta, objc2_core_graphics::CGEventFlags::MaskCommand, 55),
];

fn modifier(key: enigo::Key) -> Option<(objc2_core_graphics::CGEventFlags, u16)> {
    MODIFIER_FLAGS.iter().find(|(candidate, ..)| *candidate == key).map(|(_, flags, code)| (*flags, *code))
}

/// Virtual keycode and implied flags of a key that is the same on every layout.
fn fixed_key(key: enigo::Key) -> Option<(u16, objc2_core_graphics::CGEventFlags)> {
    use enigo::Key;
    use objc2_core_graphics::CGEventFlags;
    let function = CGEventFlags::MaskSecondaryFn;
    let arrow = CGEventFlags::MaskSecondaryFn | CGEventFlags::MaskNumericPad;
    Some(match key {
        Key::Return => (36, CGEventFlags::empty()),
        Key::Tab => (48, CGEventFlags::empty()),
        Key::Space => (49, CGEventFlags::empty()),
        Key::Backspace => (51, CGEventFlags::empty()),
        Key::Escape => (53, CGEventFlags::empty()),
        Key::Delete => (117, function),
        Key::Home => (115, function),
        Key::End => (119, function),
        Key::PageUp => (116, function),
        Key::PageDown => (121, function),
        Key::LeftArrow => (123, arrow),
        Key::RightArrow => (124, arrow),
        Key::DownArrow => (125, arrow),
        Key::UpArrow => (126, arrow),
        Key::F1 => (122, function),
        Key::F2 => (120, function),
        Key::F3 => (99, function),
        Key::F4 => (118, function),
        Key::F5 => (96, function),
        Key::F6 => (97, function),
        Key::F7 => (98, function),
        Key::F8 => (100, function),
        Key::F9 => (101, function),
        Key::F10 => (109, function),
        Key::F11 => (103, function),
        Key::F12 => (111, function),
        _ => return None,
    })
}

fn key_event(
    code: u16, down: bool, flags: objc2_core_graphics::CGEventFlags, marker: i64, flags_changed: bool,
) -> Result<Retained<NSEvent>, String> {
    let event = CGEvent::new_keyboard_event(None, code, down).ok_or("could not create a key event")?;
    if flags_changed {
        CGEvent::set_type(Some(&event), objc2_core_graphics::CGEventType::FlagsChanged);
    }
    CGEvent::set_flags(Some(&event), flags);
    CGEvent::set_integer_value_field(Some(&event), CGEventField::EventSourceUserData, marker);
    NSEvent::eventWithCGEvent(&event).ok_or_else(|| "could not convert the key event for AppKit".to_owned())
}

/// The key that types `ch` on the current keyboard layout, and whether it needs Shift.
///
/// `AppKit` translates a keycode through the active layout when it builds an event, so the lookup asks it
/// directly: the letter keys sit at other keycodes on Dvorak or AZERTY, and a fixed table would press the wrong
/// one — and with it the wrong menu shortcut.
fn character_key(ch: char, marker: i64) -> Result<(u16, bool), String> {
    use objc2_core_graphics::CGEventFlags;
    let wanted = ch.to_string();
    for (flags, shifted) in [(CGEventFlags::empty(), false), (CGEventFlags::MaskShift, true)] {
        // 0..=50 are the character keys of the main block; the keypad repeats digits and is not wanted here.
        for code in 0..=50u16 {
            if fixed_key_codes().contains(&code) {
                continue;
            }
            if key_event(code, true, flags, marker, false)?
                .characters()
                .is_some_and(|typed| typed.to_string() == wanted)
            {
                return Ok((code, shifted));
            }
        }
    }
    Err(format!("the current keyboard layout has no key for {ch:?}"))
}

fn fixed_key_codes() -> [u16; 3] {
    [36, 48, 49]
}

/// Deliver one combo to the window `inject` selected, or `None` when this press goes through the system.
pub(crate) fn deliver(modifiers: &[enigo::Key], key: enigo::Key, marker: i64) -> Option<Result<(), String>> {
    use objc2_core_graphics::CGEventFlags;
    let window = DIRECT_TARGET.with(std::cell::Cell::get);
    if window.is_null() {
        return None;
    }
    Some((|| {
        let main = objc2::MainThreadMarker::new().ok_or("key delivery must run on the main thread")?;
        // SAFETY: `inject` stores a window Tauri retains, on this thread, for the duration of this call.
        let window = unsafe { &*window };
        // Typed characters reach the view through its text input context, and `AppKit` only keeps
        // the context of the active application's key view current. Make this one current, or the
        // text would land in whichever view was typed into last.
        if let Some(view) =
            window.firstResponder().and_then(|responder| responder.downcast::<objc2_app_kit::NSView>().ok())
            && let Some(context) = view.inputContext()
        {
            context.activate();
        }
        let mut held = CGEventFlags::empty();
        let mut pressed = Vec::with_capacity(modifiers.len());
        for candidate in modifiers {
            let (flag, code) = modifier(*candidate).ok_or_else(|| format!("{candidate:?} is not a modifier"))?;
            held |= flag;
            window.sendEvent(&*key_event(code, true, held, marker, true)?);
            pressed.push((flag, code));
        }
        let outcome = (|| -> Result<(), String> {
            if let Some((flag, code)) = modifier(key) {
                window.sendEvent(&*key_event(code, true, held | flag, marker, true)?);
                window.sendEvent(&*key_event(code, false, held, marker, true)?);
                return Ok(());
            }
            let (code, flags) = match (key, fixed_key(key)) {
                (_, Some((code, extra))) => (code, held | extra),
                (enigo::Key::Unicode(ch), None) => {
                    let (code, shifted) = character_key(ch, marker)?;
                    // A bare `press "P"` types the capital; with modifiers the combo names the key, not the case.
                    (code, if shifted && modifiers.is_empty() { held | CGEventFlags::MaskShift } else { held })
                }
                (other, None) => return Err(format!("{other:?} cannot be delivered to a window")),
            };
            let down = key_event(code, true, flags, marker, false)?;
            // NSApplication offers a Command or Control key-down to the window's key equivalents, then to the
            // main menu, and only sends it down the responder chain when neither takes it.
            let handled = flags.intersects(CGEventFlags::MaskCommand | CGEventFlags::MaskControl)
                && (window.performKeyEquivalent(&down)
                    || objc2_app_kit::NSApplication::sharedApplication(main)
                        .mainMenu()
                        .is_some_and(|menu| menu.performKeyEquivalent(&down)));
            if !handled {
                window.sendEvent(&down);
            }
            window.sendEvent(&*key_event(code, false, flags, marker, false)?);
            Ok(())
        })();
        // Release what was pressed even when the key itself failed, so the page never keeps a modifier down.
        let mut release = Ok(());
        for (flag, code) in pressed.into_iter().rev() {
            held.remove(flag);
            match key_event(code, false, held, marker, true) {
                Ok(event) => window.sendEvent(&event),
                Err(error) if release.is_ok() => release = Err(error),
                Err(_) => {}
            }
        }
        outcome.and(release)
    })())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn press_delivery_defaults_to_the_system_and_rejects_unknown_values() {
        assert_eq!(parse_delivery(None), Ok(Delivery::System));
        assert_eq!(parse_delivery(Some("system")), Ok(Delivery::System));
        assert_eq!(parse_delivery(Some("window")), Ok(Delivery::Window));
        assert!(parse_delivery(Some("")).is_err());
        assert!(parse_delivery(Some("Window")).is_err());
    }

    #[test]
    fn fixed_keys_and_modifiers_do_not_overlap() {
        for (key, ..) in MODIFIER_FLAGS {
            assert!(fixed_key(key).is_none());
        }
        assert_eq!(fixed_key(enigo::Key::Escape).map(|(code, _)| code), Some(53));
        assert!(fixed_key(enigo::Key::Unicode('a')).is_none());
    }
}
