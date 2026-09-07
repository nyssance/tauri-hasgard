use objc2::{rc::Retained, runtime::AnyObject};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};
use objc2_core_graphics::{CGEvent, CGEventField};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};

/// Read actual `AppKit` focus on the main thread; a queued `set_focus` request alone
/// does not prove that the application owns the keyboard.
#[cfg(all(target_os = "macos", debug_assertions))]
fn macos_window_is_focused<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>, activate: bool,
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
    if activate {
        if native.isMiniaturized() {
            native.deminiaturize(None);
        }
        if !native.isKeyWindow() || !native.isVisible() {
            native.makeKeyAndOrderFront(None);
        }
        if !application.isActive() {
            #[allow(deprecated, reason = "supports Tauri's older macOS deployment targets")]
            application.activateIgnoringOtherApps(true);
        }
    }
    Ok(application.isActive() && native.isKeyWindow())
}

#[cfg(all(target_os = "macos", debug_assertions))]
pub(crate) fn focus<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let mut activate = true;
    loop {
        let target = window.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        window
            .with_webview(move |webview| {
                let result = if std::time::Instant::now() >= deadline {
                    Err("focus request expired before reaching the main thread".to_owned())
                } else {
                    macos_window_is_focused(&target, activate).and_then(|focused| {
                        if !focused {
                            return Ok(false);
                        }
                        // A key NSWindow can still have Tao's container as its
                        // first responder. Focus the actual native WKWebView.
                        let native = target.ns_window().map_err(|e| e.to_string())?;
                        if native.is_null() || webview.inner().is_null() {
                            return Err("native window or webview pointer is null".to_owned());
                        }
                        // SAFETY: with_webview runs on the main thread and
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

fn check_dispatch<R: tauri::Runtime>(
    target: &tauri::WebviewWindow<R>, deadline: std::time::Instant,
) -> Result<(), String> {
    if std::time::Instant::now() >= deadline {
        return Err("key injection expired before reaching the main thread".to_owned());
    }
    if !macos_window_is_focused(target, false)? {
        return Err("target window lost focus before key injection".to_owned());
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
    window: &tauri::WebviewWindow<R>, marker: i64, confirm_delivery: bool, task: crate::server::InjectionTask,
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
