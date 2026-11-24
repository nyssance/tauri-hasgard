//! Downloads a webview starts, observed through the application's own download hook.
//!
//! A webview reports its downloads only to the handler given when it was built,
//! so the application passes [`observer`] (or wraps its own handler with
//! [`observe`]) to `on_download`. Without that, nothing here can see a download,
//! and the methods say so instead of waiting for one that will never appear.
//!
//! ```rust,ignore
//! tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
//!     .on_download(tauri_plugin_hasgard::downloads::observer())
//!     .build()?;
//! ```

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::webview::DownloadEvent;

use crate::protocol::{RPC_INTERNAL_ERROR, RPC_INVALID_PARAMS, RPC_METHOD_NOT_FOUND, RpcError, optional_u64};

pub(crate) const METHODS: &[&str] = &["downloads.list", "downloads.wait", "downloads.setDirectory", "downloads.clear"];

const MAX_DOWNLOADS: usize = 200;
const WAIT_POLL: Duration = Duration::from_millis(25);

struct Download {
    id: u64,
    timestamp: u64,
    window: String,
    url: String,
    path: Option<PathBuf>,
    /// `None` while the download is in flight.
    succeeded: Option<bool>,
}

#[derive(Default)]
struct Log {
    downloads: VecDeque<Download>,
    sequence: u64,
    /// Where requested downloads are redirected, when a test asked for that.
    directory: Option<PathBuf>,
}

static OBSERVED: AtomicBool = AtomicBool::new(false);
static LOG: Mutex<Log> = Mutex::new(Log { downloads: VecDeque::new(), sequence: 0, directory: None });

fn log() -> std::sync::MutexGuard<'static, Log> {
    LOG.lock().expect("download log")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

/// A download handler that lets every download proceed and reports it to Hasgard.
pub fn observer<R: tauri::Runtime>() -> impl Fn(tauri::Webview<R>, DownloadEvent<'_>) -> bool + Send + Sync + 'static {
    observe(|_, _| true)
}

/// Wrap the application's own download handler so Hasgard sees what it sees.
///
/// `handler` runs first and decides, as it would alone: the destination it sets
/// and the answer it returns stand. A download it refuses is not recorded.
pub fn observe<R: tauri::Runtime, F>(
    handler: F,
) -> impl Fn(tauri::Webview<R>, DownloadEvent<'_>) -> bool + Send + Sync + 'static
where
    F: Fn(tauri::Webview<R>, DownloadEvent<'_>) -> bool + Send + Sync + 'static,
{
    OBSERVED.store(true, Ordering::Relaxed);
    move |webview, event| {
        let window = webview.label().to_owned();
        match event {
            DownloadEvent::Requested { url, destination } => {
                if !handler(webview, DownloadEvent::Requested { url: url.clone(), destination: &mut *destination }) {
                    return false;
                }
                let mut log = log();
                // A test that named a directory gets the file there, under the name it would have had.
                if let (Some(directory), Some(name)) = (log.directory.clone(), destination.file_name()) {
                    *destination = directory.join(name);
                }
                log.sequence += 1;
                let download = Download {
                    id: log.sequence,
                    timestamp: now_ms(),
                    window,
                    url: url.to_string(),
                    path: Some(destination.clone()),
                    succeeded: None,
                };
                log.downloads.push_back(download);
                if log.downloads.len() > MAX_DOWNLOADS {
                    log.downloads.pop_front();
                }
                true
            }
            DownloadEvent::Finished { url, path, success } => {
                let allowed =
                    handler(webview, DownloadEvent::Finished { url: url.clone(), path: path.clone(), success });
                let mut log = log();
                let address = url.to_string();
                // The oldest one still in flight for this address is the one that just ended.
                if let Some(download) = log.downloads.iter_mut().find(|download| {
                    download.succeeded.is_none() && download.window == window && download.url == address
                }) {
                    download.succeeded = Some(success);
                    // Some platforms report no path at the end; the destination asked for stands then.
                    if path.is_some() {
                        download.path = path;
                    }
                }
                allowed
            }
            _ => handler(webview, event),
        }
    }
}

fn describe(download: &Download) -> Value {
    json!({
        "id": download.id,
        "timestamp": download.timestamp,
        "window": download.window,
        "url": download.url,
        "path": download.path,
        "state": match download.succeeded {
            None => "started",
            Some(true) => "finished",
            Some(false) => "failed",
        },
    })
}

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError { code: RPC_INVALID_PARAMS, message: message.into(), data: None }
}

pub(crate) fn make_download_fn() -> crate::eval::NativeFn {
    std::sync::Arc::new(|label, method, params| {
        if !OBSERVED.load(Ordering::Relaxed) {
            return Err(RpcError {
                code: RPC_METHOD_NOT_FOUND,
                message: format!(
                    "{method} is not available: the application does not report downloads. \
                     Pass tauri_plugin_hasgard::downloads::observer() to on_download when building the webview"
                ),
                data: None,
            });
        }
        // A window narrows the view to its own downloads; without one every window's are seen.
        let seen = |download: &&Download| label.is_none_or(|label| download.window == label);
        match method {
            "downloads.list" => Ok(json!({
                "downloads": log().downloads.iter().filter(seen).map(describe).collect::<Vec<_>>(),
                "directory": log().directory,
            })),
            "downloads.clear" => {
                log().downloads.clear();
                Ok(json!({"cleared": true}))
            }
            "downloads.setDirectory" => {
                let directory = match params.get("path") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(path)) => {
                        let path = PathBuf::from(path);
                        if !path.is_absolute() {
                            return Err(invalid(format!(
                                "downloads.setDirectory: path must be absolute: {}",
                                path.display()
                            )));
                        }
                        if !path.is_dir() {
                            return Err(invalid(format!(
                                "downloads.setDirectory: not a directory: {}",
                                path.display()
                            )));
                        }
                        Some(path)
                    }
                    Some(_) => return Err(invalid("downloads.setDirectory: 'path' must be a string or null")),
                };
                log().directory.clone_from(&directory);
                Ok(json!({"directory": directory}))
            }
            "downloads.wait" => {
                let since = optional_u64(params, "sinceId", method)?.unwrap_or(0);
                let timeout = Duration::from_millis(optional_u64(params, "timeout", method)?.unwrap_or(10_000));
                let deadline = Instant::now() + timeout;
                loop {
                    {
                        let log = log();
                        let ended = log
                            .downloads
                            .iter()
                            .filter(seen)
                            .find(|download| download.id > since && download.succeeded.is_some());
                        if let Some(download) = ended {
                            return Ok(describe(download));
                        }
                    }
                    if Instant::now() >= deadline {
                        let in_flight = log().downloads.iter().filter(seen).filter(|d| d.id > since).count();
                        return Err(RpcError {
                            code: RPC_INTERNAL_ERROR,
                            message: format!(
                                "No download finished within {} ms ({in_flight} started and still in flight)",
                                timeout.as_millis()
                            ),
                            data: None,
                        });
                    }
                    std::thread::sleep(WAIT_POLL);
                }
            }
            other => Err(RpcError {
                code: RPC_METHOD_NOT_FOUND,
                message: format!("Unknown download method: {other}"),
                data: None,
            }),
        }
    })
}
