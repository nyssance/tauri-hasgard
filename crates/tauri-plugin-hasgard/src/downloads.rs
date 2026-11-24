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

use crate::params::optional_u64;
use crate::protocol::{RPC_INTERNAL_ERROR, RPC_INVALID_PARAMS, RPC_METHOD_NOT_FOUND, RpcError};

pub(crate) const METHODS: &[&str] = &["downloads.list", "downloads.wait", "downloads.setDirectory", "downloads.clear"];

const MAX_DOWNLOADS: usize = 200;
/// A wait holds a worker thread, so it is bounded.
const MAX_WAIT_MS: u64 = 600_000;
const WAIT_POLL: Duration = Duration::from_millis(25);

struct Download {
    id: u64,
    timestamp: u64,
    window: String,
    url: String,
    path: Option<PathBuf>,
    /// `None` while the download is in flight.
    succeeded: Option<bool>,
    /// Its place among the downloads that have ended; 0 while in flight.
    ended: u64,
}

#[derive(Default)]
struct Log {
    downloads: VecDeque<Download>,
    sequence: u64,
    ended: u64,
    /// Where requested downloads are redirected, when a test asked for that.
    directory: Option<PathBuf>,
}

impl Log {
    fn begin(&mut self, window: String, url: String, path: PathBuf) {
        self.sequence += 1;
        self.downloads.push_back(Download {
            id: self.sequence,
            timestamp: now_ms(),
            window,
            url,
            path: Some(path),
            succeeded: None,
            ended: 0,
        });
        if self.downloads.len() > MAX_DOWNLOADS {
            self.downloads.pop_front();
        }
    }

    fn finish(&mut self, window: &str, url: &str, path: Option<PathBuf>, success: bool) {
        let in_flight = |d: &Download| d.succeeded.is_none() && d.window == window && d.url == url;
        // Two downloads of one address end in either order, and the path says which this is.
        // Where the platform reports no path, the oldest still in flight is taken.
        let position = path
            .as_ref()
            .and_then(|path| self.downloads.iter().position(|d| in_flight(d) && d.path.as_ref() == Some(path)))
            .or_else(|| self.downloads.iter().position(in_flight));
        let Some(position) = position else { return };
        self.ended += 1;
        let download = &mut self.downloads[position];
        download.ended = self.ended;
        download.succeeded = Some(success);
        // Some platforms report no path at the end; the destination asked for stands then.
        if path.is_some() {
            download.path = path;
        }
    }

    /// The first download to have ended that a wait should answer with: one that ended after
    /// the wait began (`after`), or with `since` one that started after that id. A wait keeps no
    /// state here, so one that is abandoned takes nothing from the wait that follows it.
    fn first_ended(&self, window: Option<&str>, after: u64, since: Option<u64>) -> Option<Value> {
        self.downloads
            .iter()
            .filter(|d| d.succeeded.is_some() && window.is_none_or(|window| d.window == window))
            .filter(|d| since.map_or(d.ended > after, |since| d.id > since))
            .min_by_key(|d| d.ended)
            .map(describe)
    }

    /// Forget what has ended. One still in flight is kept: its end is yet to be seen.
    fn clear(&mut self, window: Option<&str>) {
        self.downloads.retain(|d| d.succeeded.is_none() || window.is_some_and(|window| d.window != window));
    }
}

static OBSERVED: AtomicBool = AtomicBool::new(false);
static LOG: Mutex<Log> = Mutex::new(Log { downloads: VecDeque::new(), sequence: 0, ended: 0, directory: None });

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
                log.begin(window, url.to_string(), destination.clone());
                true
            }
            DownloadEvent::Finished { url, path, success } => {
                let allowed =
                    handler(webview, DownloadEvent::Finished { url: url.clone(), path: path.clone(), success });
                log().finish(&window, url.as_str(), path, success);
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
                log().clear(label);
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
                let since = optional_u64(params, "sinceId", method)?;
                let timeout = optional_u64(params, "timeout", method)?.unwrap_or(10_000);
                if timeout > MAX_WAIT_MS {
                    return Err(invalid(format!(
                        "downloads.wait: 'timeout' must be at most {MAX_WAIT_MS} milliseconds"
                    )));
                }
                let deadline = Instant::now() + Duration::from_millis(timeout);
                let began = log().ended;
                loop {
                    if let Some(download) = log().first_ended(label, began, since) {
                        return Ok(download);
                    }
                    if Instant::now() >= deadline {
                        let in_flight = log().downloads.iter().filter(seen).filter(|d| d.succeeded.is_none()).count();
                        return Err(RpcError {
                            code: RPC_INTERNAL_ERROR,
                            message: format!(
                                "No download finished within {timeout} ms ({in_flight} started and still in flight)"
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

#[cfg(test)]
mod tests {
    use super::*;

    fn started(log: &mut Log, window: &str, url: &str, file: &str) {
        log.begin(window.to_owned(), url.to_owned(), PathBuf::from(file));
    }

    #[test]
    fn a_finish_is_matched_by_path_when_two_downloads_share_an_address() {
        let mut log = Log::default();
        started(&mut log, "main", "https://x/report", "/d/report.csv");
        started(&mut log, "main", "https://x/report", "/d/report (1).csv");
        log.finish("main", "https://x/report", Some(PathBuf::from("/d/report (1).csv")), true);
        let ended = log.first_ended(None, 0, None).expect("the second ended");
        assert_eq!(ended["id"], 2);
        assert_eq!(ended["path"], "/d/report (1).csv");
        assert!(log.first_ended(None, 1, None).is_none(), "the first is still in flight");
        // No path at the end: the oldest in flight is the one.
        log.finish("main", "https://x/report", None, false);
        let first = log.first_ended(None, 1, None).expect("the first ended");
        assert_eq!((first["id"].as_u64(), first["state"].as_str()), (Some(1), Some("failed")));
    }

    #[test]
    fn a_wait_answers_with_what_ended_after_it_began_and_takes_nothing() {
        let mut log = Log::default();
        started(&mut log, "main", "https://x/a", "/d/a");
        started(&mut log, "side", "https://x/b", "/d/b");
        log.finish("side", "https://x/b", None, true);
        // A wait that began before anything ended sees the first to end, whichever started first.
        assert_eq!(log.first_ended(None, 0, None).expect("b ended first")["id"], 2);
        // Asking again changes nothing: an abandoned wait cannot use up a download.
        assert_eq!(log.first_ended(None, 0, None).expect("still b")["id"], 2);
        // A wait that began after b ended is not satisfied by it.
        let began = log.ended;
        assert!(log.first_ended(None, began, None).is_none());
        log.finish("main", "https://x/a", None, true);
        assert_eq!(log.first_ended(None, began, None).expect("a ended after it began")["id"], 1);
        // A caller that keeps its own place goes by id instead.
        assert_eq!(log.first_ended(None, began, Some(1)).expect("after id 1")["id"], 2);
        assert!(log.first_ended(Some("main"), began, Some(1)).is_none(), "a window sees only its own");
    }

    #[test]
    fn clear_forgets_one_window_and_keeps_what_is_in_flight() {
        let mut log = Log::default();
        started(&mut log, "main", "https://x/a", "/d/a");
        started(&mut log, "side", "https://x/b", "/d/b");
        started(&mut log, "main", "https://x/c", "/d/c");
        log.finish("main", "https://x/a", None, true);
        log.finish("side", "https://x/b", None, true);
        log.clear(Some("main"));
        let left: Vec<u64> = log.downloads.iter().map(|d| d.id).collect();
        assert_eq!(left, [2, 3], "main's ended one is gone; side's and the one in flight stay");
        log.finish("main", "https://x/c", None, true);
        assert_eq!(log.first_ended(Some("main"), 2, None).expect("it ended after the clear")["id"], 3);
        log.clear(None);
        assert!(log.downloads.is_empty());
    }
}
