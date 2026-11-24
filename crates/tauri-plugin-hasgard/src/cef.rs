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
/// Same bound as the page bridge keeps on Wry.
const MAX_LOGS: usize = 500;
const MAX_REQUESTS: usize = 200;
/// Thrown by an evaluation that expected the bridge in its context and did not find it.
const BRIDGE_MISSING: &str = "HASGARD_BRIDGE_MISSING";

#[derive(Clone)]
struct ExecutionContext {
    unique_id: String,
    frame_id: Option<String>,
    is_default: bool,
    /// The automation bridge is already installed in this context.
    bridged: bool,
}

#[derive(Default)]
struct Client {
    host_window: String,
    pending: Mutex<HashMap<i32, Reply>>,
    contexts: Mutex<HashMap<i64, ExecutionContext>>,
    executor: Mutex<Option<Arc<crate::playwright::PlaywrightExecutor>>>,
    executor_pending: Mutex<HashMap<i32, (Value, bool)>>,
    action_order: Mutex<()>,
    revoked: Mutex<bool>,
    console: Mutex<ConsoleLog>,
    network: Mutex<NetworkLog>,
    routes: Mutex<Routes>,
    /// The native dialog script is registered for every later document of this webview.
    native_dialogs: Mutex<bool>,
    /// Chunks of the heap snapshot being taken, when one is.
    heap: Mutex<Option<Vec<u8>>>,
}

/// Declarative request routing through the CDP Fetch domain; the rules mirror the Wry bridge.
#[derive(Default)]
struct Routes {
    rules: Vec<Route>,
    intercepted: std::collections::VecDeque<Value>,
    sequence: u64,
    /// Sends a CDP command to the routed webview. Paused requests are answered from the CDP
    /// callback, which has no webview of its own. A closure keeps this type and the event path
    /// free of CEF symbols, so unit tests do not load the CEF runtime library.
    send: Option<RouteSender>,
}

type RouteSender = Arc<dyn Fn(&'static str, Value) + Send + Sync>;

struct Route {
    id: u64,
    pattern: String,
    method: Option<String>,
    abort: bool,
    status: u64,
    body: String,
    content_type: String,
    times: Option<u64>,
    used: u64,
}

/// Anchored glob: `**` crosses path separators, `*` and `?` stay within a segment.
fn glob_matches(pattern: &[char], text: &[char]) -> bool {
    match pattern {
        [] => text.is_empty(),
        ['*', '*', rest @ ..] => (0..=text.len()).any(|skip| glob_matches(rest, &text[skip..])),
        ['*', rest @ ..] => (0..=text.len())
            .take_while(|skip| *skip == 0 || text[skip - 1] != '/')
            .any(|skip| glob_matches(rest, &text[skip..])),
        ['?', rest @ ..] => text.first().is_some_and(|c| *c != '/') && glob_matches(rest, &text[1..]),
        [literal, rest @ ..] => text.first() == Some(literal) && glob_matches(rest, &text[1..]),
    }
}

/// Tauri's own IPC is never routed: a catch-all rule would otherwise swallow the application's commands.
fn is_tauri_ipc(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("ipc://")
        || ["http://ipc.localhost", "https://ipc.localhost"].iter().any(|prefix| {
            lower.strip_prefix(prefix).is_some_and(|rest| rest.is_empty() || rest.starts_with([':', '/', '?', '#']))
        })
}

impl Routes {
    fn add(&mut self, params: &Value) -> Result<Value, String> {
        let pattern =
            params["pattern"].as_str().filter(|p| !p.is_empty()).ok_or("route requires a non-empty 'pattern'")?;
        let action = params["action"].as_str().unwrap_or("fulfill");
        if !matches!(action, "fulfill" | "abort") {
            return Err(format!(
                "route 'action' must be 'fulfill' or 'abort', got: {}",
                action.chars().take(32).collect::<String>()
            ));
        }
        let status = match &params["status"] {
            Value::Null => 200,
            value => value
                .as_u64()
                .filter(|status| (100..=599).contains(status))
                .ok_or("route 'status' must be an HTTP status code between 100 and 599")?,
        };
        let times = match &params["times"] {
            Value::Null => None,
            value => {
                Some(value.as_u64().filter(|times| *times >= 1).ok_or("route 'times' must be a positive integer")?)
            }
        };
        self.sequence += 1;
        let route = Route {
            id: self.sequence,
            pattern: pattern.to_owned(),
            method: params["method"].as_str().filter(|m| !m.is_empty()).map(str::to_ascii_uppercase),
            abort: action == "abort",
            status,
            body: match &params["body"] {
                Value::Null => String::new(),
                Value::String(body) => body.clone(),
                other => other.to_string(),
            },
            content_type: params["contentType"].as_str().filter(|c| !c.is_empty()).unwrap_or("text/plain").to_owned(),
            times,
            used: 0,
        };
        let added = json!({"id": route.id, "pattern": route.pattern, "action": action});
        self.rules.push(route);
        Ok(added)
    }

    fn list(&self) -> Value {
        let routes: Vec<Value> = self
            .rules
            .iter()
            .map(|route| {
                json!({
                    "id": route.id, "pattern": route.pattern, "method": route.method,
                    "action": if route.abort { "abort" } else { "fulfill" },
                    "status": route.status, "times": route.times, "used": route.used,
                })
            })
            .collect();
        json!({"routes": routes, "intercepted": self.intercepted})
    }

    /// The CDP command that answers a paused request; the first matching rule wins.
    fn answer(&mut self, paused: &Value, log_id: u64, now_ms: u64) -> (&'static str, Value) {
        use base64::Engine;
        let request_id = &paused["requestId"];
        let url = paused["request"]["url"].as_str().unwrap_or_default();
        let method = paused["request"]["method"].as_str().unwrap_or_default().to_ascii_uppercase();
        let text: Vec<char> = url.chars().collect();
        let matched = if is_tauri_ipc(url) {
            None
        } else {
            self.rules.iter_mut().find(|route| {
                route.times.is_none_or(|times| route.used < times)
                    && route.method.as_ref().is_none_or(|wanted| *wanted == method)
                    && glob_matches(&route.pattern.chars().collect::<Vec<_>>(), &text)
            })
        };
        let Some(route) = matched else {
            return ("Fetch.continueRequest", json!({"requestId": request_id}));
        };
        route.used += 1;
        let answer = if route.abort {
            ("Fetch.failRequest", json!({"requestId": request_id, "errorReason": "Failed"}))
        } else {
            (
                "Fetch.fulfillRequest",
                json!({
                    "requestId": request_id,
                    "responseCode": route.status,
                    // The page reads a fulfilled body from any origin, as it does a constructed Response on Wry.
                    "responseHeaders": [
                        {"name": "Content-Type", "value": route.content_type},
                        {"name": "Access-Control-Allow-Origin", "value": "*"},
                    ],
                    "body": base64::engine::general_purpose::STANDARD.encode(&route.body),
                }),
            )
        };
        self.intercepted.push_back(json!({
            "id": log_id, "timestamp": now_ms, "route_id": route.id, "method": method, "url": url,
            "action": if route.abort { "abort" } else { "fulfill" },
            "status": if route.abort { 0 } else { route.status },
        }));
        if self.intercepted.len() > MAX_REQUESTS {
            self.intercepted.pop_front();
        }
        answer
    }
}

/// Completed `fetch` and `XMLHttpRequest` exchanges, collected from the CDP Network domain.
#[derive(Default)]
struct NetworkLog {
    entries: std::collections::VecDeque<Value>,
    /// Requests still in flight, by CDP request identifier.
    open: HashMap<String, OpenRequest>,
    sequence: u64,
}

struct OpenRequest {
    wall_ms: f64,
    started: f64,
    method: String,
    url: String,
    request_size: u64,
    status: u64,
    content_length: Option<u64>,
}

impl NetworkLog {
    fn record(&mut self, method: &str, event: &Value) {
        let Some(id) = event["requestId"].as_str() else { return };
        match method {
            "Network.requestWillBeSent" => {
                // The page bridge on Wry wraps fetch and XMLHttpRequest only; report the same set.
                if !matches!(event["type"].as_str(), Some("Fetch" | "XHR")) {
                    return;
                }
                let request = &event["request"];
                // A redirect reuses the identifier; keep the original start and follow the new URL.
                let previous = self.open.remove(id);
                self.open.insert(
                    id.to_owned(),
                    OpenRequest {
                        wall_ms: previous
                            .as_ref()
                            .map_or(event["wallTime"].as_f64().unwrap_or_default() * 1000.0, |open| open.wall_ms),
                        started: previous
                            .as_ref()
                            .map_or(event["timestamp"].as_f64().unwrap_or_default(), |open| open.started),
                        method: request["method"].as_str().unwrap_or_default().to_owned(),
                        url: request["url"].as_str().unwrap_or_default().to_owned(),
                        request_size: request["postData"].as_str().map_or(0, |body| body.len() as u64),
                        status: 0,
                        content_length: None,
                    },
                );
            }
            "Network.responseReceived" => {
                if let Some(open) = self.open.get_mut(id) {
                    let response = &event["response"];
                    open.status = response["status"].as_u64().unwrap_or_default();
                    open.content_length = response["headers"].as_object().and_then(|headers| {
                        headers
                            .iter()
                            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                            .and_then(|(_, value)| value.as_str()?.trim().parse().ok())
                    });
                }
            }
            "Network.loadingFinished" | "Network.loadingFailed" => {
                let Some(open) = self.open.remove(id) else { return };
                // Once response headers arrived the page already observed that status, as a
                // resolved fetch does on Wry; only a request without a response is a failure.
                let failed = method == "Network.loadingFailed" && open.status == 0;
                let elapsed = (event["timestamp"].as_f64().unwrap_or(open.started) - open.started).max(0.0) * 1000.0;
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let (timestamp, duration, transferred) = (
                    open.wall_ms as u64,
                    elapsed as u64,
                    event["encodedDataLength"].as_f64().unwrap_or_default() as u64,
                );
                self.sequence += 1;
                self.entries.push_back(json!({
                    "id": self.sequence,
                    "timestamp": timestamp,
                    "method": open.method,
                    "url": open.url,
                    "status": if failed { 0 } else { open.status },
                    "duration_ms": duration,
                    "error": if failed { json!(event["errorText"].as_str().unwrap_or("Network error")) } else { Value::Null },
                    "request_size": open.request_size,
                    "response_size": if failed { 0 } else { open.content_length.unwrap_or(transferred) },
                }));
                if self.entries.len() > MAX_REQUESTS {
                    self.entries.pop_front();
                }
            }
            _ => {}
        }
    }

    fn list(&self, options: &Value) -> Value {
        let filter = options["filter"].as_str().filter(|filter| !filter.is_empty());
        let failed_only = options["failedOnly"] == true;
        let since_id = options["sinceId"].as_u64().filter(|id| *id > 0);
        let mut result: Vec<&Value> = self
            .entries
            .iter()
            .filter(|entry| filter.is_none_or(|filter| entry["url"].as_str().is_some_and(|url| url.contains(filter))))
            .filter(|entry| {
                !failed_only
                    || entry["status"].as_u64().is_some_and(|status| status >= 400 || status == 0)
                    || !entry["error"].is_null()
            })
            .filter(|entry| since_id.is_none_or(|id| entry["id"].as_u64() > Some(id)))
            .collect();
        if let Some(last) = options["last"].as_u64().filter(|last| *last > 0) {
            let skip = result.len().saturating_sub(usize::try_from(last).unwrap_or(usize::MAX));
            result.drain(..skip);
        }
        json!(result)
    }
}

/// Main-world console output, collected from `Runtime.consoleAPICalled`.
#[derive(Default)]
struct ConsoleLog {
    entries: std::collections::VecDeque<(String, Value)>,
    sequence: u64,
    /// Entries at or before this CDP timestamp were cleared; `Runtime.enable` replays them.
    cleared: f64,
}

/// A console argument as data. Objects arrive as remote handles; their CDP preview gives
/// one level of own properties, and anything deeper is reported by its description.
fn console_argument(arg: &Value) -> Value {
    if let Some(value) = arg.get("value") {
        return value.clone();
    }
    let Some(properties) = arg["preview"]["properties"].as_array() else {
        return arg["unserializableValue"]
            .as_str()
            .or(arg["description"].as_str())
            .map_or(Value::Null, |text| json!(text));
    };
    let value = |property: &Value| {
        let text = property["value"].as_str().unwrap_or_default();
        match property["type"].as_str() {
            Some("number") => {
                text.parse::<f64>().ok().and_then(serde_json::Number::from_f64).map_or(json!(text), Value::Number)
            }
            Some("boolean") => json!(text == "true"),
            Some("undefined") => Value::Null,
            Some("object") if property["subtype"] == "null" => Value::Null,
            _ => json!(text),
        }
    };
    if arg["subtype"] == "array" {
        Value::Array(properties.iter().map(value).collect())
    } else {
        Value::Object(
            properties
                .iter()
                .map(|property| (property["name"].as_str().unwrap_or_default().to_owned(), value(property)))
                .collect(),
        )
    }
}

impl ConsoleLog {
    fn record(&mut self, event: &Value) {
        let level = match event["type"].as_str() {
            Some("log") => "log",
            Some("warning") => "warn",
            Some("error") => "error",
            Some("info") => "info",
            _ => return,
        };
        let timestamp = event["timestamp"].as_f64().unwrap_or_default();
        // Enabling the Runtime domain again replays buffered messages under new context and
        // object identifiers; the timestamp, call site and rendered arguments identify a message.
        let descriptions: Vec<_> =
            event["args"].as_array().into_iter().flatten().map(|arg| (&arg["value"], &arg["description"])).collect();
        let raw = json!([timestamp, event["type"], descriptions, event["stackTrace"]["callFrames"]]).to_string();
        if timestamp <= self.cleared || self.entries.iter().any(|(seen, _)| *seen == raw) {
            return;
        }
        let args: Vec<Value> =
            event["args"].as_array().map_or_else(Vec::new, |args| args.iter().map(console_argument).collect());
        let source = event["stackTrace"]["callFrames"].get(0).map(|frame| {
            format!(
                "{}:{}:{}",
                frame["url"].as_str().unwrap_or_default(),
                frame["lineNumber"].as_u64().unwrap_or_default() + 1,
                frame["columnNumber"].as_u64().unwrap_or_default() + 1
            )
        });
        self.sequence += 1;
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let entry = json!({
            "id": self.sequence, "timestamp": timestamp as u64, "level": level, "args": args, "source": source,
        });
        self.entries.push_back((raw, entry));
        if self.entries.len() > MAX_LOGS {
            self.entries.pop_front();
        }
    }

    fn list(&self, options: &Value) -> Value {
        let level = options["level"].as_str();
        let since_id = options["sinceId"].as_u64().filter(|id| *id > 0);
        let since = options["since"].as_u64().filter(|time| *time > 0);
        let mut result: Vec<&Value> = self
            .entries
            .iter()
            .map(|(_, entry)| entry)
            .filter(|entry| level.is_none_or(|level| entry["level"] == level))
            .filter(|entry| match (since_id, since) {
                (Some(id), _) => entry["id"].as_u64() > Some(id),
                (None, Some(time)) => entry["timestamp"].as_u64() > Some(time),
                (None, None) => true,
            })
            .collect();
        if let Some(last) = options["last"].as_u64().filter(|last| *last > 0) {
            let skip = result.len().saturating_sub(usize::try_from(last).unwrap_or(usize::MAX));
            result.drain(..skip);
        }
        json!(result)
    }
}

impl Client {
    fn stop(&self) -> Result<(), String> {
        *self.revoked.lock().expect("CEF input gate") = true;
        self.routes.lock().expect("CEF routes lock").send = None;
        let stopped = self.executor.lock().expect("executor").take().map(|executor| executor.stop());
        self.executor_pending.lock().expect("executor CDP").clear();
        self.cancel("CEF control was stopped");
        stopped.transpose().map(|_| ())
    }
    fn action(
        self: &Arc<Self>, view: &View, method: &str, mut params: Value,
        command: Option<crate::playwright::ExecutorCommand>,
    ) -> Result<Value, String> {
        let _order = self.action_order.lock().expect("CEF action order");
        let existing = self.executor.lock().expect("executor").clone();
        let executor = if let Some(executor) = existing {
            executor
        } else {
            let info = self.call(view, "Target.getTargetInfo", &json!({}))?;
            let path = if let Some(path) = std::env::var_os("TAURI_HASGARD_PLAYWRIGHT") {
                std::path::PathBuf::from(path)
            } else {
                std::env::current_exe()
                    .map_err(|e| e.to_string())?
                    .parent()
                    .ok_or("Executable has no parent")?
                    .join(if cfg!(windows) { "hasgard-playwright.exe" } else { "hasgard-playwright" })
            };
            let command = command.unwrap_or(crate::playwright::ExecutorCommand { program: path, args: Vec::new() });
            let weak = Arc::downgrade(self);
            let native = view.clone();
            let executor =
                Arc::new(crate::playwright::PlaywrightExecutor::start_command(&command, move |mut message, root| {
                    let client = weak.upgrade().ok_or("CEF target closed")?;
                    let revoked = client.revoked.lock().expect("CEF input gate");
                    if *revoked {
                        return Err("CEF control was revoked".into());
                    }
                    let id = allocate_devtools_message_id().map_err(|e| e.to_string())?;
                    client.executor_pending.lock().expect("executor CDP").insert(id, (message["id"].clone(), root));
                    message["id"] = json!(id);
                    native
                        .send_dev_tools_message(&serde_json::to_vec(&message).map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())
                })?);
            {
                let revoked = self.revoked.lock().expect("CEF input gate");
                if *revoked {
                    executor.stop()?;
                    return Err("CEF control was revoked".into());
                }
                *self.executor.lock().expect("executor") = Some(executor.clone());
            }
            // Replay existing contexts to the newly attached Playwright connection.
            self.call(view, "Runtime.disable", &json!({}))?;
            if let Err(error) = executor.request(json!({"kind":"init", "targetInfo":info["targetInfo"]})) {
                self.executor.lock().expect("executor").take();
                return Err(error);
            }
            executor
        };
        let reference = params.get("ref").and_then(Value::as_str).map(str::to_owned);
        let token = uuid::Uuid::new_v4().to_string();
        let previous = if let Some(reference) = &reference {
            let code = format!(
                "(()=>{{const e=window.__HASGARD__.resolve({});if(!e?.isConnected)throw Error('Stale reference; read the page again');const old=e.getAttribute('data-hasgard-action');e.setAttribute('data-hasgard-action',{});return old}})()",
                json!(reference),
                json!(token)
            );
            let previous = self.evaluate(view, &EvalScript { code, world: EvalWorld::Automation }, || Ok(TIMEOUT))?;
            params["actionToken"] = json!(token);
            Some(previous)
        } else {
            None
        };
        let result = executor.request(json!({"kind":"action", "method":method, "params":params}));
        if let (Some(reference), Some(previous)) = (reference, previous) {
            let code = format!(
                "(()=>{{const e=window.__HASGARD__.resolve({});if(e?.getAttribute('data-hasgard-action')==={}){{const old={};if(old===null)e.removeAttribute('data-hasgard-action');else e.setAttribute('data-hasgard-action',old)}}}})()",
                json!(reference),
                json!(token),
                previous
            );
            // Navigation can destroy the original document after a successful action.
            let _ = self.evaluate(view, &EvalScript { code, world: EvalWorld::Automation }, || Ok(TIMEOUT));
        }
        result
    }

    /// `nativeDialog.*`: the dialog plugin's commands are answered in the page's main
    /// world, where the application makes them. The script is registered for later
    /// documents as well, so a policy in force holds across navigation.
    fn native_dialog(&self, view: &View, operation: &str, params: &Value) -> Result<Value, String> {
        let call = match operation {
            "handle" => "handle",
            "list" => "list",
            "clear" => "clear",
            other => return Err(format!("Unknown native dialog method: nativeDialog.{other}")),
        };
        {
            let mut registered = self.native_dialogs.lock().expect("CEF native dialog lock");
            if !*registered {
                self.call(view, "Page.addScriptToEvaluateOnNewDocument", &json!({"source": crate::NATIVE_DIALOG_JS}))?;
                *registered = true;
            }
        }
        // The current document predates the registration; the script installs itself once.
        let code = format!(
            "(()=>{{{}\nreturn window.__HASGARD_NATIVE_DIALOGS__.{call}({params})}})()",
            crate::NATIVE_DIALOG_JS
        );
        self.evaluate(view, &EvalScript { code, world: EvalWorld::Main }, || Ok(TIMEOUT))
    }

    /// `heap.snapshot`: V8's own `.heapsnapshot`, streamed by the `DevTools` protocol
    /// and written next to the target, then renamed, so a reader never sees a partial file.
    fn heap_snapshot(&self, view: &View, params: &Value) -> Result<Value, String> {
        let raw = params["output_path"].as_str().ok_or("output_path is required")?;
        let path = std::path::Path::new(raw);
        if !path.is_absolute() {
            return Err(format!("output_path must be absolute: {raw}"));
        }
        if !path.parent().is_some_and(std::path::Path::is_dir) {
            return Err(format!("output_path parent directory does not exist: {raw}"));
        }
        {
            let mut heap = self.heap.lock().expect("CEF heap lock");
            if heap.is_some() {
                return Err("a heap snapshot of this webview is already being taken".into());
            }
            *heap = Some(Vec::new());
        }
        // The protocol sends every chunk before it answers the request.
        let taken = self.call_with_timeout(
            view,
            "HeapProfiler.takeHeapSnapshot",
            &json!({"reportProgress": false}),
            Duration::from_secs(120),
        );
        let snapshot = self.heap.lock().expect("CEF heap lock").take().expect("the collector was installed above");
        taken?;
        if snapshot.is_empty() {
            return Err("CEF returned an empty heap snapshot".into());
        }
        let partial = path.with_extension("partial");
        std::fs::write(&partial, &snapshot).and_then(|()| std::fs::rename(&partial, path)).map_err(|error| {
            let _ = std::fs::remove_file(&partial);
            format!("failed to write {}: {error}", path.display())
        })?;
        Ok(json!({"output_path": path, "byte_size": snapshot.len(), "format": "v8"}))
    }

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
                                bridged: false,
                            },
                        );
                    }
                } else if method == "Runtime.consoleAPICalled" {
                    if let Ok(value) = serde_json::from_slice::<Value>(&params) {
                        // The automation bridge logs from its own isolated world; report the page only.
                        let isolated = value["executionContextId"].as_i64().is_some_and(|id| {
                            self.contexts.lock().expect("CDP contexts lock").get(&id).is_some_and(|c| !c.is_default)
                        });
                        if !isolated {
                            self.console.lock().expect("CEF console lock").record(&value);
                        }
                    }
                } else if method == "HeapProfiler.addHeapSnapshotChunk" {
                    if let Ok(value) = serde_json::from_slice::<Value>(&params)
                        && let Some(chunk) = value["chunk"].as_str()
                        && let Some(snapshot) = self.heap.lock().expect("CEF heap lock").as_mut()
                    {
                        snapshot.extend_from_slice(chunk.as_bytes());
                    }
                } else if method == "Fetch.requestPaused" {
                    if let Ok(value) = serde_json::from_slice::<Value>(&params) {
                        self.answer_paused(&value);
                    }
                } else if method.starts_with("Network.") {
                    if let Ok(value) = serde_json::from_slice::<Value>(&params) {
                        self.network.lock().expect("CEF network lock").record(&method, &value);
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
            DevToolsProtocol::Message(bytes) => {
                let executor = self.executor.lock().expect("executor").clone();
                if let Some(executor) = executor
                    && let Ok(mut value) = serde_json::from_slice::<Value>(&bytes)
                {
                    if let Some(id) = value["id"].as_i64() {
                        if let Ok(id) = i32::try_from(id)
                            && let Some((original, root)) =
                                self.executor_pending.lock().expect("executor CDP").remove(&id)
                        {
                            value["id"] = original;
                            let _ = executor.receive(&value, root);
                        }
                    } else if !value["method"].as_str().is_some_and(|method| method.starts_with("Fetch.")) {
                        // Interception belongs to the host's rules. Playwright would otherwise
                        // answer the same paused request and race the configured route.
                        let _ = executor.receive(&value, false);
                    }
                }
            }
        }
    }

    /// Every paused request gets exactly one answer; an unanswered one would hang the page.
    fn answer_paused(&self, paused: &Value) {
        let log_id = {
            let mut network = self.network.lock().expect("CEF network lock");
            network.sequence += 1;
            network.sequence
        };
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX));
        let (send, (method, params)) = {
            let mut routes = self.routes.lock().expect("CEF routes lock");
            (routes.send.clone(), routes.answer(paused, log_id, now_ms))
        };
        // This runs on the CEF thread that sending a message waits for, so answer from another
        // thread; the reply itself is not awaited.
        if let Some(send) = send {
            std::thread::spawn(move || send(method, params));
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
        let sent = {
            let revoked = self.revoked.lock().expect("CEF input gate");
            if *revoked {
                self.pending.lock().expect("CDP pending lock").remove(&id);
                return Err("CEF control was revoked".into());
            }
            view.send_dev_tools_message(
                &serde_json::to_vec(&json!({"id": id, "method": method, "params": params}))
                    .map_err(|e| e.to_string())?,
            )
        };
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
        &self, view: &View, script: &EvalScript, remaining_time: impl Fn() -> Result<Duration, String>,
    ) -> Result<Value, String> {
        let tree = self.call(view, "Page.getFrameTree", &json!({}))?;
        let frame = tree["frameTree"]["frame"]["id"].as_str().ok_or("CDP returned no main frame")?;
        // Bind to a unique context: navigation must fail, never execute in a
        // replacement renderer. Main-world IPC uses the page's real Tauri bridge
        // and its existing capability checks; no native command bypass exists.
        let (unique, bridge) = match script.world {
            EvalWorld::Main => (self.main_world(frame)?, None),
            EvalWorld::Automation => {
                let world =
                    self.call(view, "Page.createIsolatedWorld", &json!({"frameId": frame, "worldName": WORLD}))?;
                let context = world["executionContextId"].as_i64().ok_or("CDP returned no execution context")?;
                let contexts = self.contexts.lock().expect("CDP contexts lock");
                let known =
                    contexts.get(&context).ok_or("AUTOMATION_NOT_READY: CEF execution context is not available")?;
                (known.unique_id.clone(), Some((context, known.bridged)))
            }
        };
        // The bridge is about 90 KB of source. A context keeps it once installed, so
        // only the first evaluation in each document carries it.
        let run = |prelude: &str| -> Result<Value, String> {
            let expression = format!(
                "(async()=>{{{prelude}\nconst value=await({});return value===undefined?null:value;}})()",
                script.code
            );
            let result = self.call_with_timeout(
                view,
                "Runtime.evaluate",
                &json!({
                    "expression": expression, "uniqueContextId": unique,
                    "awaitPromise": true, "returnByValue": true, "userGesture": true,
                }),
                remaining_time()?,
            )?;
            evaluation_result(&result)
        };
        match bridge {
            None => run(
                "if(typeof window.__TAURI_INTERNALS__?.invoke!=='function')throw new Error('Tauri IPC is unavailable in this document');",
            ),
            Some((context, bridged)) => {
                if bridged {
                    match run(&format!("if(!window.__HASGARD__)throw new Error('{BRIDGE_MISSING}');")) {
                        // The record outlived the bridge it describes; install it again below.
                        Err(error) if error.contains(BRIDGE_MISSING) => {}
                        other => return other,
                    }
                }
                let result = run(crate::BRIDGE_JS);
                // Whatever the script itself did, the bridge ran first and is now in place.
                if let Some(known) = self.contexts.lock().expect("CDP contexts lock").get_mut(&context) {
                    known.bridged = true;
                }
                result
            }
        }
    }
}

fn evaluation_result(result: &Value) -> Result<Value, String> {
    if let Some(error) = result.get("exceptionDetails") {
        return Err(format!("CEF JavaScript exception: {error}"));
    }
    result["result"].get("value").cloned().ok_or_else(|| format!("CEF result is not serializable: {result}"))
}

#[derive(Default)]
struct Clients(Mutex<HashMap<String, (i32, Arc<Client>)>>, Mutex<std::collections::HashSet<String>>);
impl Clients {
    fn cleanup(&self, window: Option<&str>) -> Result<(), String> {
        let mut clients = self.0.lock().expect("CEF clients lock");
        let labels: Vec<_> = clients
            .iter()
            .filter(|(label, (_, client))| {
                window.is_none_or(|window| window == label.as_str() || window == client.host_window)
            })
            .map(|(label, _)| label.clone())
            .collect();
        let mut errors = Vec::new();
        for label in labels {
            if let Some((_, client)) = clients.remove(&label)
                && let Err(error) = client.stop()
            {
                errors.push(error);
            }
        }
        if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
    }
    fn get(&self, view: &View) -> Result<Arc<Client>, String> {
        let (tx, rx) = mpsc::sync_channel(1);
        view.with_cef_webview(move |native| {
            let _ = tx.send(native.snapshot().browser_id);
        })
        .map_err(|e| e.to_string())?;
        let browser_id = rx.recv_timeout(TIMEOUT).map_err(|e| e.to_string())?;
        let live = view.app_handle().webviews();
        let mut clients = self.0.lock().expect("CEF clients lock");
        if self.1.lock().expect("CEF revoked targets").contains(view.label()) {
            return Err("CEF control was revoked".into());
        }
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
        let client = Arc::new(Client { host_window: view.window().label().to_owned(), ..Default::default() });
        let weak = Arc::downgrade(&client);
        view.on_dev_tools_protocol(move |message| {
            if let Some(client) = weak.upgrade() {
                client.receive(message);
            }
        })
        .map_err(|e| e.to_string())?;
        // A revoked worker leaves the native Runtime domain enabled. A fresh
        // observer needs its context inventory replayed before it can bind an
        // evaluation to a unique context; enable alone is idempotent.
        client.call(view, "Runtime.disable", &json!({}))?;
        client.call(view, "Runtime.enable", &json!({}))?;
        client.call(view, "Network.enable", &json!({}))?;
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

fn register_captures(app: &tauri::AppHandle, clients: &Arc<Clients>) {
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
        let snapshot_clients = clients.clone();
        crate::screenshot::register_snapshot_fn(Arc::new(move |label| {
            let view = target(&capture_app, label)?;
            let client = snapshot_clients.get(&view)?;
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
}

fn register_console(app: &tauri::AppHandle, engine: &EvalEngine, clients: &Arc<Clients>) {
    let console_clients = clients.clone();
    let console_app = app.clone();
    *engine.observe.lock().expect("CEF observation hook") = Some(Arc::new(move |label, method, params| {
        let view = target(&console_app, label)?;
        let client = console_clients.get(&view)?;
        if method == "heap.snapshot" {
            return client.heap_snapshot(&view, &params);
        }
        // Requests are paused only while a route wants to answer them. Only the kinds the
        // Wry bridge wraps are paused; documents and assets load untouched.
        let intercept = |wanted: bool| -> Result<(), String> {
            let enabled = client.routes.lock().expect("CEF routes lock").send.is_some();
            if wanted && !enabled {
                let native = view.clone();
                client.routes.lock().expect("CEF routes lock").send = Some(Arc::new(move |method, params| {
                    if let Ok(id) = allocate_devtools_message_id()
                        && let Ok(message) = serde_json::to_vec(&json!({"id": id, "method": method, "params": params}))
                    {
                        let _ = native.send_dev_tools_message(&message);
                    }
                }));
                let patterns =
                    json!([{"urlPattern": "*", "resourceType": "Fetch"}, {"urlPattern": "*", "resourceType": "XHR"}]);
                if let Err(error) = client.call(&view, "Fetch.enable", &json!({"patterns": patterns})) {
                    client.routes.lock().expect("CEF routes lock").send = None;
                    return Err(error);
                }
            } else if !wanted && enabled {
                // Requests paused meanwhile are still answered: the view stays until interception is off.
                client.call(&view, "Fetch.disable", &json!({}))?;
                client.routes.lock().expect("CEF routes lock").send = None;
            }
            Ok(())
        };
        if method == "route.add" {
            let added = client.routes.lock().expect("CEF routes lock").add(&params)?;
            if let Err(error) = intercept(true) {
                client.routes.lock().expect("CEF routes lock").rules.clear();
                return Err(error);
            }
            return Ok(added);
        }
        if method == "route.list" {
            return Ok(client.routes.lock().expect("CEF routes lock").list());
        }
        if method == "route.clear" {
            let removed = {
                let mut routes = client.routes.lock().expect("CEF routes lock");
                let removed = routes.rules.len();
                routes.rules.clear();
                routes.intercepted.clear();
                removed
            };
            intercept(false)?;
            return Ok(json!({"removed": removed}));
        }
        if let Some(operation) = method.strip_prefix("nativeDialog.") {
            return client.native_dialog(&view, operation, &params);
        }
        if method == "network.getRequests" {
            return Ok(client.network.lock().expect("CEF network lock").list(&params));
        }
        if method == "network.clear" {
            client.network.lock().expect("CEF network lock").entries.clear();
            return Ok(json!({"cleared": true}));
        }
        if method == "console.clear" {
            // Stamp before discarding: a later Runtime.enable must not resurrect these entries.
            let now =
                client.call(&view, "Runtime.evaluate", &json!({"expression": "Date.now()", "returnByValue": true}))?;
            client.call(&view, "Runtime.discardConsoleEntries", &json!({}))?;
            let mut console = client.console.lock().expect("CEF console lock");
            console.entries.clear();
            console.cleared = now["result"]["value"].as_f64().ok_or("CEF clock is unavailable")?;
            return Ok(json!({"cleared": true}));
        }
        Ok(client.console.lock().expect("CEF console lock").list(&params))
    }));
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
    let cleanup_clients = clients.clone();
    *engine.cleanup.lock().expect("CEF cleanup hook") = Some(Arc::new(move |window| cleanup_clients.cleanup(window)));
    let cancel_clients = clients.clone();
    *engine.cancel.lock().expect("CEF cancel hook") = Some(Arc::new(move |label, revoked| {
        let mut clients = cancel_clients.0.lock().expect("CEF clients");
        if !revoked {
            cancel_clients.1.lock().expect("CEF revoked targets").remove(label);
            return Ok(());
        }
        cancel_clients.1.lock().expect("CEF revoked targets").insert(label.to_owned());
        if let Some((_, client)) = clients.remove(label) {
            client.stop()?;
        }
        Ok(())
    }));
    let action_clients = clients.clone();
    let action_app = app.clone();
    let command = engine.executor.clone();
    *engine.action.lock().expect("CEF action hook") = Some(Arc::new(move |label, method, params| {
        let view = target(&action_app, label)?;
        action_clients.get(&view)?.action(&view, method, params, command.lock().expect("executor command").clone())
    }));
    register_console(app, &engine, &clients);
    let eval = eval_hook(app, engine, clients.clone());

    register_captures(app, &clients);
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
            #[cfg(windows)]
            let before = crate::windows_focus::current();
            #[cfg(not(target_os = "macos"))]
            view.window().set_focus().map_err(|e| e.to_string())?;
            view.set_focus().map_err(|e| e.to_string())?;
            #[cfg(windows)]
            crate::windows_focus::confirm(view.window().hwnd().map_err(|e| e.to_string())?.0 as isize, before)?;
            Ok(())
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
    #[test]
    fn glob_is_anchored_and_segment_aware() {
        let matches = |pattern: &str, text: &str| {
            super::glob_matches(&pattern.chars().collect::<Vec<_>>(), &text.chars().collect::<Vec<_>>())
        };
        assert!(matches("**/api", "http://h/v1/api"));
        assert!(!matches("**/api", "http://h/v2/api-docs"));
        assert!(matches("http://h/*/users", "http://h/v1/users"));
        assert!(!matches("http://h/*/users", "http://h/v1/x/users"));
        assert!(matches("http://h/item?", "http://h/item7"));
        assert!(!matches("http://h/item?", "http://h/item/"));
        assert!(matches("**", "anything/at/all"));
    }

    #[test]
    fn routes_answer_first_match_respect_method_times_and_never_route_tauri_ipc() {
        let mut routes = super::Routes::default();
        assert!(routes.add(&json!({})).is_err());
        assert!(routes.add(&json!({"pattern": "**", "action": "drop"})).is_err());
        assert!(routes.add(&json!({"pattern": "**", "status": 99})).is_err());
        assert!(routes.add(&json!({"pattern": "**", "times": 0})).is_err());
        assert_eq!(
            routes.add(&json!({"pattern": "**/api", "method": "post", "status": 201, "body": "{}", "contentType": "application/json", "times": 1})),
            Ok(json!({"id": 1, "pattern": "**/api", "action": "fulfill"}))
        );
        routes.add(&json!({"pattern": "**", "action": "abort"})).expect("catch-all");
        let paused = |method: &str, url: &str| json!({"requestId": "r", "request": {"method": method, "url": url}});
        let (command, params) = routes.answer(&paused("POST", "http://h/api"), 7, 1000);
        assert_eq!(command, "Fetch.fulfillRequest");
        assert_eq!((&params["responseCode"], &params["body"]), (&json!(201), &json!("e30=")));
        // The single-use rule is spent, so the later catch-all takes the next request.
        assert_eq!(routes.answer(&paused("POST", "http://h/api"), 8, 1001).0, "Fetch.failRequest");
        assert_eq!(routes.answer(&paused("POST", "http://ipc.localhost/cmd"), 9, 1002).0, "Fetch.continueRequest");
        assert_eq!(routes.answer(&paused("GET", "ipc://localhost/cmd"), 10, 1003).0, "Fetch.continueRequest");
        let listed = routes.list();
        assert_eq!(
            listed["routes"][0],
            json!({"id": 1, "pattern": "**/api", "method": "POST", "action": "fulfill", "status": 201, "times": 1, "used": 1})
        );
        assert_eq!(
            listed["intercepted"][0],
            json!({"id": 7, "timestamp": 1000, "route_id": 1, "method": "POST", "url": "http://h/api", "action": "fulfill", "status": 201})
        );
        assert_eq!(listed["intercepted"][1]["status"], 0);
        assert_eq!(listed["intercepted"].as_array().map(Vec::len), Some(2));
    }

    #[test]
    fn network_log_reports_fetch_and_xhr_outcomes_with_filters() {
        let mut log = super::NetworkLog::default();
        let sent = |id: &str, kind: &str, method: &str, url: &str, body: Option<&str>| {
            json!({"requestId": id, "type": kind, "wallTime": 1700.5, "timestamp": 10.0,
                   "request": {"method": method, "url": url, "postData": body}})
        };
        log.record("Network.requestWillBeSent", &sent("a", "Fetch", "POST", "http://h/api", Some("abcd")));
        log.record("Network.requestWillBeSent", &sent("b", "XHR", "GET", "http://h/missing", None));
        log.record("Network.requestWillBeSent", &sent("c", "Fetch", "GET", "http://down/", None));
        log.record("Network.requestWillBeSent", &sent("d", "Image", "GET", "http://h/logo.png", None));
        log.record(
            "Network.responseReceived",
            &json!({"requestId": "a", "response": {"status": 200, "headers": {"Content-Length": "12"}}}),
        );
        log.record("Network.responseReceived", &json!({"requestId": "b", "response": {"status": 404, "headers": {}}}));
        log.record("Network.loadingFinished", &json!({"requestId": "a", "timestamp": 10.25, "encodedDataLength": 90}));
        log.record(
            "Network.loadingFailed",
            &json!({"requestId": "b", "timestamp": 10.5, "errorText": "net::ERR_ABORTED"}),
        );
        log.record(
            "Network.loadingFailed",
            &json!({"requestId": "c", "timestamp": 11.0, "errorText": "net::ERR_FAILED"}),
        );
        log.record("Network.loadingFinished", &json!({"requestId": "d", "timestamp": 11.0, "encodedDataLength": 5}));
        let all = log.list(&json!({}));
        assert_eq!(
            all[0],
            json!({"id": 1, "timestamp": 1_700_500, "method": "POST", "url": "http://h/api", "status": 200,
                   "duration_ms": 250, "error": null, "request_size": 4, "response_size": 12})
        );
        assert_eq!((&all[1]["status"], &all[1]["error"]), (&json!(404), &Value::Null));
        assert_eq!(all[2]["status"], 0);
        assert_eq!(all[2]["error"], "net::ERR_FAILED");
        assert_eq!(all.as_array().map(Vec::len), Some(3));
        assert_eq!(log.list(&json!({"failedOnly": true})).as_array().map(Vec::len), Some(2));
        assert_eq!(log.list(&json!({"filter": "missing"}))[0]["id"], 2);
        assert_eq!(log.list(&json!({"sinceId": 2}))[0]["id"], 3);
        assert_eq!(log.list(&json!({"last": 1}))[0]["id"], 3);
        assert!(log.open.is_empty());
    }

    #[test]
    fn console_log_deduplicates_replays_filters_and_honors_clear() {
        let event = |kind: &str, timestamp: f64, text: &str| {
            json!({"type": kind, "timestamp": timestamp, "args": [{"type": "string", "value": text}],
                   "stackTrace": {"callFrames": [{"url": "http://h/p.html", "lineNumber": 4, "columnNumber": 8}]}})
        };
        let mut log = super::ConsoleLog::default();
        log.record(&event("warning", 10.5, "first"));
        log.record(&event("warning", 10.5, "first"));
        log.record(&event("log", 11.0, "second"));
        log.record(&event("debug", 12.0, "ignored level"));
        let all = log.list(&json!({}));
        assert_eq!(all.as_array().map(Vec::len), Some(2));
        assert_eq!(
            all[0],
            json!({"id": 1, "timestamp": 10, "level": "warn", "args": ["first"], "source": "http://h/p.html:5:9"})
        );
        assert_eq!(log.list(&json!({"level": "log"}))[0]["id"], 2);
        assert_eq!(log.list(&json!({"sinceId": 1}))[0]["id"], 2);
        assert_eq!(log.list(&json!({"last": 1}))[0]["id"], 2);
        log.entries.clear();
        log.cleared = 11.0;
        log.record(&event("log", 11.0, "second"));
        assert_eq!(log.list(&json!({})), json!([]));
        log.record(&event("error", 11.5, "third"));
        assert_eq!(log.list(&json!({}))[0]["id"], 3);
    }

    #[test]
    fn console_arguments_use_values_then_shallow_previews() {
        assert_eq!(super::console_argument(&json!({"type": "number", "value": 3})), json!(3));
        assert_eq!(super::console_argument(&json!({"type": "number", "unserializableValue": "NaN"})), json!("NaN"));
        assert_eq!(
            super::console_argument(&json!({"type": "object", "description": "Object", "preview": {"properties": [
                {"name": "remote", "type": "boolean", "value": "true"},
                {"name": "count", "type": "number", "value": "2"},
                {"name": "nested", "type": "object", "value": "Object"},
            ]}})),
            json!({"remote": true, "count": 2.0, "nested": "Object"})
        );
        assert_eq!(
            super::console_argument(&json!({"type": "object", "subtype": "array", "preview": {"properties": [
                {"name": "0", "type": "string", "value": "a"},
            ]}})),
            json!(["a"])
        );
        assert_eq!(super::console_argument(&json!({"type": "function", "description": "f(){}"})), json!("f(){}"));
    }

    use super::*;
    #[test]
    fn closing_a_host_cleans_its_children_and_exit_cleans_remaining_targets() {
        let clients = Clients::default();
        let mut receivers = Vec::new();
        let mut handles = Vec::new();
        for (label, host) in [("main", "main"), ("guest", "main"), ("settings", "settings")] {
            let client = Arc::new(Client { host_window: host.into(), ..Default::default() });
            let (tx, rx) = mpsc::sync_channel(1);
            client.pending.lock().expect("test lock").insert(1, tx);
            clients.0.lock().expect("test lock").insert(label.into(), (1, client.clone()));
            handles.push(client);
            receivers.push(rx);
        }
        clients.cleanup(Some("main")).expect("close host");
        for index in 0..2 {
            assert!(receivers[index].recv().expect("cancelled reply").is_err());
            assert!(*handles[index].revoked.lock().expect("test lock"));
        }
        assert!(receivers[2].try_recv().is_err());
        assert!(!*handles[2].revoked.lock().expect("test lock"));
        assert_eq!(clients.0.lock().expect("test lock").len(), 1);
        clients.cleanup(None).expect("exit");
        assert!(receivers[2].recv().expect("cancelled reply").is_err());
        assert!(clients.0.lock().expect("test lock").is_empty());
    }
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
            ExecutionContext {
                unique_id: "old-process".into(),
                frame_id: Some("main".into()),
                is_default: true,
                bridged: false,
            },
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
