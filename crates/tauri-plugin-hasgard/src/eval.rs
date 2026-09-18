use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::oneshot;

/// Error types for eval operations.
#[derive(Debug, thiserror::Error)]
pub(crate) enum EvalError {
    #[error("eval timed out after {0:?}")]
    Timeout(Duration),
    #[error("JavaScript error: {0}")]
    JsError(String),
    #[error("eval channel closed unexpectedly")]
    ChannelClosed,
}

struct Pending {
    sender: oneshot::Sender<Result<serde_json::Value, String>>,
    source: Option<(String, String)>,
}
type PendingMap = HashMap<u64, Pending>;

pub(crate) fn origin(url: &tauri::Url) -> Result<String, String> {
    let host = url.host_str().ok_or_else(|| "Opaque origins are not supported for automation".to_owned())?;
    let port = url.port().map_or_else(String::new, |port| format!(":{port}"));
    Ok(format!("{}://{host}{port}", url.scheme()))
}

struct PendingGuard<'a> {
    pending: &'a Mutex<PendingMap>,
    id: u64,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.pending.lock().expect("pending lock poisoned").remove(&self.id);
    }
}

/// Engine for executing JS in a `WebView` and resolving eval results delivered via the `__callback` IPC command.
///
/// The core ADR-001 pattern: wrap script in try/catch + return a callback payload,
/// await the result on a oneshot channel with timeout.
#[derive(Clone)]
pub(crate) struct EvalEngine {
    pending: Arc<Mutex<PendingMap>>,
    #[cfg(target_os = "macos")]
    pub(crate) videos: Arc<crate::video::Videos>,
    next_id: Arc<AtomicU64>,
    allowed: Arc<Mutex<HashMap<String, std::collections::HashSet<String>>>>,
    last_snapshot: Arc<Mutex<HashMap<String, serde_json::Value>>>,
}

impl EvalEngine {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(target_os = "macos")]
            videos: Arc::default(),
            next_id: Arc::new(AtomicU64::new(1)),
            allowed: Arc::new(Mutex::new(HashMap::new())),
            last_snapshot: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Keep each window's baseline separate. An omitted label denotes main,
    /// exactly as it does in the host's eval routing.
    pub fn store_snapshot(&self, window: Option<&str>, value: &serde_json::Value) {
        self.last_snapshot
            .lock()
            .expect("last_snapshot lock poisoned")
            .insert(window.unwrap_or("main").to_owned(), value.clone());
    }

    /// Retrieve the last stored snapshot, if any.
    pub fn get_last_snapshot(&self, window: Option<&str>) -> Option<serde_json::Value> {
        self.last_snapshot.lock().expect("last_snapshot lock poisoned").get(window.unwrap_or("main")).cloned()
    }

    /// Register a pending eval request. Returns the ID and a receiver.
    pub fn register(&self) -> (u64, oneshot::Receiver<Result<serde_json::Value, String>>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().expect("pending lock poisoned").insert(id, Pending { sender: tx, source: None });
        (id, rx)
    }

    /// Resolve a pending eval by ID from a `__callback` IPC payload.
    pub fn resolve(&self, id: u64, result: Result<serde_json::Value, String>) {
        let sender = self.pending.lock().expect("pending lock poisoned").remove(&id);

        match sender {
            Some(tx) => {
                let _ = tx.sender.send(result);
            }
            None => {
                tracing::warn!(id, "resolve called for unknown eval ID");
            }
        }
    }

    /// Only ACL-authorized IPC callbacks may establish an automation origin.
    pub fn authorize(&self, window: &str, url: &tauri::Url) -> Result<(), String> {
        self.allowed.lock().expect("allowed lock poisoned").entry(window.to_owned()).or_default().insert(origin(url)?);
        Ok(())
    }

    pub fn check_origin(&self, window: &str, url: &tauri::Url) -> Result<String, String> {
        let source = origin(url)?;
        if !self
            .allowed
            .lock()
            .expect("allowed lock poisoned")
            .get(window)
            .is_some_and(|origins| origins.contains(&source))
        {
            return Err(format!(
                "Automation origin {source} has not completed an ACL-authorized handshake for window '{window}'"
            ));
        }
        Ok(source)
    }

    pub fn bind_source(&self, id: u64, window: &str, source: &str) -> Result<(), String> {
        let mut pending = self.pending.lock().expect("pending lock poisoned");
        let request = pending.get_mut(&id).ok_or_else(|| "Eval request already expired".to_owned())?;
        request.source = Some((window.to_owned(), source.to_owned()));
        Ok(())
    }

    pub fn resolve_from(&self, id: u64, window: &str, url: &tauri::Url, result: Result<serde_json::Value, String>) {
        let mut pending = self.pending.lock().expect("pending lock poisoned");
        let Some(request) = pending.get(&id) else { return };
        let Some((expected_window, expected_origin)) = &request.source else { return };
        // Another window cannot consume or forge the pending result.
        if expected_window != window {
            return;
        }
        let result = match origin(url) {
            Ok(actual) if &actual == expected_origin => result,
            _ => Err("Window origin changed while automation was pending".to_owned()),
        };
        if let Some(request) = pending.remove(&id) {
            let _ = request.sender.send(result);
        }
    }

    /// Wrap a user script in the ADR-001 callback pattern.
    ///
    /// `WebView` eval result callbacks are not reliable across platforms and CI
    /// modes, so the script `await`s the result and delivers it back through the
    /// `__callback` IPC command, which dispatches fine from eval-injected code.
    ///
    /// Normalizes `undefined` results to `null` (string `"null"`) so Tauri does
    /// not drop the `result` field — otherwise a void expression (e.g.,
    /// `element.click()`) would cause the handler to log a bogus "neither
    /// result nor error" warning (#48).
    #[must_use]
    pub fn wrap_script(id: u64, script: &str) -> String {
        format!(
            "(async()=>{{try{{let __r=await({script});\
             await window.__TAURI_INTERNALS__.invoke('plugin:hasgard|__callback',\
             {{id:{id},result:__r===undefined?'null':JSON.stringify(__r)}});\
             }}catch(__e){{await window.__TAURI_INTERNALS__.invoke('plugin:hasgard|__callback',\
             {{id:{id},error:(__e&&__e.message)||String(__e)}});}}}})();"
        )
    }

    /// Wait for a pending eval result with timeout.
    /// Cleans up on every exit, including cancellation of the waiting task.
    pub async fn wait(
        &self, id: u64, rx: oneshot::Receiver<Result<serde_json::Value, String>>, timeout: Duration,
    ) -> Result<serde_json::Value, EvalError> {
        let _pending = PendingGuard { pending: &self.pending, id };
        let result = tokio::time::timeout(timeout, rx).await;

        match result {
            Ok(Ok(inner)) => inner.map_err(EvalError::JsError),
            Ok(Err(_)) => Err(EvalError::ChannelClosed),
            Err(_) => Err(EvalError::Timeout(timeout)),
        }
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn callbacks_are_bound_to_window_and_origin() {
        let engine = super::EvalEngine::new();
        let a = tauri::Url::parse("http://localhost:3000/a").expect("url");
        let same = tauri::Url::parse("http://localhost:3000/b").expect("url");
        let other = tauri::Url::parse("http://localhost:3001/a").expect("url");
        assert!(engine.check_origin("main", &a).is_err());
        engine.authorize("main", &a).expect("hello");
        assert!(engine.check_origin("settings", &a).is_err());
        assert!(engine.check_origin("main", &other).is_err());
        let (id, mut rx) = engine.register();
        engine.bind_source(id, "main", &super::origin(&a).expect("origin")).expect("bind");
        engine.resolve_from(id, "settings", &a, Ok(serde_json::json!("forged")));
        assert!(matches!(rx.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty)));
        engine.resolve_from(id, "main", &same, Ok(serde_json::json!("correct")));
        assert_eq!(rx.await.expect("callback").expect("result"), "correct");
        let (id, rx) = engine.register();
        engine.bind_source(id, "main", &super::origin(&a).expect("origin")).expect("bind");
        engine.resolve_from(id, "main", &other, Ok(serde_json::json!("late")));
        assert!(rx.await.expect("callback").is_err());
        assert!(super::origin(&tauri::Url::parse("data:text/plain,hi").expect("url")).is_err());
    }

    use super::*;
    use serde_json::json;

    #[test]
    fn test_new_starts_at_id_1() {
        let engine = EvalEngine::new();
        let (id, _rx) = engine.register();
        assert_eq!(id, 1);
    }

    #[test]
    fn test_ids_increment() {
        let engine = EvalEngine::new();
        let (id1, _) = engine.register();
        let (id2, _) = engine.register();
        assert_eq!(id2, id1 + 1);
    }

    #[tokio::test]
    async fn test_resolve_success() {
        let engine = EvalEngine::new();
        let (id, rx) = engine.register();
        engine.resolve(id, Ok(json!(42)));
        let result = rx.await.expect("resolve channel dropped");
        assert_eq!(result, Ok(json!(42)));
    }

    #[tokio::test]
    async fn test_resolve_js_error() {
        let engine = EvalEngine::new();
        let (id, rx) = engine.register();
        engine.resolve(id, Err("ReferenceError: x is not defined".to_owned()));
        let result = rx.await.expect("resolve channel dropped");
        assert!(result.is_err());
    }

    #[test]
    fn test_resolve_unknown_id_no_panic() {
        let engine = EvalEngine::new();
        engine.resolve(999, Ok(json!(null)));
    }

    #[tokio::test]
    async fn test_wait_timeout_cleans_pending() {
        tokio::time::pause();
        let engine = EvalEngine::new();
        let (id, rx) = engine.register();
        let result = engine.wait(id, rx, Duration::from_secs(1)).await;
        assert!(matches!(result, Err(EvalError::Timeout(_))));
        // Verify pending entry was cleaned up
        assert!(!engine.pending.lock().expect("lock").contains_key(&id));
    }

    #[tokio::test]
    async fn cancelled_wait_removes_its_pending_sender() {
        let engine = EvalEngine::new();
        let (id, rx) = engine.register();
        let mut waiting = Box::pin(engine.wait(id, rx, Duration::from_secs(30)));
        let waker = std::task::Waker::noop();
        let mut context = std::task::Context::from_waker(waker);
        assert!(matches!(std::future::Future::poll(waiting.as_mut(), &mut context), std::task::Poll::Pending));
        drop(waiting);
        assert!(!engine.pending.lock().expect("lock").contains_key(&id));
    }

    #[tokio::test]
    async fn test_wait_success() {
        let engine = EvalEngine::new();
        let (id, rx) = engine.register();
        engine.resolve(id, Ok(json!({"title": "hello"})));
        let result = engine.wait(id, rx, Duration::from_secs(10)).await;
        assert_eq!(result.expect("wait succeeds"), json!({"title": "hello"}));
    }

    #[tokio::test]
    async fn test_wait_js_error() {
        let engine = EvalEngine::new();
        let (id, rx) = engine.register();
        engine.resolve(id, Err("boom".to_owned()));
        let result = engine.wait(id, rx, Duration::from_secs(10)).await;
        assert!(matches!(result, Err(EvalError::JsError(ref m)) if m == "boom"));
    }

    #[test]
    fn test_wrap_script_contains_id_and_code() {
        let script = EvalEngine::wrap_script(42, "document.title");
        assert!(script.contains("42"));
        assert!(script.contains("document.title"));
        assert!(script.contains("await("));
        assert!(script.contains("try"));
        assert!(script.contains("catch"));
    }

    // #110/#126: The wrapped script must await the JavaScript result and send it
    // through `__callback`, avoiding native eval result callbacks entirely.
    #[test]
    fn test_wrap_script_uses_ipc_callback_delivery() {
        let script = EvalEngine::wrap_script(7, "document.title");
        assert!(
            script.contains("__TAURI_INTERNALS__.invoke('plugin:hasgard|__callback'"),
            "wrapped script must send eval results through __callback IPC; got: {script}"
        );
        assert!(script.contains("{id:7,result:"));
        assert!(script.contains("{id:7,error:"));
        assert!(
            !script.contains("return {id:7,result:"),
            "wrapped script must not return a native eval completion payload; got: {script}"
        );
    }

    #[test]
    fn test_wrap_script_normalizes_undefined_to_null() {
        // #48: A JS expression returning undefined must not cause the handler
        // to log "callback received with neither result nor error". The wrapper
        // converts undefined → the string "null" so Tauri keeps the `result`
        // field populated.
        let script = EvalEngine::wrap_script(1, "element.click()");
        assert!(
            script.contains("__r===undefined?'null':JSON.stringify(__r)"),
            "wrapped script must normalize undefined to the string 'null'; got: {script}"
        );
    }

    #[test]
    fn test_get_last_snapshot_none_initially() {
        let engine = EvalEngine::new();
        assert!(engine.get_last_snapshot(None).is_none());
    }

    #[test]
    fn test_store_and_retrieve_snapshot() {
        let engine = EvalEngine::new();
        let value = json!({"elements": [{"ref": "e1", "role": "button", "depth": 1}]});
        engine.store_snapshot(None, &value);
        let retrieved = engine.get_last_snapshot(Some("main"));
        assert_eq!(retrieved, Some(value));
        assert!(engine.get_last_snapshot(Some("settings")).is_none());
        engine.store_snapshot(Some("settings"), &json!({"elements": []}));
        assert_ne!(engine.get_last_snapshot(None), engine.get_last_snapshot(Some("settings")));
    }
}
