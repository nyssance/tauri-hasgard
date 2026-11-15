//! CEF transport. The socket protocol is shared with Wry; page results travel
//! over in-process CDP, never through a remote page's Tauri IPC permissions.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use serde_json::{Value, json};
use tauri::{DynRuntime, Manager};
use tauri_runtime_cef::{DevToolsProtocol, WebviewCefExt, allocate_devtools_message_id};

use crate::eval::EvalEngine;
use crate::server::{EvalFn, EvalScript, EvalWorld, PressHooks, PressHooksRef};

type View = tauri::Webview<DynRuntime>;
type Reply = mpsc::SyncSender<Result<Value, String>>;
const TIMEOUT: Duration = Duration::from_secs(10);
const WORLD: &str = "tauri-hasgard";

#[derive(Clone)]
struct ExecutionContext {
    unique_id: String,
    frame_id: Option<String>,
    is_default: bool,
}

#[derive(Default)]
struct Client {
    pending: Mutex<HashMap<i32, Reply>>,
    contexts: Mutex<HashMap<i64, ExecutionContext>>,
}

impl Client {
    fn receive(&self, message: DevToolsProtocol) {
        match message {
            DevToolsProtocol::MethodResult { message_id, success, result } => {
                if let Some(reply) = self.pending.lock().expect("CDP pending lock").remove(&message_id) {
                    let result = serde_json::from_slice::<Value>(&result)
                        .map_err(|e| e.to_string())
                        .and_then(|value| if success { Ok(value) } else { Err(format!("CDP error: {value}")) });
                    let _ = reply.send(result);
                }
            }
            DevToolsProtocol::Event { method, params } => {
                if method == "Runtime.executionContextCreated" {
                    if let Ok(value) = serde_json::from_slice::<Value>(&params)
                        && let (Some(id), Some(unique)) =
                            (value["context"]["id"].as_i64(), value["context"]["uniqueId"].as_str())
                    {
                        self.contexts.lock().expect("CDP contexts lock").insert(
                            id,
                            ExecutionContext {
                                unique_id: unique.to_owned(),
                                frame_id: value["context"]["auxData"]["frameId"].as_str().map(str::to_owned),
                                is_default: value["context"]["auxData"]["isDefault"] == true,
                            },
                        );
                    }
                } else if method == "Runtime.executionContextDestroyed" {
                    if let Ok(value) = serde_json::from_slice::<Value>(&params)
                        && let Some(id) = value["executionContextId"].as_i64()
                    {
                        self.contexts.lock().expect("CDP contexts lock").remove(&id);
                    }
                } else if method == "Runtime.executionContextsCleared" || method == "Inspector.detached" {
                    self.contexts.lock().expect("CDP contexts lock").clear();
                    self.cancel("CEF document navigated or debugger detached");
                }
            }
            DevToolsProtocol::Message(_) => (),
        }
    }

    fn cancel(&self, reason: &str) {
        for (_, reply) in self.pending.lock().expect("CDP pending lock").drain() {
            let _ = reply.send(Err(reason.to_owned()));
        }
    }

    fn call(&self, view: &View, method: &str, params: &Value) -> Result<Value, String> {
        self.call_with_timeout(view, method, params, TIMEOUT)
    }

    fn call_with_timeout(&self, view: &View, method: &str, params: &Value, timeout: Duration) -> Result<Value, String> {
        let id = allocate_devtools_message_id().map_err(|e| e.to_string())?;
        let (tx, rx) = mpsc::sync_channel(1);
        self.pending.lock().expect("CDP pending lock").insert(id, tx);
        let sent = view.send_dev_tools_message(
            &serde_json::to_vec(&json!({"id": id, "method": method, "params": params})).map_err(|e| e.to_string())?,
        );
        let result = match sent {
            Ok(()) => {
                rx.recv_timeout(timeout).map_err(|e| format!("CDP {method}: {e}")).and_then(std::convert::identity)
            }
            Err(error) => Err(error.to_string()),
        };
        self.pending.lock().expect("CDP pending lock").remove(&id);
        result
    }

    fn main_world(&self, frame: &str) -> Result<String, String> {
        let contexts = self.contexts.lock().expect("CDP contexts lock");
        let mut matching =
            contexts.values().filter(|context| context.is_default && context.frame_id.as_deref() == Some(frame));
        let context = matching.next().ok_or("AUTOMATION_NOT_READY: CEF main-world context is not available")?;
        if matching.next().is_some() {
            return Err("CEF main-world context is ambiguous".into());
        }
        Ok(context.unique_id.clone())
    }

    fn evaluate(
        &self, view: &View, script: &EvalScript, remaining: impl FnOnce() -> Result<Duration, String>,
    ) -> Result<Value, String> {
        let tree = self.call(view, "Page.getFrameTree", &json!({}))?;
        let frame = tree["frameTree"]["frame"]["id"].as_str().ok_or("CDP returned no main frame")?;
        let unique = match script.world {
            EvalWorld::Main => self.main_world(frame)?,
            EvalWorld::Automation => {
                let world =
                    self.call(view, "Page.createIsolatedWorld", &json!({"frameId": frame, "worldName": WORLD}))?;
                let context = world["executionContextId"].as_i64().ok_or("CDP returned no execution context")?;
                self.contexts
                    .lock()
                    .expect("CDP contexts lock")
                    .get(&context)
                    .map(|context| context.unique_id.clone())
                    .ok_or("AUTOMATION_NOT_READY: CEF execution context is not available")?
            }
        };
        // Bind to a unique context: navigation must fail, never execute in a
        // replacement renderer. Main-world IPC uses the page's real Tauri bridge
        // and its existing capability checks; no native command bypass exists.
        let prelude = match script.world {
            EvalWorld::Automation => crate::BRIDGE_JS,
            EvalWorld::Main => {
                "if(typeof window.__TAURI_INTERNALS__?.invoke!=='function')throw new Error('Tauri IPC is unavailable in this document');"
            }
        };
        let expression = format!(
            "(async()=>{{{prelude}\nconst value=await({});return value===undefined?null:value;}})()",
            script.code
        );
        let timeout = remaining()?;
        let result = self.call_with_timeout(
            view,
            "Runtime.evaluate",
            &json!({
                "expression": expression, "uniqueContextId": unique,
                "awaitPromise": true, "returnByValue": true, "userGesture": true,
            }),
            timeout,
        )?;
        evaluation_result(&result)
    }
}

fn evaluation_result(result: &Value) -> Result<Value, String> {
    if let Some(error) = result.get("exceptionDetails") {
        return Err(format!("CEF JavaScript exception: {error}"));
    }
    result["result"].get("value").cloned().ok_or_else(|| format!("CEF result is not serializable: {result}"))
}

#[derive(Default)]
struct Clients(Mutex<HashMap<String, (i32, Arc<Client>)>>);
impl Clients {
    fn get(&self, view: &View) -> Result<Arc<Client>, String> {
        let (tx, rx) = mpsc::sync_channel(1);
        view.with_cef_webview(move |native| {
            let _ = tx.send(native.snapshot().browser_id);
        })
        .map_err(|e| e.to_string())?;
        let browser_id = rx.recv_timeout(TIMEOUT).map_err(|e| e.to_string())?;
        let live = view.app_handle().webviews();
        let mut clients = self.0.lock().expect("CEF clients lock");
        clients.retain(|label, (_, client)| {
            if live.contains_key(label) {
                true
            } else {
                client.cancel("CEF browser closed");
                false
            }
        });
        if let Some((id, client)) = clients.get(view.label())
            && *id == browser_id
        {
            return Ok(client.clone());
        }
        if let Some((_, old)) = clients.remove(view.label()) {
            old.cancel("CEF browser replaced");
        }
        let client = Arc::new(Client::default());
        let weak = Arc::downgrade(&client);
        view.on_dev_tools_protocol(move |message| {
            if let Some(client) = weak.upgrade() {
                client.receive(message);
            }
        })
        .map_err(|e| e.to_string())?;
        client.call(view, "Runtime.enable", &json!({}))?;
        clients.insert(view.label().to_owned(), (browser_id, client.clone()));
        Ok(client)
    }
}

fn target(app: &tauri::AppHandle, label: Option<&str>) -> Result<View, String> {
    let label = label.unwrap_or("main");
    app.get_webview(label).ok_or_else(|| format!("Webview '{label}' not found"))
}

fn eval_hook(app: &tauri::AppHandle, engine: EvalEngine, clients: Arc<Clients>) -> EvalFn {
    let eval_app = app.clone();
    let eval_clients = clients;
    let eval: EvalFn = Arc::new(move |label, id, script| {
        let view = target(&eval_app, label)?;
        let engine = engine.clone();
        let url = view.url().map_err(|e| e.to_string())?;
        if let Some(id) = id {
            engine.bind_source(id, view.label(), &crate::eval::origin(&url)?)?;
        }
        let clients = eval_clients.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let result = clients.get(&view).and_then(|client| {
                client.evaluate(&view, &script, || match id {
                    Some(id) => engine.remaining(id),
                    None => Ok(TIMEOUT),
                })
            });
            if let Some(id) = id {
                engine.resolve(id, result);
            } else if let Err(error) = result {
                tracing::warn!(%error, "CEF fire-and-forget evaluation failed");
            }
        });
        Ok(())
    });
    eval
}

pub(crate) fn hooks(
    app: &tauri::AppHandle, engine: EvalEngine,
) -> Result<(EvalFn, PressHooksRef), Box<dyn std::error::Error>> {
    // Validate even if the application currently has no windows.
    if app.runtime_handle().downcast_ref::<tauri_runtime_cef::CefRuntimeHandle<tauri::EventLoopMessage>>().is_none() {
        return Err(std::io::Error::other("init_cef requires the CEF runtime").into());
    }
    engine.cef.store(true, std::sync::atomic::Ordering::Relaxed);
    let clients = Arc::new(Clients::default());
    let eval = eval_hook(app, engine, clients.clone());

    {
        let capture_app = app.clone();
        let capture_clients = clients.clone();
        crate::screenshot::register_page_capture_fn(Arc::new(move |label, [x, y, width, height]| {
            let view = target(&capture_app, label)?;
            let client = capture_clients.get(&view)?;
            let result = client.call(
                &view,
                "Page.captureScreenshot",
                &json!({
                    "format": "png", "captureBeyondViewport": true,
                    "clip": {"x": x, "y": y, "width": width, "height": height, "scale": 1},
                }),
            )?;
            result["data"].as_str().map(str::to_owned).ok_or_else(|| "CEF screenshot has no data".to_owned())
        }));
    }
    #[cfg(target_os = "macos")]
    {
        use base64::Engine;
        let capture_app = app.clone();
        crate::screenshot::register_snapshot_fn(Arc::new(move |label| {
            let view = target(&capture_app, label)?;
            let client = clients.get(&view)?;
            let result = client.call(
                &view,
                "Page.captureScreenshot",
                &json!({"format":"png", "captureBeyondViewport":false}),
            )?;
            let data = result["data"].as_str().ok_or("CEF screenshot has no data")?;
            Ok(crate::screenshot::WebviewSnapshot {
                png: base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?,
                backend: "cef-cdp",
                window_id: crate::native_window_id(&view.window()),
                scale_factor: view.window().scale_factor().map_err(|e| e.to_string())?,
            })
        }));
    }
    #[cfg(any(target_os = "macos", windows))]
    crate::heap::register_heap_snapshot_fn(Arc::new(|_| Err("heap.snapshot is not implemented for CEF".into())));

    let focus_app = app.clone();
    let inject_app = app.clone();
    let press = Arc::new(PressHooks {
        focus: Box::new(move |label| {
            let view = target(&focus_app, label)?;
            #[cfg(target_os = "macos")]
            {
                // Window delivery relies on the WKWebView being the window's first responder and
                // has only been validated there; refuse it here instead of dropping keys.
                if crate::macos_keyboard::delivery()? == crate::macos_keyboard::Delivery::Window {
                    return Err(format!(
                        "{}=window is supported for Wry webviews only",
                        crate::macos_keyboard::DELIVERY_ENV
                    ));
                }
                let window = view.window();
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                let mut activate = true;
                loop {
                    let native = window.clone();
                    let (tx, rx) = mpsc::sync_channel(1);
                    window
                        .run_on_main_thread(move || {
                            let result = if std::time::Instant::now() >= deadline {
                                Err("CEF focus request expired before dispatch".to_owned())
                            } else {
                                crate::macos_keyboard::macos_window_is_focused(&native, activate)
                            };
                            let _ = tx.send(result);
                        })
                        .map_err(|e| e.to_string())?;
                    if rx
                        .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                        .map_err(|e| format!("CEF focus timed out: {e}"))??
                    {
                        break;
                    }
                    if std::time::Instant::now() >= deadline {
                        return Err("CEF host window did not acquire focus".into());
                    }
                    activate = false;
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            #[cfg(not(target_os = "macos"))]
            view.window().set_focus().map_err(|e| e.to_string())?;
            view.set_focus().map_err(|e| e.to_string())
        }),
        run_injection: Box::new(move |label, marker, confirm, task| {
            let view = target(&inject_app, label)
                .map_err(|message| crate::server::InjectionError { message, started: false })?;
            #[cfg(target_os = "macos")]
            {
                crate::macos_keyboard::inject(&view.window(), marker, confirm, task)
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (view, marker, confirm);
                task().map_err(|message| crate::server::InjectionError { message, started: true })
            }
        }),
    });
    Ok((eval, press))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cdp_results_route_only_to_the_allocated_request() {
        let client = Client::default();
        let (tx, rx) = mpsc::sync_channel(1);
        client.pending.lock().expect("test lock").insert(41, tx);
        client.receive(DevToolsProtocol::MethodResult { message_id: 42, success: true, result: b"{}".to_vec() });
        assert!(rx.try_recv().is_err());
        client.receive(DevToolsProtocol::MethodResult {
            message_id: 41,
            success: false,
            result: br#"{"message":"bad method"}"#.to_vec(),
        });
        assert!(rx.recv().expect("test response").expect_err("CDP error").contains("bad method"));
    }
    #[test]
    fn navigation_cancels_pending_work_and_discards_contexts() {
        let client = Client::default();
        let (tx, rx) = mpsc::sync_channel(1);
        client.pending.lock().expect("test lock").insert(1, tx);
        client.contexts.lock().expect("test lock").insert(
            1,
            ExecutionContext { unique_id: "old-process".into(), frame_id: Some("main".into()), is_default: true },
        );
        client.receive(DevToolsProtocol::Event {
            method: "Runtime.executionContextsCleared".into(),
            params: b"{}".to_vec(),
        });
        assert!(rx.recv().expect("test response").is_err());
        assert!(client.contexts.lock().expect("test lock").is_empty());
        assert!(client.pending.lock().expect("test lock").is_empty());
    }
    #[test]
    fn ipc_selects_only_the_top_frame_default_world_and_never_reuses_destroyed_ids() {
        let client = Client::default();
        for (id, unique, frame, is_default) in
            [(1, "isolated", "top", false), (2, "child-world", "child", true), (3, "main-world", "top", true)]
        {
            client.receive(DevToolsProtocol::Event {
                method: "Runtime.executionContextCreated".into(),
                params: serde_json::to_vec(&json!({"context": {"id": id, "uniqueId": unique, "auxData": {"frameId": frame, "isDefault": is_default}}})).expect("valid test value"),
            });
        }
        assert_eq!(client.main_world("top").expect("valid test value"), "main-world");
        client.receive(DevToolsProtocol::Event {
            method: "Runtime.executionContextDestroyed".into(),
            params: br#"{"executionContextId":3}"#.to_vec(),
        });
        assert!(client.main_world("top").is_err());
        client.receive(DevToolsProtocol::Event {
            method: "Runtime.executionContextCreated".into(),
            params: br#"{"context":{"id":3,"uniqueId":"replacement","auxData":{"frameId":"top","isDefault":true}}}"#
                .to_vec(),
        });
        assert_eq!(client.main_world("top").expect("valid test value"), "replacement");
    }

    #[test]
    fn exceptions_and_unserializable_results_are_not_successes() {
        assert!(evaluation_result(&json!({"exceptionDetails":{"text":"throw"}})).is_err());
        assert!(evaluation_result(&json!({"result":{"type":"function"}})).is_err());
        assert_eq!(evaluation_result(&json!({"result":{"value":null}})).expect("valid test value"), Value::Null);
    }
}
