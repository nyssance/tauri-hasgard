//! `WKWebView` `takeSnapshot:` backend.
//!
//! Asks `WebKit` for the pixels it rendered for the target webview, so the
//! capture reflects exactly what the user sees — including content inside
//! scrolled containers and virtualized lists — and needs no screen-recording
//! permission, unlike the window-level `screencapture`/`CGWindowList` paths.
//! The result covers the webview's viewport only; window chrome is not part
//! of it.

use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use super::ScreenshotError;

/// A finished webview snapshot: the encoded PNG plus the metadata the
/// `screenshot_native` response reports alongside it.
pub(crate) struct WebviewSnapshot {
    pub(crate) png: Vec<u8>,
    /// `NSWindow` number of the hosting window, when it could be read.
    pub(crate) window_id: Option<u32>,
    /// Backing scale of the hosting window, so callers can relate pixels to points.
    pub(crate) scale_factor: f64,
}

/// `WebKit` renders the snapshot on its own schedule; a wedged `WebContent`
/// process must surface as an error instead of hanging the RPC forever.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);

/// Capture a Tauri `WebviewWindow` through `WKWebView` `takeSnapshotWithConfiguration:`.
///
/// Runs the request on the main thread through the Wry handle and blocks the
/// calling (non-main) thread until `WebKit`'s completion handler delivers the
/// image, or [`SNAPSHOT_TIMEOUT`] elapses.
///
/// # Errors
///
/// Returns [`ScreenshotError::CaptureFailed`] when the webview handle cannot
/// be reached, `WebKit` reports an error or no image, the image cannot be
/// encoded as PNG, or the completion handler never fires.
pub(crate) fn capture_wkwebview_png<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<WebviewSnapshot, ScreenshotError>
where
    R::Handle: tauri_runtime_wry::AsWryHandle,
{
    use block2::RcBlock;
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSImage, NSWindow};
    use objc2_foundation::NSError;
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    use tauri_runtime_wry::WebviewWryExt;

    type Outcome = Result<(Vec<u8>, Option<u32>, f64), String>;

    let (sender, receiver) = mpsc::sync_channel::<Outcome>(1);
    // The completion block is `Fn`, so the single-use sender lives behind a
    // mutex it can take exactly once.
    let slot = Arc::new(Mutex::new(Some(sender)));
    window
        .with_wry_webview(move |webview| {
            // SAFETY: Wry runs this closure on the main thread and hands over
            // the `NSWindow *` and `WKWebView *` it owns for this live webview;
            // both are only borrowed for the duration of the closure.
            let (window_id, scale_factor) = unsafe { webview.ns_window().cast::<NSWindow>().as_ref() }
                .map_or((None, 1.0), |ns_window| {
                    (u32::try_from(ns_window.windowNumber()).ok(), ns_window.backingScaleFactor())
                });
            let Some(wk_webview) = (unsafe { webview.inner().cast::<WKWebView>().as_ref() }) else {
                if let Some(sender) = slot.lock().ok().and_then(|mut guard| guard.take()) {
                    let _ = sender.send(Err("webview has no WKWebView".to_owned()));
                }
                return;
            };
            let Some(mtm) = MainThreadMarker::new() else {
                if let Some(sender) = slot.lock().ok().and_then(|mut guard| guard.take()) {
                    let _ = sender.send(Err("snapshot closure did not run on the main thread".to_owned()));
                }
                return;
            };
            // SAFETY: a fresh configuration object; the default captures the
            // whole visible viewport after pending screen updates.
            let configuration = unsafe { WKSnapshotConfiguration::init(WKSnapshotConfiguration::alloc(mtm)) };
            let completion = Arc::clone(&slot);
            let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let outcome = encode_png(image, error).map(|png| (png, window_id, scale_factor));
                if let Some(sender) = completion.lock().ok().and_then(|mut guard| guard.take()) {
                    // A dropped receiver means the caller already timed out.
                    let _ = sender.send(outcome);
                }
            });
            // SAFETY: called on the main thread with a live WKWebView; WebKit
            // retains the block until the completion handler has run.
            unsafe { wk_webview.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &block) };
        })
        .map_err(|err| ScreenshotError::CaptureFailed { message: format!("webview handle unavailable: {err}") })?;

    match receiver.recv_timeout(SNAPSHOT_TIMEOUT) {
        Ok(Ok((png, window_id, scale_factor))) => Ok(WebviewSnapshot { png, window_id, scale_factor }),
        Ok(Err(message)) => Err(ScreenshotError::CaptureFailed { message }),
        Err(err) => {
            Err(ScreenshotError::CaptureFailed { message: format!("WKWebView snapshot did not complete: {err}") })
        }
    }
}

/// Encode the `NSImage` `WebKit` handed back as PNG bytes, or surface its error.
fn encode_png(image: *mut objc2_app_kit::NSImage, error: *mut objc2_foundation::NSError) -> Result<Vec<u8>, String> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::NSDictionary;

    // SAFETY: WebKit passes either a live image or a live error for the
    // duration of the completion call; both are only borrowed here.
    let image = unsafe { image.as_ref() }.ok_or_else(|| {
        unsafe { error.as_ref() }
            .map_or_else(|| "WKWebView returned no image".to_owned(), |error| error.localizedDescription().to_string())
    })?;
    let tiff = image.TIFFRepresentation().ok_or("snapshot has no TIFF representation")?;
    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("snapshot bitmap could not be decoded")?;
    // SAFETY: PNG with default properties; the dictionary is empty and typed.
    let png = unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }
        .ok_or("snapshot could not be encoded as PNG")?;
    Ok(png.to_vec())
}
