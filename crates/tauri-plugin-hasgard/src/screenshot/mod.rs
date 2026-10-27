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
    if let Ok(mut slot) = SNAPSHOT_FN.write() {
        *slot = Some(capture);
    }
}

/// The installed webview capture, if the plugin has registered one.
#[cfg(target_os = "macos")]
pub(crate) fn snapshot_fn() -> Option<SnapshotFn> {
    SNAPSHOT_FN.read().ok()?.clone()
}
