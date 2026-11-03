//! `heap.snapshot`: a JavaScript heap snapshot of one webview.
//!
//! - macOS: `WKWebView` has no public heap API. Safari's Web Inspector takes the
//!   snapshot through the inspector backend, and the in-process `_WKInspector`
//!   (`-[WKWebView _inspector]`) can connect that backend without showing a
//!   window. Its frontend is itself a `WKWebView` (`inspectorWebView`), so the
//!   snapshot is requested there with `HeapAgent.snapshot()`, the call behind
//!   Safari's "JavaScript Allocations" timeline. These are `WebKit` SPI selectors;
//!   each is checked with `respondsToSelector:` so an OS that drops one fails the
//!   call instead of crashing the host. Output: `JavaScriptCore`'s snapshot JSON
//!   (`{"version":3,"type":"Inspector",…}`).
//! - Windows: `WebView2` exposes the Chrome `DevTools` protocol, so the snapshot is
//!   `HeapProfiler.takeHeapSnapshot`, streamed back through
//!   `HeapProfiler.addHeapSnapshotChunk` events. Output: a V8 `.heapsnapshot`.
//!
//! Both engines run a full collection before building the snapshot, so it holds
//! live objects only.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock, mpsc};
use std::time::Duration;

use serde_json::{Value, json};

use crate::protocol::RpcError;

/// Snapshot format reported alongside the file, so a reader knows which parser applies.
#[cfg(target_os = "macos")]
const FORMAT: &str = "jsc";
#[cfg(windows)]
const FORMAT: &str = "v8";

/// Resolves a window label to the serialized snapshot.
pub(crate) type HeapSnapshotFn = Arc<dyn Fn(Option<&str>) -> Result<String, String> + Send + Sync>;

static HEAP_SNAPSHOT_FN: RwLock<Option<HeapSnapshotFn>> = RwLock::new(None);

pub(crate) fn register_heap_snapshot_fn(capture: HeapSnapshotFn) {
    if let Ok(mut slot) = HEAP_SNAPSHOT_FN.write() {
        *slot = Some(capture);
    }
}

fn heap_snapshot_fn() -> Option<HeapSnapshotFn> {
    HEAP_SNAPSHOT_FN.read().ok()?.clone()
}

/// A full collection plus serialization of a large heap takes seconds.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(120);

/// The single-use sender behind a mutex, for completion callbacks typed `Fn`.
type Reply = Arc<std::sync::Mutex<Option<mpsc::SyncSender<Result<String, String>>>>>;

fn reply(slot: &Reply, outcome: Result<String, String>) {
    if let Some(sender) = slot.lock().ok().and_then(|mut guard| guard.take()) {
        // A dropped receiver means the caller already timed out.
        let _ = sender.send(outcome);
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;

    use super::{Reply, SNAPSHOT_TIMEOUT, reply};

    /// The inspector frontend loads asynchronously after `connect`: `inspectorWebView`
    /// stays nil until it exists, then loads its page.
    const FRONTEND_ATTEMPTS: u32 = 100;
    const FRONTEND_INTERVAL: Duration = Duration::from_millis(100);

    /// `WebKit`'s error for a script whose page navigated away before it completed.
    const FRONTEND_RELOADED: &str = "no longer reachable";

    /// Runs in the frontend page: waits for the inspector's main target, then asks
    /// its heap agent for a snapshot.
    const SNAPSHOT_SCRIPT: &str = "for (let i = 0; i < 200 && !window.WI?.mainTarget?.HeapAgent; i++) await new Promise(resolve => setTimeout(resolve, 50));
if (!window.WI?.mainTarget?.HeapAgent) throw new Error('Web Inspector frontend has no heap agent');
const { snapshotData } = await WI.mainTarget.HeapAgent.snapshot();
return snapshotData;";

    enum Attempt {
        /// `inspectorWebView` is not there yet; ask again.
        FrontendPending,
        Requested(mpsc::Receiver<Result<String, String>>),
    }

    /// Take a heap snapshot of a Tauri `WebviewWindow`, blocking the calling (non-main) thread.
    pub(crate) fn capture<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<String, String>
    where
        R::Handle: tauri_runtime_wry::AsWryHandle,
    {
        let mut attempts = 0;
        let outcome = loop {
            let retry = match request(window)? {
                Attempt::FrontendPending => None,
                Attempt::Requested(receiver) => match receiver.recv_timeout(SNAPSHOT_TIMEOUT) {
                    // A reconnected inspector reuses its frontend view and reloads it;
                    // a script that arrived before that navigation dies with the old page.
                    Ok(Err(message)) if message.contains(FRONTEND_RELOADED) => Some(message),
                    outcome => break outcome.map_err(|err| format!("heap snapshot did not complete: {err}")),
                },
            };
            if attempts == FRONTEND_ATTEMPTS {
                break Err(retry.unwrap_or_else(|| "Web Inspector frontend did not load".to_owned()));
            }
            attempts += 1;
            std::thread::sleep(FRONTEND_INTERVAL);
        };
        // Detach the backend again: an attached inspector keeps instrumentation on
        // and would skew whatever the caller measures next.
        close(window);
        outcome?
    }

    fn request<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<Attempt, String>
    where
        R::Handle: tauri_runtime_wry::AsWryHandle,
    {
        use block2::RcBlock;
        use objc2::MainThreadMarker;
        use objc2::rc::Retained;
        use objc2::runtime::{AnyObject, Bool, Sel};
        use objc2::{msg_send, sel};
        use objc2_foundation::{NSError, NSString};
        use objc2_web_kit::{WKContentWorld, WKWebView};
        use tauri_runtime_wry::WebviewWryExt;

        let (attempt_tx, attempt_rx) = mpsc::sync_channel::<Result<Attempt, String>>(1);
        window
            .with_wry_webview(move |webview| {
                let result = (|| {
                    let mtm = MainThreadMarker::new().ok_or("heap snapshot closure did not run on the main thread")?;
                    // SAFETY: Wry runs this closure on the main thread with the live `WKWebView *` it owns.
                    let wk_webview =
                        unsafe { webview.inner().cast::<WKWebView>().as_ref() }.ok_or("webview has no WKWebView")?;
                    let responds = |object: &AnyObject, selector: Sel| -> bool {
                        // SAFETY: `respondsToSelector:` is NSObject protocol, valid on every object here.
                        let answer: Bool = unsafe { msg_send![object, respondsToSelector: selector] };
                        answer.as_bool()
                    };
                    // SAFETY: plain property reads on a live main-thread WKWebView.
                    let preferences = unsafe { wk_webview.configuration().preferences() };
                    if !responds(&preferences, sel!(_setDeveloperExtrasEnabled:)) {
                        return Err("WKPreferences has no _setDeveloperExtrasEnabled:".to_owned());
                    }
                    // SAFETY: checked above; a BOOL setter.
                    let (): () = unsafe { msg_send![&*preferences, _setDeveloperExtrasEnabled: Bool::YES] };
                    if !responds(wk_webview, sel!(_inspector)) {
                        return Err("WKWebView has no _inspector".to_owned());
                    }
                    // SAFETY: checked above; returns the view's `_WKInspector`, owned by the view.
                    let inspector: Option<Retained<AnyObject>> = unsafe { msg_send![wk_webview, _inspector] };
                    let inspector = inspector.ok_or("WKWebView returned no _WKInspector")?;
                    for selector in [sel!(isConnected), sel!(connect), sel!(inspectorWebView)] {
                        if !responds(&inspector, selector) {
                            return Err(format!("_WKInspector has no {}", selector.name().to_string_lossy()));
                        }
                    }
                    // SAFETY: selectors checked above.
                    let connected: Bool = unsafe { msg_send![&*inspector, isConnected] };
                    if !connected.as_bool() {
                        let (): () = unsafe { msg_send![&*inspector, connect] };
                    }
                    let frontend: Option<Retained<WKWebView>> = unsafe { msg_send![&*inspector, inspectorWebView] };
                    let Some(frontend) = frontend else { return Ok(Attempt::FrontendPending) };
                    // A script sent while the frontend page is still navigating dies with
                    // the old document ("A JavaScript exception occurred"); wait for the load.
                    // SAFETY: plain property reads on a live main-thread WKWebView.
                    if unsafe { frontend.isLoading() || frontend.URL().is_none() } {
                        return Ok(Attempt::FrontendPending);
                    }

                    let (sender, receiver) = mpsc::sync_channel(1);
                    let slot: Reply = Arc::new(Mutex::new(Some(sender)));
                    let block = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
                        // SAFETY: WebKit hands back an autoreleased result or error for this call.
                        let outcome = match (unsafe { value.as_ref() }, unsafe { error.as_ref() }) {
                            (_, Some(error)) => Err(exception_message(error)),
                            (Some(value), None) => value
                                .downcast_ref::<NSString>()
                                .map(ToString::to_string)
                                .ok_or_else(|| "heap snapshot result is not a string".to_owned()),
                            (None, None) => Err("heap snapshot returned nothing".to_owned()),
                        };
                        reply(&slot, outcome);
                    });
                    // SAFETY: main thread, live frontend view; WebKit retains the block until it runs.
                    unsafe {
                        frontend.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                            &NSString::from_str(SNAPSHOT_SCRIPT),
                            None,
                            None,
                            &WKContentWorld::pageWorld(mtm),
                            Some(&block),
                        );
                    }
                    Ok(Attempt::Requested(receiver))
                })();
                // A dropped receiver means the caller is gone; nothing to report to.
                let _ = attempt_tx.send(result);
            })
            .map_err(|err| format!("webview handle unavailable: {err}"))?;
        attempt_rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|err| format!("main thread did not run the heap request: {err}"))?
    }

    /// `WebKit` reports a thrown script error as "A JavaScript exception occurred";
    /// the actual message is in the userInfo.
    fn exception_message(error: &objc2_foundation::NSError) -> String {
        use objc2_foundation::{NSString, ns_string};

        let user_info = error.userInfo();
        user_info
            .objectForKey(ns_string!("WKJavaScriptExceptionMessage"))
            .and_then(|message| message.downcast::<NSString>().ok())
            .map_or_else(|| error.localizedDescription().to_string(), |message| format!("Web Inspector: {message}"))
    }

    fn close<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>)
    where
        R::Handle: tauri_runtime_wry::AsWryHandle,
    {
        use objc2::rc::Retained;
        use objc2::runtime::{AnyObject, Bool};
        use objc2::{msg_send, sel};
        use objc2_web_kit::WKWebView;
        use tauri_runtime_wry::WebviewWryExt;

        // Best effort: a webview that went away has no inspector left to detach.
        let _ = window.with_wry_webview(|webview| {
            // SAFETY: main thread, live WKWebView; `_inspector` was checked by `request`.
            let Some(wk_webview) = (unsafe { webview.inner().cast::<WKWebView>().as_ref() }) else { return };
            let inspector: Option<Retained<AnyObject>> = unsafe { msg_send![wk_webview, _inspector] };
            if let Some(inspector) = inspector {
                let responds: Bool = unsafe { msg_send![&*inspector, respondsToSelector: sel!(close)] };
                if responds.as_bool() {
                    let (): () = unsafe { msg_send![&*inspector, close] };
                }
            }
        });
    }
}

#[cfg(windows)]
mod platform {
    use std::sync::{Arc, Mutex, mpsc};

    use super::{Reply, SNAPSHOT_TIMEOUT, reply};

    /// Take a heap snapshot of a Tauri `WebviewWindow`, blocking the calling (non-UI) thread.
    pub(crate) fn capture<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<String, String>
    where
        R::Handle: tauri_runtime_wry::AsWryHandle,
    {
        use tauri_runtime_wry::WebviewWryExt;
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
        use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, DevToolsProtocolEventReceivedEventHandler};
        use windows::core::{PWSTR, w};

        let (sender, receiver) = mpsc::sync_channel(1);
        let slot: Reply = Arc::new(Mutex::new(Some(sender)));
        let failed = Arc::clone(&slot);
        window
            .with_wry_webview(move |webview| {
                let started = (|| -> windows::core::Result<()> {
                    // SAFETY: Wry runs this closure on the UI thread that owns the controller.
                    let core: ICoreWebView2 = unsafe { webview.controller().CoreWebView2()? };
                    let chunks = Arc::new(Mutex::new(String::new()));
                    let sink = Arc::clone(&chunks);
                    // SAFETY: a documented CDP event name on a live ICoreWebView2.
                    let events =
                        unsafe { core.GetDevToolsProtocolEventReceiver(w!("HeapProfiler.addHeapSnapshotChunk"))? };
                    let mut token = 0;
                    let on_chunk = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut json = PWSTR::null();
                        // SAFETY: the args object is valid for this callback; take_pwstr frees the string.
                        unsafe { args.ParameterObjectAsJson(&raw mut json)? };
                        let json = webview2_com::take_pwstr(json);
                        let chunk = serde_json::from_str::<serde_json::Value>(&json).ok().and_then(|value| {
                            value.get("chunk").and_then(serde_json::Value::as_str).map(str::to_owned)
                        });
                        if let (Some(chunk), Ok(mut buffer)) = (chunk, sink.lock()) {
                            buffer.push_str(&chunk);
                        }
                        Ok(())
                    }));
                    // SAFETY: registers a handler on the live receiver; removed once the snapshot completes.
                    unsafe { events.add_DevToolsProtocolEventReceived(&on_chunk, &raw mut token)? };
                    let snapshot_core = core.clone();
                    let done = Arc::clone(&slot);
                    // `takeHeapSnapshot` answers after the last chunk event was dispatched.
                    let on_snapshot = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, _| {
                        // SAFETY: same receiver and token registered above, on the UI thread.
                        let _ = unsafe { events.remove_DevToolsProtocolEventReceived(token) };
                        let outcome = result
                            .map_err(|err| format!("HeapProfiler.takeHeapSnapshot failed: {err}"))
                            .and_then(|()| {
                                chunks
                                    .lock()
                                    .map(|mut buffer| std::mem::take(&mut *buffer))
                                    .map_err(|_| "heap snapshot buffer was poisoned".to_owned())
                            });
                        reply(&done, outcome);
                        Ok(())
                    }));
                    let enabled_slot = Arc::clone(&slot);
                    let on_enabled = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, _| {
                        if let Err(err) = result {
                            reply(&enabled_slot, Err(format!("HeapProfiler.enable failed: {err}")));
                            return Ok(());
                        }
                        // SAFETY: documented CDP method on the live ICoreWebView2, UI thread.
                        if let Err(err) = unsafe {
                            snapshot_core.CallDevToolsProtocolMethod(
                                w!("HeapProfiler.takeHeapSnapshot"),
                                w!("{\"reportProgress\":false}"),
                                &on_snapshot,
                            )
                        } {
                            reply(&enabled_slot, Err(format!("HeapProfiler.takeHeapSnapshot failed: {err}")));
                        }
                        Ok(())
                    }));
                    // SAFETY: documented CDP method on the live ICoreWebView2, UI thread.
                    unsafe { core.CallDevToolsProtocolMethod(w!("HeapProfiler.enable"), w!("{}"), &on_enabled)? };
                    Ok(())
                })();
                if let Err(err) = started {
                    reply(&failed, Err(format!("heap snapshot could not start: {err}")));
                }
            })
            .map_err(|err| format!("webview handle unavailable: {err}"))?;
        receiver.recv_timeout(SNAPSHOT_TIMEOUT).map_err(|err| format!("heap snapshot did not complete: {err}"))?
    }
}

pub(crate) use platform::capture;

/// JSON-RPC `heap.snapshot`: `{ output_path }` (absolute, parent must exist) →
/// `{ output_path, byte_size, format }`. The snapshot is written next to the
/// target and renamed into place, so a reader never sees a partial file.
pub(crate) async fn handle_heap_snapshot(window: Option<String>, params: Option<&Value>) -> Result<Value, RpcError> {
    let output_path = output_path(params)?;
    tokio::task::spawn_blocking(move || {
        let capture = heap_snapshot_fn().ok_or_else(|| internal("heap snapshot is not available in this process"))?;
        let snapshot = capture(window.as_deref()).map_err(|message| {
            if message.contains("not found") {
                RpcError { code: -32602, message, data: None }
            } else {
                internal(message)
            }
        })?;
        let partial = output_path.with_extension("partial");
        std::fs::write(&partial, snapshot.as_bytes()).and_then(|()| std::fs::rename(&partial, &output_path)).map_err(
            |err| {
                let _ = std::fs::remove_file(&partial);
                internal(format!("failed to write {}: {err}", output_path.display()))
            },
        )?;
        Ok(json!({ "output_path": output_path, "byte_size": snapshot.len(), "format": FORMAT }))
    })
    .await
    .map_err(|err| internal(format!("heap snapshot task did not complete: {err}")))?
}

fn output_path(params: Option<&Value>) -> Result<PathBuf, RpcError> {
    let invalid = |message: String| RpcError { code: -32602, message, data: None };
    let raw = params
        .and_then(|params| params.get("output_path"))
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("output_path is required".to_owned()))?;
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(invalid(format!("output_path must be absolute: {raw}")));
    }
    match path.parent() {
        Some(parent) if parent.is_dir() => Ok(path.to_path_buf()),
        _ => Err(invalid(format!("output_path parent directory does not exist: {raw}"))),
    }
}

fn internal(message: impl Into<String>) -> RpcError {
    RpcError { code: -32603, message: message.into(), data: None }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn output_path_must_be_absolute_with_an_existing_parent() {
        let directory = std::env::temp_dir();
        let inside = directory.join("heap.json");
        assert_eq!(super::output_path(Some(&json!({ "output_path": inside }))).expect("valid path"), inside);
        for params in [
            None,
            Some(json!({})),
            Some(json!({ "output_path": "relative/heap.json" })),
            Some(json!({ "output_path": directory.join("hasgard-missing-directory/heap.json") })),
        ] {
            assert_eq!(super::output_path(params.as_ref()).expect_err("rejected").code, -32602);
        }
    }
}
