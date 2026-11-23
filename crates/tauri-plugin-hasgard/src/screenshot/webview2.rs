//! Composited page capture for Wry on Windows.
//!
//! `WebView2` answers the `DevTools` protocol in-process, so `Page.captureScreenshot`
//! returns the pixels the compositor drew: images from other origins, embedded
//! content, canvases and CSS effects appear as they do on screen. Redrawing the
//! document in the page — the only alternative here — cannot read any of those.

use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

/// A full-document capture of a long page is encoded in the browser process.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(30);

type Reply = Arc<Mutex<Option<mpsc::SyncSender<Result<String, String>>>>>;

fn reply(slot: &Reply, outcome: Result<String, String>) {
    if let Some(sender) = slot.lock().ok().and_then(|mut guard| guard.take()) {
        // A dropped receiver means the caller already timed out.
        let _ = sender.send(outcome);
    }
}

/// Capture `area` (`x`, `y`, `width`, `height` in CSS pixels from the document
/// origin) of a Tauri `WebviewWindow` as a base64 PNG, blocking the calling
/// (non-UI) thread.
pub(crate) fn capture<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, area: [f64; 4]) -> Result<String, String>
where
    R::Handle: tauri_runtime_wry::AsWryHandle,
{
    use tauri_runtime_wry::WebviewWryExt;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
    use windows::core::{HSTRING, PCWSTR, w};

    let [x, y, width, height] = area;
    let params = HSTRING::from(
        serde_json::json!({
            "format": "png", "captureBeyondViewport": true,
            "clip": {"x": x, "y": y, "width": width, "height": height, "scale": 1},
        })
        .to_string(),
    );
    let (sender, receiver) = mpsc::sync_channel(1);
    let slot: Reply = Arc::new(Mutex::new(Some(sender)));
    let failed = Arc::clone(&slot);
    window
        .with_wry_webview(move |webview| {
            let started = (|| -> windows::core::Result<()> {
                // SAFETY: Wry runs this closure on the UI thread that owns the controller.
                let core: ICoreWebView2 = unsafe { webview.controller().CoreWebView2()? };
                let done = Arc::clone(&slot);
                let on_captured = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                    let outcome =
                        result.map_err(|err| format!("Page.captureScreenshot failed: {err}")).and_then(|()| {
                            serde_json::from_str::<serde_json::Value>(&json)
                                .ok()
                                .and_then(|value| {
                                    value.get("data").and_then(serde_json::Value::as_str).map(str::to_owned)
                                })
                                .ok_or_else(|| "Page.captureScreenshot returned no image data".to_owned())
                        });
                    reply(&done, outcome);
                    Ok(())
                }));
                // SAFETY: documented CDP method on the live ICoreWebView2, UI thread;
                // `params` outlives the call, which copies the string.
                unsafe {
                    core.CallDevToolsProtocolMethod(
                        w!("Page.captureScreenshot"),
                        PCWSTR(params.as_ptr()),
                        &on_captured,
                    )?;
                };
                Ok(())
            })();
            if let Err(err) = started {
                reply(&failed, Err(format!("page capture could not start: {err}")));
            }
        })
        .map_err(|err| format!("webview handle unavailable: {err}"))?;
    receiver.recv_timeout(CAPTURE_TIMEOUT).map_err(|err| format!("page capture did not complete: {err}"))?
}
