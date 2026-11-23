#[cfg(target_os = "macos")]
pub(crate) mod cgwindow;
#[cfg(target_os = "macos")]
pub(crate) mod error;
pub(crate) mod ipc;
#[cfg(target_os = "macos")]
pub(crate) mod native;
#[cfg(target_os = "macos")]
pub(crate) mod probe;
#[cfg(target_os = "macos")]
pub(crate) mod screencapture;
#[cfg(windows)]
pub(crate) mod webview2;
#[cfg(target_os = "macos")]
pub(crate) mod window_id;

#[cfg(target_os = "macos")]
pub(crate) use cgwindow::capture_cgwindow;
#[cfg(target_os = "macos")]
pub(crate) use error::ScreenshotError;
pub(crate) use ipc::handle_screenshot;
#[cfg(target_os = "macos")]
pub(crate) use native::{WebviewSnapshot, capture_wkwebview_png};
#[cfg(target_os = "macos")]
pub(crate) use probe::{ScreenshotBackend, selected_backend};
#[cfg(target_os = "macos")]
pub(crate) use screencapture::capture_screencapture;
#[cfg(target_os = "macos")]
pub(crate) use window_id::{DiscoveredWindow, EnumeratedLayerZeroWindows, WindowBounds, enumerate_layer_zero_windows};

/// Captures the webview of the given window label (`None` means the default
/// window) through the Tauri runtime. Installed by the plugin at setup, since
/// the IPC handler itself has no access to the app handle.
#[cfg(target_os = "macos")]
pub(crate) type SnapshotFn = std::sync::Arc<dyn Fn(Option<&str>) -> Result<WebviewSnapshot, String> + Send + Sync>;

#[cfg(target_os = "macos")]
static SNAPSHOT_FN: std::sync::RwLock<Option<SnapshotFn>> = std::sync::RwLock::new(None);

/// Install the runtime-backed webview capture for this process.
#[cfg(target_os = "macos")]
pub(crate) fn register_snapshot_fn(capture: SnapshotFn) {
    *SNAPSHOT_FN.write().expect("snapshot capture lock") = Some(capture);
}

/// The installed webview capture, if the plugin has registered one.
#[cfg(target_os = "macos")]
pub(crate) fn snapshot_fn() -> Option<SnapshotFn> {
    SNAPSHOT_FN.read().expect("snapshot capture lock").clone()
}

/// Takes the pixels of an area of a webview's document (`x`, `y`, `width`,
/// `height` in CSS pixels from the document's origin) as they are composited,
/// and returns the PNG in base64. Installed by a runtime that can; without one
/// the `screenshot` method redraws the document in the page.
pub(crate) type PageCaptureFn = std::sync::Arc<dyn Fn(Option<&str>, [f64; 4]) -> Result<String, String> + Send + Sync>;

static PAGE_CAPTURE_FN: std::sync::RwLock<Option<PageCaptureFn>> = std::sync::RwLock::new(None);

/// Install the composited page capture for this process.
#[cfg(any(feature = "cef", windows))]
pub(crate) fn register_page_capture_fn(capture: PageCaptureFn) {
    *PAGE_CAPTURE_FN.write().expect("page capture lock") = Some(capture);
}

/// The installed composited page capture, if a runtime has registered one.
pub(crate) fn page_capture_fn() -> Option<PageCaptureFn> {
    PAGE_CAPTURE_FN.read().expect("page capture lock").clone()
}
