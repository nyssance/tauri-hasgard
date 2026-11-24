use std::{
    io::IsTerminal,
    path::Path,
    path::PathBuf,
    sync::{Arc, OnceLock},
};

use anyhow::{Context, Result};
use rmcp::{
    ErrorData as McpError, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ErrorCode, Implementation, JsonObject,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool, ToolAnnotations,
    },
    service::{MaybeSendFuture, RequestContext, RoleServer},
    transport::stdio,
};
use serde_json::{Map, Value, json};

use crate::{
    client::{Client, InProcessCall},
    protocol::RpcError,
    support::{
        Scope, build_location_wait_params, build_wait_params, export_replay_file, resolve_socket, run_drop_command,
        run_replay_command, run_set_input_files_command, target_params, window_request, with_scope,
    },
};

#[derive(Clone)]
enum App {
    Endpoint { socket: Option<PathBuf>, resolved: Arc<OnceLock<PathBuf>> },
    InProcess(InProcessCall),
}

/// The Hasgard tools as an MCP server.
///
/// Serve it over any `rmcp` transport, or hand it to an ACP bridge that accepts an
/// `rmcp` service. Each tool takes an optional `window` label that overrides the default.
#[derive(Clone)]
pub struct HasgardMcpServer {
    app: App,
    window: Option<String>,
    dangerous: bool,
    /// The downloads a `downloads` wait has answered with, and the run of the application
    /// they belong to. An agent acts and then waits, so the wait has to count a download
    /// that finished in between, and must not answer twice with one it already gave.
    downloads_given: Arc<std::sync::Mutex<(u64, Vec<u64>)>>,
}

impl std::fmt::Debug for HasgardMcpServer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let app = match &self.app {
            App::Endpoint { socket, .. } => format!("endpoint {socket:?}"),
            App::InProcess(_) => "in process".to_owned(),
        };
        formatter
            .debug_struct("HasgardMcpServer")
            .field("app", &app)
            .field("window", &self.window)
            .field("dangerous", &self.dangerous)
            .field("downloads_given", &self.downloads_given)
            .finish()
    }
}

/// Serve the Hasgard tools on this process's stdin and stdout until the client disconnects.
///
/// `socket` is the plugin endpoint; `None` discovers the running application on the first tool call.
///
/// # Errors
/// Returns an error when the MCP handshake fails or the transport breaks.
pub async fn serve_stdio(socket: Option<PathBuf>, window: Option<String>) -> Result<()> {
    print_startup_banner(socket.as_deref(), window.as_deref());
    let service = HasgardMcpServer::endpoint(socket, window)
        .serve(stdio())
        .await
        .map_err(|e| anyhow::anyhow!("failed to initialize MCP server: {e}"))?;
    service.waiting().await.map_err(|e| anyhow::anyhow!("MCP server failed: {e}"))?;
    Ok(())
}

fn print_startup_banner(socket: Option<&Path>, window: Option<&str>) {
    if std::io::stdin().is_terminal() && std::io::stderr().is_terminal() {
        eprintln!("{}", startup_banner(socket, window));
    }
}

fn startup_banner(socket: Option<&Path>, window: Option<&str>) -> String {
    let socket = socket.map_or_else(|| "auto-detect on first tool call".to_owned(), |path| path.display().to_string());
    let window = window.unwrap_or("default app window");

    format!(
        r"
tauri-hasgard MCP server

Status : listening on stdio
Socket : {socket}
Window : {window}

stdout is reserved for MCP JSON-RPC.
Configure your MCP client to launch this command instead of typing requests here.
"
    )
}

impl HasgardMcpServer {
    /// Reach the application through the plugin's local endpoint.
    ///
    /// `socket` is a Unix socket path or Windows named pipe; `None` discovers the running
    /// application on the first tool call.
    #[must_use]
    pub fn endpoint(socket: Option<PathBuf>, window: Option<String>) -> Self {
        Self {
            app: App::Endpoint { socket, resolved: Arc::new(OnceLock::new()) },
            window,
            dangerous: dangerous_mcp_tools_enabled(),
            downloads_given: Arc::default(),
        }
    }

    /// Reach the application through a function in the host process, with no endpoint.
    ///
    /// `call` receives a Hasgard protocol method and its params object and returns the
    /// result or the protocol error. The plugin's `Automation::call` has this shape.
    pub fn in_process<F, Fut>(call: F, window: Option<String>) -> Self
    where
        F: Fn(String, Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, RpcError>> + Send + 'static,
    {
        Self {
            app: App::InProcess(Arc::new(move |method, params| Box::pin(call(method, params)))),
            window,
            dangerous: dangerous_mcp_tools_enabled(),
            downloads_given: Arc::default(),
        }
    }

    /// Expose or hide the `eval`, `ipc` and `drop` tools, which run arbitrary code or
    /// commands in the application.
    ///
    /// Without this call the choice follows `TAURI_HASGARD_MCP_ENABLE_DANGEROUS_TOOLS`,
    /// read when the server is created, and they are hidden when it is unset.
    #[must_use]
    pub fn with_dangerous_tools(mut self, enabled: bool) -> Self {
        self.dangerous = enabled;
        self
    }

    async fn connect_client(&self) -> Result<Client> {
        let (socket, resolved) = match &self.app {
            App::Endpoint { socket, resolved } => (socket, resolved),
            App::InProcess(call) => return Ok(Client::in_process(call.clone())),
        };
        if let Some(socket) = socket {
            return Client::connect(socket).await;
        }

        if let Some(socket) = resolved.get() {
            return Client::connect(socket).await;
        }

        let socket = resolve_socket(None)?;
        let client = Client::connect(&socket).await?;
        let _ = resolved.set(socket);
        Ok(client)
    }

    async fn call_app(&self, method: &'static str, params: Option<Value>, window: Option<String>) -> Result<Value> {
        let mut client = self.connect_client().await?;
        client.call(method, with_scope(params, Scope { window: window.as_deref(), ..Scope::default() })).await
    }

    /// Look up the operating-system window id backing a Tauri webview label.
    ///
    async fn call_app_tool(
        &self, method: &'static str, params: Option<Value>, window: Option<String>,
    ) -> Result<CallToolResult, McpError> {
        Ok(match self.call_app(method, params, window).await {
            Ok(result) => tool_success(result),
            Err(err) => tool_error(&err),
        })
    }

    /// Wait for a finished download this server has not answered with yet, whether it
    /// finishes before or after this call.
    async fn wait_for_next_download(&self, params: Value, window: Option<String>) -> Result<CallToolResult, McpError> {
        let timeout = params["timeout"].as_u64().unwrap_or(10_000);
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout);
        let waited = async {
            loop {
                // Ids are counted from one in each run of the application.
                let listing = self.call_app("downloads.list", Some(json!({})), None).await?;
                let session = listing["session"].as_u64().context("downloads.list answered without a session")?;
                let except = {
                    let mut given = self.downloads_given.lock().expect("downloads given");
                    if given.0 != session {
                        *given = (session, Vec::new());
                    }
                    given.1.clone()
                };
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                let call = json!({
                    "session": session, "except": except,
                    "timeout": u64::try_from(left.as_millis()).unwrap_or(u64::MAX),
                });
                let download = self.call_app("downloads.wait", Some(call), window.clone()).await?;
                let id = download["id"].as_u64().context("downloads.wait answered without the download's id")?;
                let mut given = self.downloads_given.lock().expect("downloads given");
                // A wait running alongside may have been answered with this one; ask again then.
                if given.0 == session && !given.1.contains(&id) {
                    given.1.push(id);
                    return Ok::<Value, anyhow::Error>(download);
                }
            }
        };
        Ok(match waited.await {
            Ok(download) => tool_success(download),
            Err(err) => tool_error(&err),
        })
    }

    #[expect(clippy::too_many_lines)]
    async fn call_tool_by_name(&self, name: &str, args: JsonObject) -> Result<CallToolResult, McpError> {
        let name = normalize_tool_name(name);
        if DANGEROUS_MCP_TOOLS.contains(&name) && !self.dangerous {
            return Err(disabled_by_default(&format!("tool '{name}'")));
        }
        let window = self.window_arg(&args)?;
        match name {
            "ping" => self.call_app_tool("ping", None, window).await,
            "windows" => self.call_app_tool("windows.list", None, None).await,
            "state" => self.call_app_tool("state", None, window).await,
            "snapshot" => {
                let mut params = json!({
                    "interactive": optional_bool(&args, "interactive")?.unwrap_or(false),
                    "selector": optional_string(&args, "selector")?,
                    "depth": optional_u8(&args, "depth")?,
                });
                insert_optional_frame(&mut params, &args)?;
                self.call_app_tool("snapshot", Some(params), window).await
            }
            "diff" => {
                let mut params = json!({
                    "interactive": optional_bool(&args, "interactive")?.unwrap_or(false),
                    "selector": optional_string(&args, "selector")?,
                    "depth": optional_u8(&args, "depth")?,
                });
                if let Some(reference) = args.get("reference") {
                    params["reference"] = reference.clone();
                }
                insert_optional_frame(&mut params, &args)?;
                self.call_app_tool("diff", Some(params), window).await
            }
            "query" => {
                let by = required_string(&args, "by")?;
                let mut params = json!({
                    "by": by,
                    "value": required_string(&args, "value")?,
                    "exact": optional_bool(&args, "exact")?.unwrap_or(false),
                });
                if let Some(name) = optional_string(&args, "name")? {
                    if by != "role" {
                        return Err(invalid_params("'name' applies to by: \"role\" only"));
                    }
                    params["name"] = json!(name);
                }
                insert_optional_frame(&mut params, &args)?;
                self.call_app_tool("query", Some(params), window).await
            }
            "click" => {
                let params = click_params_from_args(&args)?;
                self.call_app_tool("click", Some(params), window).await
            }
            "fill" => {
                let mut params = target_params(&required_string(&args, "target")?);
                params["value"] = json!(required_string(&args, "value")?);
                insert_optional_frame(&mut params, &args)?;
                self.call_app_tool("fill", Some(params), window).await
            }
            "type" => {
                let mut params = target_params(&required_string(&args, "target")?);
                params["text"] = json!(required_string(&args, "text")?);
                insert_optional_frame(&mut params, &args)?;
                self.call_app_tool("type", Some(params), window).await
            }
            "press" => {
                let mut params = json!({"key": required_string(&args, "key")?});
                if let Some(completion) = optional_string(&args, "completion")? {
                    params["completion"] = json!(completion);
                }
                if let Some(expression) = optional_string(&args, "wait_for")? {
                    params["waitFor"] = json!(expression);
                }
                if let Some(timeout) = optional_u64(&args, "timeout")? {
                    params["timeout"] = json!(timeout);
                }
                self.call_app_tool("press", Some(params), window).await
            }
            "select" => {
                let mut params = target_params(&required_string(&args, "target")?);
                match (optional_string(&args, "value")?, args.get("values").filter(|values| !values.is_null())) {
                    (Some(_), Some(_)) => {
                        return Err(invalid_params("select accepts either 'value' or 'values', not both"));
                    }
                    (Some(value), None) => params["value"] = json!(value),
                    (None, Some(_)) => params["values"] = json!(required_string_array(&args, "values")?),
                    (None, None) => return Err(invalid_params("select requires 'value' or 'values'")),
                }
                insert_optional_frame(&mut params, &args)?;
                self.call_app_tool("select", Some(params), window).await
            }
            "check" => {
                let mut params = target_params(&required_string(&args, "target")?);
                if let Some(checked) = optional_bool(&args, "checked")? {
                    params["checked"] = json!(checked);
                }
                insert_optional_frame(&mut params, &args)?;
                self.call_app_tool("check", Some(params), window).await
            }
            "dblclick" => {
                let mut params = click_params_from_args(&args)?;
                params["clickCount"] = json!(2);
                self.call_app_tool("click", Some(params), window).await
            }
            "hover" => self.target_call("hover", &args, window).await,
            "focus" => self.target_call("focus", &args, window).await,
            "blur" => self.target_call("blur", &args, window).await,
            "disabled" => self.target_call("disabled", &args, window).await,
            "visible" => self.target_call("visible", &args, window).await,
            "checked" => self.target_call("checked", &args, window).await,
            "count" => {
                let mut params = json!({"selector": required_string(&args, "selector")?});
                insert_optional_frame(&mut params, &args)?;
                self.call_app_tool("count", Some(params), window).await
            }
            "bounding_box" => self.target_call("boundingBox", &args, window).await,
            "scroll" => {
                let mut params = match (optional_string(&args, "target")?, optional_ref(&args)?) {
                    (Some(_), Some(_)) => {
                        return Err(invalid_params("scroll accepts either 'target' or 'ref', not both"));
                    }
                    (Some(target), None) => target_params(&target),
                    (None, Some(reference)) => json!({"ref": reference}),
                    (None, None) => json!({}),
                };
                params["direction"] = json!(optional_string(&args, "direction")?.unwrap_or_else(|| "down".to_owned()));
                params["amount"] = json!(optional_number(&args, "amount")?);
                insert_optional_frame(&mut params, &args)?;
                self.call_app_tool("scroll", Some(params), window).await
            }
            "drag" => {
                let source = required_string(&args, "source")?;
                let mut params = json!({"source": target_params(&source)});
                let target = optional_string(&args, "target")?;
                let offset = args.get("offset").cloned();
                match (target, offset) {
                    (Some(_), Some(_)) => {
                        return Err(invalid_params("drag accepts either 'target' or 'offset', not both"));
                    }
                    (None, None) => {
                        return Err(invalid_params("drag requires either 'target' or 'offset'"));
                    }
                    (Some(target), None) => {
                        params["target"] = target_params(&target);
                    }
                    (None, Some(offset)) => {
                        params["offset"] = offset;
                    }
                }
                insert_optional_frame(&mut params, &args)?;
                self.call_app_tool("drag", Some(params), window).await
            }
            "drop" => self.call_drop_tool(args, window).await,
            "set_input_files" => self.call_set_input_files_tool(args, window).await,
            // `clear` routes to `fill` with an empty value so the two cannot
            // drift on which events they fire.
            "clear" => {
                let mut params = target_params(&required_string(&args, "target")?);
                params["value"] = json!("");
                insert_optional_frame(&mut params, &args)?;
                self.call_app_tool("fill", Some(params), window).await
            }
            "wheel" => {
                let mut params =
                    optional_string(&args, "target")?.map_or_else(|| json!({}), |target| target_params(&target));
                params["deltaX"] = json!(optional_number(&args, "delta_x")?.unwrap_or(0.0));
                params["deltaY"] = json!(optional_number(&args, "delta_y")?.unwrap_or(0.0));
                insert_optional_frame(&mut params, &args)?;
                self.call_app_tool("wheel", Some(params), window).await
            }
            "dialog" => self.call_dialog_tool(args, window).await,
            "native_dialog" => {
                let action = required_string(&args, "action")?;
                let (method, params) = match action.as_str() {
                    "accept" | "dismiss" | "manual" => {
                        let mut params = json!({"action": action});
                        if let Some(paths) = args.get("paths").filter(|value| !value.is_null()) {
                            params["paths"] = paths.clone();
                        }
                        if let Some(button) = optional_string(&args, "button")? {
                            params["button"] = json!(button);
                        }
                        ("nativeDialog.handle", Some(params))
                    }
                    "list" => ("nativeDialog.list", None),
                    "clear" => ("nativeDialog.clear", None),
                    other => {
                        return Err(invalid_params(format!(
                            "unknown native_dialog action: {other}; expected accept, dismiss, manual, list or clear"
                        )));
                    }
                };
                self.call_app_tool(method, params, window).await
            }
            "event" => {
                let action = required_string(&args, "action")?;
                let mut params = json!({});
                if let Some(event) = optional_string(&args, "event")? {
                    params["event"] = json!(event);
                }
                let method = match action.as_str() {
                    "emit" => {
                        params["payload"] = args.get("payload").cloned().unwrap_or(Value::Null);
                        "event.emit"
                    }
                    "listen" => "event.listen",
                    "unlisten" => "event.unlisten",
                    "list" => {
                        if let Some(since) = optional_u64(&args, "since_id")? {
                            params["sinceId"] = json!(since);
                        }
                        "event.list"
                    }
                    "clear" => "event.clear",
                    other => {
                        return Err(invalid_params(format!(
                            "unknown event action: {other}; expected emit, listen, unlisten, list or clear"
                        )));
                    }
                };
                // Only `emit` is scoped by a window: it then reaches that window alone,
                // and only when the caller names one.
                let target = if method == "event.emit" { optional_string(&args, "window")? } else { None };
                self.call_app_tool(method, Some(params), target).await
            }
            "downloads" => {
                let mut params = json!({});
                let window = optional_string(&args, "window")?;
                let method = match required_string(&args, "action")?.as_str() {
                    "list" => "downloads.list",
                    "wait" => {
                        if let Some(timeout) = optional_u64(&args, "timeout")? {
                            params["timeout"] = json!(timeout);
                        }
                        return match optional_u64(&args, "since_id")? {
                            Some(since) => {
                                params["sinceId"] = json!(since);
                                self.call_app_tool("downloads.wait", Some(params), window).await
                            }
                            None => self.wait_for_next_download(params, window).await,
                        };
                    }
                    "set_directory" => {
                        params["path"] = json!(optional_string(&args, "path")?);
                        "downloads.setDirectory"
                    }
                    "clear" => "downloads.clear",
                    other => {
                        return Err(invalid_params(format!(
                            "unknown downloads action: {other}; expected list, wait, set_directory or clear"
                        )));
                    }
                };
                // A window narrows the view to its own downloads, and only when the caller names one.
                self.call_app_tool(method, Some(params), window).await
            }
            "clipboard" => match required_string(&args, "action")?.as_str() {
                "read" => self.call_app_tool("clipboard.read", None, None).await,
                "write" => {
                    let text = required_string(&args, "text")?;
                    self.call_app_tool("clipboard.write", Some(json!({"text": text})), None).await
                }
                other => Err(invalid_params(format!("unknown clipboard action: {other}; expected read or write"))),
            },
            "cookies" => {
                let method = match required_string(&args, "action")?.as_str() {
                    "get" => "cookies.get",
                    "set" => "cookies.set",
                    "clear" => "cookies.clear",
                    other => {
                        return Err(invalid_params(format!(
                            "unknown cookies action: {other}; expected get, set or clear"
                        )));
                    }
                };
                // Tool arguments are snake case; the protocol's cookie fields are camel case.
                let mut params = Map::new();
                for (argument, field) in [
                    ("name", "name"),
                    ("value", "value"),
                    ("url", "url"),
                    ("domain", "domain"),
                    ("path", "path"),
                    ("expires", "expires"),
                    ("http_only", "httpOnly"),
                    ("secure", "secure"),
                    ("same_site", "sameSite"),
                ] {
                    if let Some(value) = args.get(argument).filter(|value| !value.is_null()) {
                        params.insert(field.to_owned(), value.clone());
                    }
                }
                self.call_app_tool(method, Some(Value::Object(params)), window).await
            }
            "window" => {
                let pair = |first: &str, second: &str| -> Result<Option<(f64, f64)>, McpError> {
                    let number = |name: &str| match args.get(name) {
                        None | Some(Value::Null) => Ok(None),
                        Some(value) => {
                            value.as_f64().map(Some).ok_or_else(|| invalid_params(format!("'{name}' must be a number")))
                        }
                    };
                    Ok(number(first)?.zip(number(second)?))
                };
                let action = required_string(&args, "action")?;
                let (method, params) = window_request(&action, pair("width", "height")?, pair("x", "y")?)
                    .map_err(|error| invalid_params(error.to_string()))?;
                self.call_app_tool(method, params, window).await
            }
            "route" => self.call_route_tool(args, window).await,
            "text" => self.target_call("text", &args, window).await,
            "html" => {
                let mut params =
                    optional_string(&args, "target")?.map_or_else(|| json!({}), |target| target_params(&target));
                insert_optional_frame(&mut params, &args)?;
                self.call_app_tool("html", Some(params), window).await
            }
            "value" => self.target_call("value", &args, window).await,
            "attrs" => self.target_call("attrs", &args, window).await,
            "eval" => {
                self.call_app_tool("eval", Some(json!({"script": required_string(&args, "script")?})), window).await
            }
            "ipc" => {
                self.call_app_tool(
                    "ipc",
                    Some(json!({
                        "command": required_string(&args, "command")?,
                        "args": args.get("args").cloned(),
                    })),
                    window,
                )
                .await
            }
            "screenshot" => {
                let mut params = json!({"selector": optional_string(&args, "selector")?});
                insert_optional_frame(&mut params, &args)?;
                Ok(
                    match self
                        .call_app("screenshot", Some(params), window)
                        .await
                        .and_then(|result| image_content(&result))
                    {
                        Ok(image) => CallToolResult::success(vec![image]),
                        Err(err) => tool_error(&err),
                    },
                )
            }
            "screenshot_native" => {
                // Without an id the plugin renders the routed webview through
                // WebKit itself, so the common case needs nothing but an output
                // path. An explicit id captures that whole on-screen window.
                let mut payload = json!({ "output_path": required_string(&args, "output_path")? });
                if let Some(window_id) = optional_u32(&args, "window_id")? {
                    payload["window_id"] = json!(window_id);
                }
                if let Some(format) = optional_string(&args, "format")? {
                    payload["format"] = json!(format);
                }
                self.call_app_tool("screenshot_native", Some(payload), window).await
            }
            "navigate" => {
                let url = required_string(&args, "url")?;
                validate_navigate_url(&url)?;
                self.call_app_tool("navigate", Some(json!({ "url": url })), window).await
            }
            "url" => self.call_app_tool("url", None, window).await,
            "title" => self.call_app_tool("title", None, window).await,
            "wait" => {
                let target = optional_string(&args, "target")?;
                let selector = optional_string(&args, "selector")?;
                let expression = optional_string(&args, "expression")?;
                let poll = optional_u64(&args, "poll")?;
                let gone = optional_bool(&args, "gone")?.unwrap_or(false);
                let timeout = optional_u64(&args, "timeout")?.unwrap_or(10_000);
                let url = optional_string(&args, "url")?;
                let load = optional_string(&args, "load")?;
                let params = if url.is_some() || load.is_some() {
                    if target.is_some() || selector.is_some() || expression.is_some() || gone {
                        return Err(invalid_params(
                            "'url' and 'load' cannot be combined with an element or expression wait",
                        ));
                    }
                    let mut params = build_location_wait_params(url.as_deref(), load.as_deref(), timeout);
                    // The application refuses a frame here; leaving it out would answer for the page.
                    insert_optional_frame(&mut params, &args)?;
                    params
                } else {
                    let mut params = build_wait_params(
                        target.as_deref(),
                        selector.as_deref(),
                        expression.as_deref(),
                        poll,
                        gone,
                        timeout,
                    );
                    insert_optional_frame(&mut params, &args)?;
                    params
                };
                self.call_app_tool("wait", Some(params), window).await
            }
            "watch" => {
                let mut watch_params = json!({
                    "selector": optional_string(&args, "selector")?,
                    "timeout": optional_u64(&args, "timeout")?.unwrap_or(10_000),
                    "stable": optional_u64(&args, "stable")?.unwrap_or(300),
                });
                if optional_bool(&args, "require_mutation")?.unwrap_or(false) {
                    watch_params["requireMutation"] = json!(true);
                }
                self.call_app_tool("watch", Some(watch_params), window).await
            }
            "logs" => self.call_logs_tool(&args, window).await,
            "network" => self.call_network_tool(&args, window).await,
            "storage_get" => {
                self.call_app_tool(
                    "storage.get",
                    Some(json!({
                        "key": required_string(&args, "key")?,
                        "session": optional_bool(&args, "session")?.unwrap_or(false),
                    })),
                    window,
                )
                .await
            }
            "storage_set" => {
                self.call_app_tool(
                    "storage.set",
                    Some(json!({
                        "key": required_string(&args, "key")?,
                        "value": required_string(&args, "value")?,
                        "session": optional_bool(&args, "session")?.unwrap_or(false),
                    })),
                    window,
                )
                .await
            }
            "storage_list" => {
                self.call_app_tool(
                    "storage.list",
                    Some(json!({"session": optional_bool(&args, "session")?.unwrap_or(false)})),
                    window,
                )
                .await
            }
            "storage_clear" => {
                self.call_app_tool(
                    "storage.clear",
                    Some(json!({"session": optional_bool(&args, "session")?.unwrap_or(false)})),
                    window,
                )
                .await
            }
            "forms" => {
                let params = optional_string(&args, "selector")?.map(|selector| json!({ "selector": selector }));
                self.call_app_tool("forms.dump", params, window).await
            }
            "assert_text" => self.assert_text(args, window, false).await,
            "assert_contains" => self.assert_text(args, window, true).await,
            "assert_visible" => self.assert_bool("visible", args, window, true).await,
            "assert_hidden" => self.assert_bool("visible", args, window, false).await,
            "assert_value" => self.assert_value(args, window).await,
            "assert_count" => self.assert_count(args, window).await,
            "assert_checked" => self.assert_bool("checked", args, window, true).await,
            "assert_url" => self.assert_url(args, window).await,
            "video_start" => {
                let mut params = json!({"output_path":required_string(&args,"output_path")?});
                if let Some(fps) = optional_usize(&args, "fps")? {
                    params["fps"] = json!(fps);
                }
                if let Some(ms) = optional_usize(&args, "max_duration_ms")? {
                    params["max_duration_ms"] = json!(ms);
                }
                self.call_app_tool("video.start", Some(params), window).await
            }
            "heap_snapshot" => {
                let params = json!({"output_path":required_string(&args,"output_path")?});
                self.call_app_tool("heap.snapshot", Some(params), window).await
            }
            "video_stop" => self.call_app_tool("video.stop", None, window).await,
            "video_status" => self.call_app_tool("video.status", None, window).await,
            "record_start" => self.call_app_tool("record.start", None, window).await,
            "record_stop" => self.call_app_tool("record.stop", None, window).await,
            "record_status" => self.call_app_tool("record.status", None, window).await,
            "replay" => self.call_replay_tool(args, window).await,
            "run_scenario" => self.call_scenario_tool(&args, window.as_deref()).await,
            _ => Err(McpError::new(ErrorCode::METHOD_NOT_FOUND, format!("unknown tool: {name}"), None)),
        }
    }

    async fn call_scenario_tool(&self, args: &JsonObject, window: Option<&str>) -> Result<CallToolResult, McpError> {
        let content = required_string(args, "toml")?;
        let fail_fast = optional_bool(args, "fail_fast")?;
        let scenario = crate::scenario::parse_scenario(&content).map_err(|e| invalid_params(e.to_string()))?;
        // MCP remains attached to its configured application; TOML cannot redirect it.
        if scenario.connect.is_some() {
            return Err(invalid_params("MCP scenarios must omit [connect]; use the MCP server socket configuration"));
        }
        // A scenario is another way to reach the tools that are off by default.
        if let Some(step) = scenario.step.iter().find(|step| DANGEROUS_MCP_TOOLS.contains(&step.action.as_str()))
            && !self.dangerous
        {
            return Err(disabled_by_default(&format!("scenario step '{}'", step.action)));
        }
        let mut client = match self.connect_client().await {
            Ok(client) => client,
            Err(e) => return Ok(tool_error(&e)),
        };
        Ok(match crate::scenario::run_scenario(&mut client, &scenario, window, fail_fast).await {
            Ok(report) => {
                let steps: Vec<Value> = report.results.iter().map(|step| match &step.outcome {
                    crate::scenario::StepOutcome::Passed { duration } => json!({"name":step.name,"status":"passed","duration_ms":duration.as_millis()}),
                    crate::scenario::StepOutcome::Failed { duration, message } => json!({"name":step.name,"status":"failed","error":message,"duration_ms":duration.as_millis()}),
                    crate::scenario::StepOutcome::Skipped => json!({"name":step.name,"status":"skipped"}),
                }).collect();
                let result = json!({"name":report.name,"passed":report.passed(),"failed":report.failed(),"skipped":report.skipped(),"steps":steps});
                if report.all_passed() {
                    tool_success(result)
                } else {
                    CallToolResult::structured_error(json!({"result":result}))
                }
            }
            Err(e) => tool_error(&e),
        })
    }

    async fn target_call(
        &self, method: &'static str, args: &JsonObject, window: Option<String>,
    ) -> Result<CallToolResult, McpError> {
        let target = required_string(args, "target")?;
        let mut params = target_params(&target);
        insert_optional_frame(&mut params, args)?;
        self.call_app_tool(method, Some(params), window).await
    }

    async fn call_logs_tool(&self, args: &JsonObject, window: Option<String>) -> Result<CallToolResult, McpError> {
        if optional_bool(args, "clear")?.unwrap_or(false) {
            return self.call_app_tool("console.clear", None, window).await;
        }
        let mut params = Map::new();
        insert_optional_string(&mut params, args, "level")?;
        insert_optional_usize(&mut params, args, "last")?;
        self.call_app_tool("console.getLogs", Some(Value::Object(params)), window).await
    }

    async fn call_network_tool(&self, args: &JsonObject, window: Option<String>) -> Result<CallToolResult, McpError> {
        if optional_bool(args, "clear")?.unwrap_or(false) {
            return self.call_app_tool("network.clear", None, window).await;
        }
        let mut params = Map::new();
        insert_optional_string(&mut params, args, "filter")?;
        insert_optional_usize(&mut params, args, "last")?;
        if optional_bool(args, "failed")?.unwrap_or(false) {
            params.insert("failedOnly".into(), json!(true));
        }
        self.call_app_tool("network.getRequests", Some(Value::Object(params)), window).await
    }

    async fn call_drop_tool(&self, args: JsonObject, window: Option<String>) -> Result<CallToolResult, McpError> {
        let target = required_string(&args, "target")?;
        let files: Vec<PathBuf> = required_string_array(&args, "files")?.into_iter().map(PathBuf::from).collect();
        if files.is_empty() {
            return Err(invalid_params("'files' must contain at least one path"));
        }
        let mut client = match self.connect_client().await {
            Ok(client) => client,
            Err(err) => return Ok(tool_error(&err)),
        };
        let frame = optional_frame(&args)?.unwrap_or_default();
        let scope = Scope { window: window.as_deref(), frame: &frame };
        Ok(match run_drop_command(&mut client, &target, files, scope).await {
            Ok(result) => tool_success(result),
            Err(err) => tool_error(&err),
        })
    }

    async fn call_set_input_files_tool(
        &self, args: JsonObject, window: Option<String>,
    ) -> Result<CallToolResult, McpError> {
        let target = required_string(&args, "target")?;
        // Unlike `drop`, an empty list is meaningful: it deselects.
        let files: Vec<PathBuf> = required_string_array(&args, "files")?.into_iter().map(PathBuf::from).collect();
        let mut client = match self.connect_client().await {
            Ok(client) => client,
            Err(err) => return Ok(tool_error(&err)),
        };
        let frame = optional_frame(&args)?.unwrap_or_default();
        let scope = Scope { window: window.as_deref(), frame: &frame };
        Ok(match run_set_input_files_command(&mut client, &target, files, scope).await {
            Ok(result) => tool_success(result),
            Err(err) => tool_error(&err),
        })
    }

    async fn call_dialog_tool(&self, args: JsonObject, window: Option<String>) -> Result<CallToolResult, McpError> {
        let action = required_string(&args, "action")?;
        let (method, params) = match action.as_str() {
            "accept" => {
                let mut params = json!({"action": "accept"});
                if let Some(text) = optional_string(&args, "prompt_text")? {
                    params["promptText"] = json!(text);
                }
                ("dialog.handle", Some(params))
            }
            "dismiss" => ("dialog.handle", Some(json!({"action": "dismiss"}))),
            "list" => ("dialog.list", None),
            "clear" => ("dialog.clear", None),
            other => {
                return Err(invalid_params(format!("'action' must be accept, dismiss, list, or clear, got: {other}")));
            }
        };
        self.call_app_tool(method, params, window).await
    }

    async fn call_route_tool(&self, args: JsonObject, window: Option<String>) -> Result<CallToolResult, McpError> {
        let action = required_string(&args, "action")?;
        let (method, params) = match action.as_str() {
            "fulfill" | "abort" => {
                let mut params = json!({
                    "pattern": required_string(&args, "pattern")?,
                    "action": action,
                });
                if action == "fulfill" {
                    if let Some(status) = optional_u32(&args, "status")? {
                        params["status"] = json!(status);
                    }
                    if let Some(body) = optional_string(&args, "body")? {
                        params["body"] = json!(body);
                    }
                    if let Some(content_type) = optional_string(&args, "content_type")? {
                        params["contentType"] = json!(content_type);
                    }
                }
                if let Some(verb) = optional_string(&args, "method")? {
                    params["method"] = json!(verb);
                }
                if let Some(times) = optional_u32(&args, "times")? {
                    params["times"] = json!(times);
                }
                ("route.add", Some(params))
            }
            "list" => ("route.list", None),
            "clear" => ("route.clear", None),
            other => {
                return Err(invalid_params(format!("'action' must be fulfill, abort, list, or clear, got: {other}")));
            }
        };
        self.call_app_tool(method, params, window).await
    }

    async fn call_replay_tool(&self, args: JsonObject, window: Option<String>) -> Result<CallToolResult, McpError> {
        let path = PathBuf::from(required_string(&args, "path")?);
        let export = optional_string(&args, "export")?;
        if let Some(export) = export.as_deref() {
            return Ok(match export_replay_file(&path, export) {
                Ok(result) => tool_success(result),
                Err(err) => tool_error(&err),
            });
        }
        // So is a recording: it replays whatever it holds.
        if !self.dangerous {
            let entries = match crate::support::read_replay_entries(&path) {
                Ok(entries) => entries,
                Err(err) => return Ok(tool_error(&err)),
            };
            let held = entries.iter().filter_map(|entry| entry.get("action")?.as_str());
            if let Some(action) = held.into_iter().find(|action| DANGEROUS_MCP_TOOLS.contains(action)) {
                return Err(disabled_by_default(&format!("recorded action '{action}'")));
            }
        }
        let mut client = match self.connect_client().await {
            Ok(client) => client,
            Err(err) => return Ok(tool_error(&err)),
        };
        Ok(match run_replay_command(&mut client, &path, None, window.as_deref()).await {
            Ok(result) => tool_success(result),
            Err(err) => tool_error(&err),
        })
    }

    async fn assert_text(
        &self, args: JsonObject, window: Option<String>, contains: bool,
    ) -> Result<CallToolResult, McpError> {
        let expected = required_string(&args, "expected")?;
        let target = required_string(&args, "target")?;
        let actual = match self.call_app("text", Some(scoped_target(&target, &args)?), window).await {
            Ok(Value::String(actual)) => actual,
            Ok(other) => {
                return Ok(tool_error_msg(format!("expected string response, got {other}")));
            }
            Err(err) => return Ok(tool_error(&err)),
        };
        let passed = if contains { actual.contains(&expected) } else { actual == expected };
        if passed {
            Ok(tool_success(json!({"ok": true})))
        } else {
            let message = if contains {
                format!("text does not contain \"{expected}\", got \"{actual}\"")
            } else {
                format!("expected text \"{expected}\", got \"{actual}\"")
            };
            Ok(tool_error_msg(message))
        }
    }

    async fn assert_value(&self, args: JsonObject, window: Option<String>) -> Result<CallToolResult, McpError> {
        let expected = required_string(&args, "expected")?;
        let target = required_string(&args, "target")?;
        let actual = match self.call_app("value", Some(scoped_target(&target, &args)?), window).await {
            Ok(Value::String(actual)) => actual,
            Ok(other) => {
                return Ok(tool_error_msg(format!("expected string response, got {other}")));
            }
            Err(err) => return Ok(tool_error(&err)),
        };
        if actual == expected {
            Ok(tool_success(json!({"ok": true})))
        } else {
            Ok(tool_error_msg(format!("expected value \"{expected}\", got \"{actual}\"")))
        }
    }

    async fn assert_bool(
        &self, method: &'static str, args: JsonObject, window: Option<String>, expected: bool,
    ) -> Result<CallToolResult, McpError> {
        let target = required_string(&args, "target")?;
        let field = method;
        let actual = match self.call_app(method, Some(scoped_target(&target, &args)?), window).await {
            Ok(result) => match result.get(field).and_then(Value::as_bool) {
                Some(value) => value,
                None => return Ok(tool_error_msg(format!("missing boolean field '{field}'"))),
            },
            Err(err) => return Ok(tool_error(&err)),
        };
        if actual == expected {
            Ok(tool_success(json!({"ok": true})))
        } else if method == "visible" && expected {
            Ok(tool_error_msg("element is not visible"))
        } else if method == "visible" {
            Ok(tool_error_msg("element is visible"))
        } else if method == "checked" && expected {
            Ok(tool_error_msg("element is not checked"))
        } else if method == "checked" {
            Ok(tool_error_msg("element is checked"))
        } else {
            Ok(tool_error_msg(format!("element '{method}' state mismatch: expected {expected}")))
        }
    }

    async fn assert_count(&self, args: JsonObject, window: Option<String>) -> Result<CallToolResult, McpError> {
        let selector = required_string(&args, "selector")?;
        let expected = required_u64(&args, "expected")?;
        let mut count_params = json!({"selector": selector});
        insert_optional_frame(&mut count_params, &args)?;
        let actual = match self.call_app("count", Some(count_params), window).await {
            Ok(result) => match result.get("count").and_then(Value::as_u64) {
                Some(value) => value,
                None => return Ok(tool_error_msg("missing 'count' field")),
            },
            Err(err) => return Ok(tool_error(&err)),
        };
        if actual == expected {
            Ok(tool_success(json!({"ok": true})))
        } else {
            Ok(tool_error_msg(format!("expected {expected} elements, found {actual}")))
        }
    }

    async fn assert_url(&self, args: JsonObject, window: Option<String>) -> Result<CallToolResult, McpError> {
        let expected = required_string(&args, "expected")?;
        let actual = match self.call_app("url", None, window).await {
            Ok(Value::String(actual)) => actual,
            Ok(other) => {
                return Ok(tool_error_msg(format!("expected string response, got {other}")));
            }
            Err(err) => return Ok(tool_error(&err)),
        };
        if actual.contains(&expected) {
            Ok(tool_success(json!({"ok": true})))
        } else {
            Ok(tool_error_msg(format!("URL does not contain \"{expected}\", got \"{actual}\"")))
        }
    }

    fn window_arg(&self, args: &JsonObject) -> Result<Option<String>, McpError> {
        optional_string(args, "window").map(|window| window.or_else(|| self.window.clone()))
    }
}

impl ServerHandler for HasgardMcpServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new("tauri-hasgard", env!("CARGO_PKG_VERSION"))
                    .with_title("tauri-hasgard")
                    .with_description("MCP server for testing Tauri apps through tauri-hasgard"),
            )
            .with_instructions("Use these tools to inspect and control a running Tauri app through tauri-hasgard.")
    }

    fn list_tools(
        &self, _request: Option<PaginatedRequestParams>, _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListToolsResult, McpError>> + MaybeSendFuture + '_ {
        std::future::ready(Ok(ListToolsResult::with_all_items(cached_tools(self.dangerous).clone())))
    }

    fn call_tool(
        &self, request: CallToolRequestParams, _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<CallToolResponse, McpError>> + MaybeSendFuture + '_ {
        let name = request.name.to_string();
        let args = request.arguments.unwrap_or_default();
        async move { self.call_tool_by_name(&name, args).await.map(Into::into) }
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        let name = namespaced_tool_name(name);
        cached_tools(self.dangerous).iter().find(|tool| tool.name == name.as_str()).cloned()
    }
}

const HASGARD_PREFIX: &str = "hasgard.";
fn disabled_by_default(what: &str) -> McpError {
    invalid_params(format!(
        "{what} is disabled by default. Set {ENABLE_DANGEROUS_MCP_TOOLS_ENV}=1 to enable dangerous MCP tools."
    ))
}

const ENABLE_DANGEROUS_MCP_TOOLS_ENV: &str = "TAURI_HASGARD_MCP_ENABLE_DANGEROUS_TOOLS";
const DANGEROUS_MCP_TOOLS: &[&str] = &["drop", "eval", "ipc"];

fn normalize_tool_name(name: &str) -> &str {
    name.strip_prefix(HASGARD_PREFIX).unwrap_or(name)
}

fn namespaced_tool_name(name: &str) -> String {
    if name.starts_with(HASGARD_PREFIX) { name.to_owned() } else { format!("{HASGARD_PREFIX}{name}") }
}

fn dangerous_mcp_tools_enabled() -> bool {
    std::env::var(ENABLE_DANGEROUS_MCP_TOOLS_ENV)
        .is_ok_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

fn validate_navigate_url(url: &str) -> Result<(), McpError> {
    // Mirror the normalization a browser's URL parser applies before it
    // resolves the scheme, so a crafted string can't smuggle a `javascript:`
    // URL past this filter and reach `window.location.href` in the bridge:
    //   * ASCII tab/LF/CR are stripped from anywhere in the input, so
    //     `java\tscript:` and `java\nscript:` collapse to `javascript:`.
    //   * Leading C0 controls and spaces (scalar value <= U+0020) are removed,
    //     so `\u{0}javascript:` collapses to `javascript:`.
    let stripped: String = url.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    if stripped.trim_start_matches(|c| c <= '\u{20}').to_ascii_lowercase().starts_with("javascript:") {
        return Err(invalid_params("navigate does not allow javascript: URLs for security reasons"));
    }
    Ok(())
}

struct ToolSpec {
    name: &'static str,
    description: &'static str,
    schema: fn() -> Arc<JsonObject>,
    read_only: bool,
    destructive: bool,
    idempotent: bool,
}

#[expect(clippy::too_many_lines)]
fn tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "attrs",
            description: "Get all HTML attributes for an element target.",
            schema: target_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "blur",
            description: "Remove keyboard focus from an element target.",
            schema: target_schema,
            read_only: false,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "bounding_box",
            description: "Get an element's position and size in viewport pixels.",
            schema: target_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "check",
            description: "Set a checkbox or radio element. Pass `checked` to drive it to a state \
                          (idempotent); omit it to toggle.",
            schema: check_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "click",
            description: "Click an element target by ref, selector, or coordinates, with optional \
                          modifiers, button, click count, and in-element position.",
            schema: click_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "dblclick",
            description: "Double-click an element target by ref, selector, or coordinates.",
            schema: target_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "visible",
            description: "Report whether an element is visible. Unlike assert_visible, a hidden element is an answer, not a failure.",
            schema: target_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "checked",
            description: "Report whether a checkbox or radio is checked.",
            schema: target_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "count",
            description: "Count the elements a CSS selector matches.",
            schema: count_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "disabled",
            description: "Report whether an element is disabled, by property or aria-disabled.",
            schema: target_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "diff",
            description: "Compare the current webview to the previous or supplied snapshot.",
            schema: diff_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "drag",
            description: "Drag an element to another target or by an offset.",
            schema: drag_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "clear",
            description: "Empty an input, firing the same events as fill.",
            schema: target_schema,
            read_only: false,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "route",
            description: "Shape what the page's own fetch and XHR requests receive, without a real backend.                           Rules match a URL glob in registration order, first match wins.",
            schema: route_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "dialog",
            description: "Inspect or set how modal dialogs (alert/confirm/prompt) are answered. \
                          The policy is standing, not per-dialog, and defaults to dismiss.",
            schema: dialog_schema,
            read_only: false,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "set_input_files",
            description: "Attach local files to an <input type=\"file\">. An empty list clears the selection.",
            schema: set_input_files_schema,
            read_only: false,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "native_dialog",
            description: "Answer the dialog plugin's native open, save and message dialogs in advance, since nothing \
                          can click an operating-system dialog. Set the policy before the action that opens one. \
                          The default, manual, leaves them on screen.",
            schema: native_dialog_schema,
            read_only: false,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "event",
            description: "Tauri events. emit delivers one to the application, as its backend would; listen starts \
                          recording an event the application emits, and list shows what was recorded.",
            schema: event_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "downloads",
            description: "The files a webview downloads. wait answers with a finished download no earlier wait \
                          answered with, and the path it was saved to; it may be called after the action that \
                          downloads. One nobody waited for answers the next wait: clear first to start fresh. On CEF call set_directory first. Available where the application \
                          passes Hasgard's observer to its download hook.",
            schema: downloads_schema,
            read_only: false,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "clipboard",
            description: "Read or write the system clipboard's text, to check a copy action or prepare a paste. \
                          The clipboard is shared with the user of the machine.",
            schema: clipboard_schema,
            read_only: false,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "cookies",
            description: "Read, set or delete cookies in the webview's own store, HttpOnly cookies included. \
                          Use it to start signed in or to assert on a session cookie.",
            schema: cookies_schema,
            read_only: false,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "window",
            description: "Read or change the native window: state, resize, move, minimize, maximize, restore, close. \
                          Sizes and positions are logical pixels.",
            schema: window_schema,
            read_only: false,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "wheel",
            description: "Scroll by wheel, letting the page cancel it as a real wheel would. \
                          Omit target to scroll the page.",
            schema: wheel_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "drop",
            description: "Drop one or more local files on an element target.",
            schema: drop_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "eval",
            description: "Evaluate JavaScript in the WebView context.",
            schema: eval_schema,
            read_only: false,
            destructive: true,
            idempotent: false,
        },
        ToolSpec {
            name: "fill",
            description: "Clear and fill an input target with a value.",
            schema: fill_schema,
            read_only: false,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "focus",
            description: "Give keyboard focus to an element target.",
            schema: target_schema,
            read_only: false,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "forms",
            description: "Dump all form fields in the webview document or inside a selector.",
            schema: selector_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "hover",
            description: "Move the pointer over an element target.",
            schema: target_schema,
            read_only: false,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "html",
            description: "Get inner HTML for an element target, or the full webview document if target is omitted.",
            schema: optional_target_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "ipc",
            description: "Invoke a Tauri IPC command with optional JSON arguments.",
            schema: ipc_schema,
            read_only: false,
            destructive: true,
            idempotent: false,
        },
        ToolSpec {
            name: "logs",
            description: "Read or clear captured console logs.",
            schema: logs_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "navigate",
            description: "Navigate the WebView to a URL.",
            schema: navigate_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "network",
            description: "Read or clear captured network requests.",
            schema: network_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "ping",
            description: "Check connectivity with the running Tauri app.",
            schema: empty_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "press",
            description: "Press a keyboard key.",
            schema: press_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "query",
            description: "Find elements by text, label, placeholder, test id, alt, or title. Matches against the \
                          live DOM, so each naming source is searchable independently rather than through the \
                          single collapsed `name` a snapshot reports.",
            schema: query_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "heap_snapshot",
            description: "Write a JavaScript heap snapshot of the target webview after a full GC: JavaScriptCore inspector JSON on macOS, V8 .heapsnapshot on Windows.",
            schema: heap_snapshot_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "video_start",
            description: "Start bounded native window MP4 recording on macOS; requires ffmpeg and Screen Recording permission.",
            schema: video_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "video_stop",
            description: "Stop recording and return the published MP4; propagates capture/encoder failures.",
            schema: empty_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "video_status",
            description: "Read native video session status.",
            schema: empty_schema,
            read_only: true,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "record_start",
            description: "Start recording app interactions.",
            schema: empty_schema,
            read_only: false,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "record_status",
            description: "Get recorder status.",
            schema: empty_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "record_stop",
            description: "Stop recording and return recorded entries.",
            schema: empty_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "run_scenario",
            description: "Run TOML scenario steps against this application; failures are tool errors. No [connect] overrides.",
            schema: scenario_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "replay",
            description: "Replay or export a recorded tauri-hasgard session file.",
            schema: replay_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "screenshot",
            description: "Capture the full webview document or an element selector. Returns the PNG as image content.",
            schema: selector_schema,
            read_only: true,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "screenshot_native",
            description: "Write a PNG of rendered pixels to `output_path`: the routed webview via WebKit when `window_id` is omitted, or the on-screen window with that id. Returns path + metadata; never inlines bytes.",
            schema: hasgard_screenshot_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "scroll",
            description: "Scroll the webview document or an element ref.",
            schema: scroll_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "select",
            description: "Select an option in a select element, or a set of options in a multiple one.",
            schema: select_schema,
            read_only: false,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "snapshot",
            description: "Capture an accessibility snapshot of the WebView.",
            schema: snapshot_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "state",
            description: "Get webview URL, title, viewport, and scroll state.",
            schema: empty_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "storage_clear",
            description: "Clear localStorage or sessionStorage.",
            schema: session_schema,
            read_only: false,
            destructive: true,
            idempotent: true,
        },
        ToolSpec {
            name: "storage_get",
            description: "Read a localStorage or sessionStorage key.",
            schema: storage_get_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "storage_list",
            description: "List localStorage or sessionStorage entries.",
            schema: session_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "storage_set",
            description: "Set a localStorage or sessionStorage key.",
            schema: storage_set_schema,
            read_only: false,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "text",
            description: "Get text content for an element target.",
            schema: target_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "title",
            description: "Get the current webview title.",
            schema: empty_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "type",
            description: "Type text into an element target without clearing it first.",
            schema: type_schema,
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "url",
            description: "Get the current webview URL.",
            schema: empty_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "value",
            description: "Get an input, textarea, or select value.",
            schema: target_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "wait",
            description: "Wait for an element or condition.",
            schema: wait_schema,
            read_only: true,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "watch",
            description: "Watch for DOM mutations until the webview document is stable.",
            schema: watch_schema,
            read_only: true,
            destructive: false,
            idempotent: false,
        },
        ToolSpec {
            name: "windows",
            description: "List all open Tauri windows.",
            schema: global_empty_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "assert_checked",
            description: "Assert that a checkbox or radio target is checked.",
            schema: target_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "assert_contains",
            description: "Assert that target text contains a substring.",
            schema: expected_target_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "assert_count",
            description: "Assert the number of elements matching a selector.",
            schema: assert_count_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "assert_hidden",
            description: "Assert that an element target is hidden.",
            schema: target_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "assert_text",
            description: "Assert exact text content for an element target.",
            schema: expected_target_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "assert_url",
            description: "Assert that the current URL contains a substring.",
            schema: expected_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "assert_value",
            description: "Assert an input, textarea, or select value.",
            schema: expected_target_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        ToolSpec {
            name: "assert_visible",
            description: "Assert that an element target is visible.",
            schema: target_schema,
            read_only: true,
            destructive: false,
            idempotent: true,
        },
    ]
}

/// Tools whose bridge operation resolves inside a frame and whose own schema
/// does not already declare `frame`. Listed, not blanket-applied: a tool that
/// ignored the chain would answer from the top document without saying so.
const FRAME_SCOPED_TOOLS: &[&str] = &[
    "snapshot",
    "diff",
    "screenshot",
    "query",
    "fill",
    "type",
    "select",
    "check",
    "drop",
    "set_input_files",
    "text",
    "html",
    "value",
    "attrs",
    "focus",
    "blur",
    "disabled",
    "bounding_box",
    "visible",
    "checked",
    "count",
    "scroll",
    "wheel",
    "drag",
    "wait",
    "assert_text",
    "assert_contains",
    "assert_visible",
    "assert_hidden",
    "assert_value",
    "assert_count",
    "assert_checked",
];

fn frame_prop() -> Value {
    json!({
        "type": "array",
        "items": {"type": "string"},
        "description": "Scope to a same-origin iframe: one CSS selector per nesting level, outermost first. Cross-origin frames are unreachable.",
    })
}

fn with_frame_property(schema: &JsonObject) -> Arc<JsonObject> {
    let mut schema = schema.clone();
    if let Some(Value::Object(properties)) = schema.get_mut("properties") {
        properties.insert("frame".to_owned(), frame_prop());
    }
    Arc::new(schema)
}

fn cached_tools(dangerous: bool) -> &'static Vec<Tool> {
    static SAFE: OnceLock<Vec<Tool>> = OnceLock::new();
    static ALL: OnceLock<Vec<Tool>> = OnceLock::new();
    if dangerous {
        ALL.get_or_init(|| build_tools_with_flag(true))
    } else {
        SAFE.get_or_init(|| build_tools_with_flag(false))
    }
}

fn build_tools_with_flag(enable_dangerous_tools: bool) -> Vec<Tool> {
    let mut specs = tool_specs();
    if !enable_dangerous_tools {
        specs.retain(|spec| !DANGEROUS_MCP_TOOLS.contains(&spec.name));
    }
    specs.sort_by_key(|spec| spec.name);
    specs
        .into_iter()
        .map(|spec| {
            let schema = if FRAME_SCOPED_TOOLS.contains(&spec.name) {
                with_frame_property(&(spec.schema)())
            } else {
                (spec.schema)()
            };
            Tool::new(namespaced_tool_name(spec.name), spec.description, schema).with_annotations(
                ToolAnnotations::new()
                    .read_only(spec.read_only)
                    .destructive(spec.destructive)
                    .idempotent(spec.idempotent)
                    .open_world(false),
            )
        })
        .collect()
}

fn tool_success(result: Value) -> CallToolResult {
    let mut payload = Map::new();
    payload.insert("result".to_owned(), result);
    CallToolResult::structured(Value::Object(payload))
}

/// The `screenshot` result as image content.
///
/// The plugin answers with a PNG data URL. Handing that string to a model as
/// text gives it megabytes of base64 it cannot look at; image content is what
/// an MCP client renders and a model sees.
fn image_content(result: &Value) -> anyhow::Result<ContentBlock> {
    const PNG_DATA_URL: &str = "data:image/png;base64,";
    let data = result
        .as_str()
        .and_then(|url| url.strip_prefix(PNG_DATA_URL))
        .ok_or_else(|| anyhow::anyhow!("screenshot result is not a PNG data URL"))?;
    Ok(ContentBlock::image(data, "image/png"))
}

fn tool_error(err: &anyhow::Error) -> CallToolResult {
    if let Some(failure) = err.downcast_ref::<crate::client::RpcFailure>() {
        return CallToolResult::structured_error(json!({ "error": err.to_string(), "rpcError": failure.0 }));
    }
    tool_error_msg(err.to_string())
}

fn tool_error_msg(message: impl Into<String>) -> CallToolResult {
    CallToolResult::structured_error(json!({ "error": message.into() }))
}

fn invalid_params(message: impl Into<String>) -> McpError {
    McpError::invalid_params(message.into(), None)
}

fn required_string(args: &JsonObject, name: &str) -> Result<String, McpError> {
    args.get(name)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| invalid_params(format!("'{name}' is required and must be a string")))
}

fn optional_string(args: &JsonObject, name: &str) -> Result<Option<String>, McpError> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(invalid_params(format!("'{name}' must be a string"))),
    }
}

fn required_u64(args: &JsonObject, name: &str) -> Result<u64, McpError> {
    args.get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid_params(format!("'{name}' is required and must be an integer")))
}

fn optional_u64(args: &JsonObject, name: &str) -> Result<Option<u64>, McpError> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or_else(|| invalid_params(format!("'{name}' must be an integer"))),
    }
}

fn optional_u32(args: &JsonObject, name: &str) -> Result<Option<u32>, McpError> {
    optional_u64(args, name)?
        .map(|value| u32::try_from(value).map_err(|_| invalid_params(format!("'{name}' is out of range for u32"))))
        .transpose()
}

fn optional_usize(args: &JsonObject, name: &str) -> Result<Option<usize>, McpError> {
    optional_u64(args, name)?
        .map(|value| usize::try_from(value).map_err(|_| invalid_params(format!("'{name}' is out of range for usize"))))
        .transpose()
}

fn optional_u8(args: &JsonObject, name: &str) -> Result<Option<u8>, McpError> {
    match optional_u64(args, name)? {
        Some(value) => {
            u8::try_from(value).map(Some).map_err(|_| invalid_params(format!("'{name}' is out of range for u8")))
        }
        None => Ok(None),
    }
}

fn optional_number(args: &JsonObject, name: &str) -> Result<Option<f64>, McpError> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_f64().map(Some).ok_or_else(|| invalid_params(format!("'{name}' must be a number"))),
    }
}

fn optional_bool(args: &JsonObject, name: &str) -> Result<Option<bool>, McpError> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_bool().map(Some).ok_or_else(|| invalid_params(format!("'{name}' must be a boolean"))),
    }
}

fn optional_ref(args: &JsonObject) -> Result<Option<String>, McpError> {
    match optional_string(args, "ref")? {
        Some(value) => Ok(Some(value.trim_start_matches('@').to_owned())),
        None => Ok(None),
    }
}

fn required_string_array(args: &JsonObject, name: &str) -> Result<Vec<String>, McpError> {
    let values = args
        .get(name)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_params(format!("'{name}' is required and must be an array")))?;
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| invalid_params(format!("'{name}' must contain only strings")))
        })
        .collect()
}

/// Read the optional frame chain shared by every element-targeting tool.
///
/// Rejected here rather than in the webview so a model gets a message about its
/// own argument, and so an empty array never reaches the bridge as a chain of
/// length zero.
fn optional_frame(args: &JsonObject) -> Result<Option<Vec<String>>, McpError> {
    let Some(raw) = args.get("frame") else { return Ok(None) };
    let values = raw.as_array().ok_or_else(|| invalid_params("'frame' must be an array of CSS selectors"))?;
    if values.is_empty() {
        return Ok(None);
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|selector| !selector.is_empty())
                .map(ToOwned::to_owned)
                .ok_or_else(|| invalid_params("'frame' must contain only non-empty CSS selectors"))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

/// Target params carrying the call's frame scope, for tools that resolve an element.
fn scoped_target(target: &str, args: &JsonObject) -> Result<Value, McpError> {
    let mut params = target_params(target);
    insert_optional_frame(&mut params, args)?;
    Ok(params)
}

fn insert_optional_frame(params: &mut Value, args: &JsonObject) -> Result<(), McpError> {
    if let Some(frame) = optional_frame(args)? {
        params["frame"] = json!(frame);
    }
    Ok(())
}

const CLICK_MODIFIERS: [&str; 4] = ["Alt", "Control", "Meta", "Shift"];
const CLICK_BUTTONS: [&str; 3] = ["left", "middle", "right"];

/// Build `click` params from MCP arguments.
///
/// Enumerated values are checked here rather than left to the bridge: a model
/// that guesses "Cmd" or "primary" gets a message naming the accepted set,
/// instead of a JavaScript error relayed from inside the webview.
fn click_params_from_args(args: &JsonObject) -> Result<Value, McpError> {
    let mut params = target_params(&required_string(args, "target")?);

    if let Some(raw) = args.get("modifiers") {
        let values = raw.as_array().ok_or_else(|| invalid_params("'modifiers' must be an array"))?;
        let mut modifiers = Vec::with_capacity(values.len());
        for value in values {
            let name = value.as_str().ok_or_else(|| invalid_params("'modifiers' must contain only strings"))?;
            if !CLICK_MODIFIERS.contains(&name) {
                return Err(invalid_params(format!("unknown modifier '{name}'; expected one of {CLICK_MODIFIERS:?}")));
            }
            modifiers.push(name);
        }
        if !modifiers.is_empty() {
            params["modifiers"] = json!(modifiers);
        }
    }

    if let Some(button) = optional_string(args, "button")? {
        if !CLICK_BUTTONS.contains(&button.as_str()) {
            return Err(invalid_params(format!("unknown button '{button}'; expected one of {CLICK_BUTTONS:?}")));
        }
        params["button"] = json!(button);
    }

    if let Some(count) = optional_u32(args, "clickCount")? {
        if count == 0 {
            return Err(invalid_params("'clickCount' must be at least 1"));
        }
        params["clickCount"] = json!(count);
    }

    insert_optional_frame(&mut params, args)?;

    if let Some(raw) = args.get("position") {
        let position = raw.as_object().ok_or_else(|| invalid_params("'position' must be an object"))?;
        let axis = |name: &str| {
            position
                .get(name)
                .and_then(Value::as_f64)
                .ok_or_else(|| invalid_params(format!("'position.{name}' is required and must be a number")))
        };
        params["position"] = json!({"x": axis("x")?, "y": axis("y")?});
    }

    Ok(params)
}

fn insert_optional_string(params: &mut Map<String, Value>, args: &JsonObject, name: &str) -> Result<(), McpError> {
    if let Some(value) = optional_string(args, name)? {
        params.insert(name.to_owned(), json!(value));
    }
    Ok(())
}

fn insert_optional_usize(params: &mut Map<String, Value>, args: &JsonObject, name: &str) -> Result<(), McpError> {
    if let Some(value) = optional_usize(args, name)? {
        params.insert(name.to_owned(), json!(value));
    }
    Ok(())
}

fn empty_schema() -> Arc<JsonObject> {
    object_schema(Map::new(), &[])
}

fn global_empty_schema() -> Arc<JsonObject> {
    let mut schema = Map::new();
    schema.insert("type".to_owned(), json!("object"));
    schema.insert("properties".to_owned(), Value::Object(Map::new()));
    schema.insert("additionalProperties".to_owned(), json!(false));
    Arc::new(schema)
}

fn target_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("target", string_prop("Element ref, CSS selector, or x,y coordinates.")),
            (
                "frame",
                json!({
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Scope to a same-origin iframe: one CSS selector per nesting level, outermost first. Cross-origin frames are unreachable.",
                }),
            ),
        ]),
        &["target"],
    )
}

fn click_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("target", string_prop("Element ref, CSS selector, or x,y coordinates.")),
            (
                "modifiers",
                json!({
                    "type": "array",
                    "items": {"type": "string", "enum": ["Alt", "Control", "Meta", "Shift"]},
                    "description": "Modifiers held for the whole gesture. Meta is Command on macOS.",
                }),
            ),
            (
                "button",
                enum_prop(
                    "Which button. right raises contextmenu and middle raises auxclick; neither raises click.",
                    &["left", "middle", "right"],
                ),
            ),
            ("clickCount", integer_prop("Presses in one gesture. 2 also raises a single dblclick.")),
            (
                "frame",
                json!({
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Scope to a same-origin iframe: one CSS selector per nesting level, outermost first. Cross-origin frames are unreachable.",
                }),
            ),
            (
                "position",
                json!({
                    "type": "object",
                    "properties": {"x": {"type": "number"}, "y": {"type": "number"}},
                    "required": ["x", "y"],
                    "additionalProperties": false,
                    "description": "Offset from the element's top-left corner. Defaults to its centre.",
                }),
            ),
        ]),
        &["target"],
    )
}

fn query_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            (
                "by",
                string_prop(
                    "Dimension to match: text, label, placeholder, testid, alt, title, or role. \
                     role reports what a snapshot would for that role without resetting snapshot refs.",
                ),
            ),
            ("value", string_prop("Value to match against the chosen dimension; the role itself for by: role.")),
            (
                "name",
                string_prop(
                    "With by: role, keep elements whose accessible name contains this text (case-sensitive), \
                     or equals it with exact.",
                ),
            ),
            ("exact", bool_prop("Require a full, case-sensitive match. Test ids are always exact regardless.")),
        ]),
        &["by", "value"],
    )
}

fn check_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("target", string_prop("Element ref, CSS selector, or x,y coordinates.")),
            (
                "checked",
                bool_prop("Drive the box to this state instead of toggling. Idempotent, so a retry cannot invert it."),
            ),
        ]),
        &["target"],
    )
}

fn optional_target_schema() -> Arc<JsonObject> {
    object_schema(props([("target", string_prop("Optional element ref, CSS selector, or x,y coordinates."))]), &[])
}

fn expected_schema() -> Arc<JsonObject> {
    object_schema(props([("expected", string_prop("Expected value or substring."))]), &["expected"])
}

fn expected_target_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("target", string_prop("Element ref, CSS selector, or x,y coordinates.")),
            ("expected", string_prop("Expected value or substring.")),
        ]),
        &["target", "expected"],
    )
}

fn snapshot_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("interactive", bool_prop("Only include interactive elements.")),
            ("selector", string_prop("CSS selector to scope the snapshot.")),
            ("depth", integer_prop("Maximum traversal depth.")),
        ]),
        &[],
    )
}

fn diff_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("interactive", bool_prop("Only include interactive elements.")),
            ("selector", string_prop("CSS selector to scope the new snapshot.")),
            ("depth", integer_prop("Maximum traversal depth.")),
            ("reference", any_prop("Optional prior snapshot object to compare against.")),
        ]),
        &[],
    )
}

fn fill_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("target", string_prop("Element ref, CSS selector, or x,y coordinates.")),
            ("value", string_prop("Value to set.")),
        ]),
        &["target", "value"],
    )
}

fn select_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("target", string_prop("Element ref, CSS selector, or x,y coordinates.")),
            ("value", string_prop("The option to select, by its value or visible label.")),
            (
                "values",
                json!({
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "For a multiple select: exactly this set becomes selected. Use instead of value.",
                }),
            ),
        ]),
        &["target"],
    )
}

fn type_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("target", string_prop("Element ref, CSS selector, or x,y coordinates.")),
            ("text", string_prop("Text to type.")),
        ]),
        &["target", "text"],
    )
}

fn press_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("key", string_prop("Native keyboard key to press; respects the active input method.")),
            (
                "completion",
                enum_prop(
                    "webview waits for trusted keyup (default); native confirms OS posting only for native shortcuts or navigation.",
                    &["webview", "native"],
                ),
            ),
            (
                "wait_for",
                string_prop("JavaScript postcondition to await before another native press may focus a window."),
            ),
            ("timeout", integer_prop("Postcondition timeout in milliseconds; requires wait_for.")),
        ]),
        &["key"],
    )
}

fn scroll_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("direction", enum_prop("Direction to scroll.", &["up", "down", "left", "right", "top", "bottom"])),
            ("amount", number_prop("Pixels to scroll. 300 when omitted.")),
            ("ref", string_prop("Optional element ref, with or without @.")),
            ("target", string_prop("Scroll this element instead of the document: ref, CSS selector, or x,y.")),
        ]),
        &[],
    )
}

fn count_schema() -> Arc<JsonObject> {
    object_schema(props([("selector", string_prop("CSS selector to count matches of."))]), &["selector"])
}

fn drag_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("source", string_prop("Source element ref, selector, or coordinates.")),
            ("target", string_prop("Destination element ref, selector, or coordinates.")),
            ("offset", any_prop("Optional offset object such as {\"x\": 0, \"y\": 100}.")),
        ]),
        &["source"],
    )
}

fn drop_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("target", string_prop("Drop target ref, selector, or coordinates.")),
            ("files", array_string_prop("Local file paths to drop.")),
        ]),
        &["target", "files"],
    )
}

fn set_input_files_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("target", string_prop("The <input type=\"file\"> ref, selector, or coordinates.")),
            ("files", array_string_prop("Local file paths to attach. Empty clears the selection.")),
        ]),
        &["target", "files"],
    )
}

fn wheel_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("target", string_prop("Scrollport ref or selector. Omit to scroll the page.")),
            ("delta_x", number_prop("Horizontal scroll delta in pixels.")),
            ("delta_y", number_prop("Vertical scroll delta in pixels.")),
        ]),
        &[],
    )
}

fn dialog_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("action", string_prop("One of: accept, dismiss, list, clear.")),
            ("prompt_text", string_prop("Text submitted to a prompt when action is accept.")),
        ]),
        &["action"],
    )
}

fn native_dialog_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            (
                "action",
                enum_prop(
                    "accept and dismiss answer every later native dialog; manual stops answering; \
                     list shows what was answered; clear forgets the record.",
                    &["accept", "dismiss", "manual", "list", "clear"],
                ),
            ),
            (
                "paths",
                json!({
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "For accept: what an open or save dialog returns. Several for an open dialog that allows them.",
                }),
            ),
            ("button", string_prop("For accept: the message dialog button to press, by its label.")),
        ]),
        &["action"],
    )
}

fn event_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("action", enum_prop("What to do.", &["emit", "listen", "unlisten", "list", "clear"])),
            ("event", string_prop("Event name. Required for emit, listen and unlisten; a filter for list.")),
            ("payload", json!({"description": "For emit: the payload, any JSON value."})),
            ("since_id", integer_prop("For list: only events recorded after this id.")),
        ]),
        &["action"],
    )
}

fn downloads_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("action", enum_prop("What to do.", &["list", "wait", "set_directory", "clear"])),
            ("timeout", integer_prop("For wait: how long, in milliseconds. Defaults to 10000.")),
            ("since_id", integer_prop("For wait: only a download started after this id.")),
            ("path", string_prop("For set_directory: an absolute directory for later downloads. Omit to reset.")),
        ]),
        &["action"],
    )
}

fn clipboard_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            (
                "action",
                enum_prop("read returns the text, or null when there is none; write replaces it.", &["read", "write"]),
            ),
            ("text", string_prop("Text to place on the clipboard, for write.")),
        ]),
        &["action"],
    )
}

fn cookies_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("action", enum_prop("get lists, set writes one cookie, clear deletes.", &["get", "set", "clear"])),
            ("name", string_prop("Cookie name: required for set, a filter for get and clear.")),
            ("value", string_prop("Cookie value, for set.")),
            (
                "url",
                string_prop(
                    "For set, supplies the domain, the path / and secure for https. \
                     For get and clear, limits to the cookies a request to this URL would carry.",
                ),
            ),
            ("domain", string_prop("Cookie domain: for set when no url is given, a filter for clear.")),
            ("path", string_prop("Cookie path for set. Defaults to /.")),
            (
                "expires",
                integer_prop("Expiry for set, in seconds since the Unix epoch. A session cookie when omitted."),
            ),
            ("http_only", bool_prop("Hide the cookie from page script, for set.")),
            ("secure", bool_prop("Send only over https, for set. Defaults to true for an https url.")),
            ("same_site", enum_prop("SameSite policy for set.", &["Strict", "Lax", "None"])),
        ]),
        &["action"],
    )
}

fn window_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            (
                "action",
                enum_prop(
                    "state reports position, size and flags; the others change the window and report its state.",
                    &["state", "resize", "move", "minimize", "maximize", "restore", "close"],
                ),
            ),
            ("width", number_prop("Content width for resize.")),
            ("height", number_prop("Content height for resize.")),
            ("x", number_prop("Left edge for move, from the screen origin.")),
            ("y", number_prop("Top edge for move, from the screen origin.")),
        ]),
        &["action"],
    )
}

fn route_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("action", enum_prop("What to do.", &["fulfill", "abort", "list", "clear"])),
            (
                "pattern",
                string_prop(
                    "URL glob, required for fulfill and abort. `*` stays inside one path segment, \
                     `**` crosses separators, and the pattern must match the whole URL.",
                ),
            ),
            ("status", integer_prop("HTTP status for fulfill. Defaults to 200.")),
            ("body", string_prop("Response body for fulfill.")),
            ("content_type", string_prop("Response content type for fulfill. Defaults to text/plain.")),
            ("method", string_prop("Restrict to one HTTP verb. Any verb matches when omitted.")),
            ("times", integer_prop("Stop matching after this many requests, letting later ones through.")),
        ]),
        &["action"],
    )
}

fn eval_schema() -> Arc<JsonObject> {
    object_schema(props([("script", string_prop("JavaScript to evaluate."))]), &["script"])
}

fn ipc_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("command", string_prop("Tauri IPC command name.")),
            ("args", any_prop("Optional JSON object of command arguments.")),
        ]),
        &["command"],
    )
}

fn hasgard_screenshot_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            (
                "window_id",
                json!({
                    "type": "integer",
                    "minimum": 0,
                    "maximum": u32::MAX,
                    "description": "Native window id (e.g. `CGWindowID` on macOS) to capture a whole window. Omit to render the routed webview through WebKit (exact pixels, scrolled content included, no screen-recording permission). Must fit in u32.",
                }),
            ),
            (
                "output_path",
                string_prop(
                    "Absolute path where the PNG is written. The parent directory must already exist; the file is written atomically via a temp + rename.",
                ),
            ),
            ("format", enum_prop("Image format. v1 accepts only \"png\".", &["png"])),
        ]),
        &["output_path"],
    )
}

fn selector_schema() -> Arc<JsonObject> {
    object_schema(props([("selector", string_prop("Optional CSS selector."))]), &[])
}

fn navigate_schema() -> Arc<JsonObject> {
    object_schema(props([("url", string_prop("URL to navigate to."))]), &["url"])
}

fn wait_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("target", string_prop("Element ref, CSS selector, or x,y coordinates.")),
            ("selector", string_prop("CSS selector to wait for.")),
            (
                "expression",
                string_prop(
                    "JavaScript expression to poll until it returns a truthy value, which is then returned. \
                     Catches conditions that flip without a DOM mutation. Cannot be combined with selector or gone.",
                ),
            ),
            ("poll", integer_prop("How often to re-evaluate `expression`, in milliseconds.")),
            ("gone", bool_prop("Wait for the element to disappear.")),
            (
                "url",
                string_prop(
                    "Wait until the window is at this URL instead of waiting for an element. A glob: `*` stays within \
                     a path segment, `**` crosses them. Holds across the navigation that gets there.",
                ),
            ),
            ("load", string_prop("Wait for a load state: load or domcontentloaded. Combines with url.")),
            ("timeout", integer_prop("Timeout in milliseconds.")),
        ]),
        &[],
    )
}

fn watch_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("selector", string_prop("CSS selector to scope observation.")),
            ("timeout", integer_prop("Timeout in milliseconds.")),
            ("stable", integer_prop("Stability window in milliseconds.")),
            (
                "require_mutation",
                bool_prop(
                    "Defer the stability timer until at least one DOM mutation occurs. \
                     Rejects on timeout when nothing changed.",
                ),
            ),
        ]),
        &[],
    )
}

fn logs_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("level", enum_prop("Optional log level filter.", &["log", "info", "warn", "error"])),
            ("last", integer_prop("Return only the last N log entries.")),
            ("clear", bool_prop("Clear the log buffer instead of reading it.")),
        ]),
        &[],
    )
}

fn network_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("filter", string_prop("Optional URL substring filter.")),
            ("failed", bool_prop("Only return failed requests.")),
            ("last", integer_prop("Return only the last N requests.")),
            ("clear", bool_prop("Clear the request buffer instead of reading it.")),
        ]),
        &[],
    )
}

fn session_schema() -> Arc<JsonObject> {
    object_schema(props([("session", bool_prop("Use sessionStorage instead of localStorage."))]), &[])
}

fn storage_get_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("key", string_prop("Storage key.")),
            ("session", bool_prop("Use sessionStorage instead of localStorage.")),
        ]),
        &["key"],
    )
}

fn storage_set_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("key", string_prop("Storage key.")),
            ("value", string_prop("Storage value.")),
            ("session", bool_prop("Use sessionStorage instead of localStorage.")),
        ]),
        &["key", "value"],
    )
}

fn assert_count_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("selector", string_prop("CSS selector to count.")),
            ("expected", integer_prop("Expected element count.")),
        ]),
        &["selector", "expected"],
    )
}

fn video_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("output_path", string_prop("Absolute .mp4 output path; must not exist.")),
            ("fps", json!({"type":"integer","minimum":1,"maximum":10})),
            ("max_duration_ms", json!({"type":"integer","minimum":100,"maximum":60000})),
        ]),
        &["output_path"],
    )
}

fn heap_snapshot_schema() -> Arc<JsonObject> {
    object_schema(
        props([("output_path", string_prop("Absolute output path; its directory must exist. Replaced if present."))]),
        &["output_path"],
    )
}

fn scenario_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("toml", string_prop("TOML scenario with one or more [[step]] entries.")),
            ("fail_fast", json!({"type":"boolean","description":"Override scenario fail_fast."})),
        ]),
        &["toml"],
    )
}

fn replay_schema() -> Arc<JsonObject> {
    object_schema(
        props([
            ("path", string_prop("Path to a recording JSON file.")),
            ("export", enum_prop("Export format instead of replaying.", &["sh"])),
        ]),
        &["path"],
    )
}

fn object_schema(mut properties: Map<String, Value>, required: &[&str]) -> Arc<JsonObject> {
    properties
        .insert("window".to_owned(), string_prop("Optional Tauri window label overriding the MCP server default."));
    let mut schema = Map::new();
    schema.insert("type".to_owned(), json!("object"));
    schema.insert("properties".to_owned(), Value::Object(properties));
    if !required.is_empty() {
        schema.insert("required".to_owned(), json!(required));
    }
    schema.insert("additionalProperties".to_owned(), json!(false));
    Arc::new(schema)
}

fn props<const N: usize>(properties: [(&str, Value); N]) -> Map<String, Value> {
    properties.into_iter().map(|(name, schema)| (name.to_owned(), schema)).collect()
}

fn string_prop(description: &str) -> Value {
    json!({"type": "string", "description": description})
}

fn bool_prop(description: &str) -> Value {
    json!({"type": "boolean", "description": description})
}

fn integer_prop(description: &str) -> Value {
    json!({"type": "integer", "description": description})
}

fn number_prop(description: &str) -> Value {
    json!({"type": "number", "description": description})
}

fn array_string_prop(description: &str) -> Value {
    json!({"type": "array", "items": {"type": "string"}, "description": description})
}

fn any_prop(description: &str) -> Value {
    json!({"description": description})
}

fn enum_prop(description: &str, values: &[&str]) -> Value {
    json!({"type": "string", "enum": values, "description": description})
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn in_process_server_routes_tools_to_the_host_function() {
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = calls.clone();
        let server = HasgardMcpServer::in_process(
            move |method, params| {
                log.lock().expect("log").push((method.clone(), params));
                async move {
                    if method == "state" {
                        Ok(json!({"url": "tauri://localhost"}))
                    } else {
                        Err(RpcError { code: -32601, message: format!("{method} unavailable"), data: None })
                    }
                }
            },
            Some("main".to_owned()),
        )
        .with_dangerous_tools(false);

        let state = server.call_tool_by_name("hasgard.state", JsonObject::new()).await.expect("state");
        assert_eq!(state.structured_content, Some(json!({"result": {"url": "tauri://localhost"}})));
        // The default window is applied, and an explicit one overrides it.
        let args = json!({"window": "settings"}).as_object().expect("object").clone();
        let failed = server.call_tool_by_name("title", args).await.expect("title");
        assert_eq!(failed.is_error, Some(true));
        assert_eq!(
            failed.structured_content.expect("content")["rpcError"],
            json!({"code": -32601, "message": "title unavailable"})
        );
        assert_eq!(
            *calls.lock().expect("log"),
            [("state".to_owned(), json!({"window": "main"})), ("title".to_owned(), json!({"window": "settings"}))]
        );
        // Dangerous tools follow the server's own setting, not a process-wide one.
        assert!(server.call_tool_by_name("eval", JsonObject::new()).await.is_err());
        assert!(server.get_tool("eval").is_none());
        assert!(server.with_dangerous_tools(true).get_tool("eval").is_some());
    }

    #[tokio::test]
    async fn a_scenario_or_a_recording_cannot_reach_the_tools_that_are_off() {
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = calls.clone();
        let server = HasgardMcpServer::in_process(
            move |method, _| {
                log.lock().expect("log").push(method);
                async move { Ok(json!({"ok": true})) }
            },
            Some("main".to_owned()),
        )
        .with_dangerous_tools(false);
        for step in ["action = 'ipc'\ncommand = 'quit'", "action = 'eval'\nscript = '1'"] {
            let args = json!({"toml": format!("[[step]]\n{step}")}).as_object().expect("object").clone();
            let refused = server.call_tool_by_name("run_scenario", args).await.expect_err("off by default");
            assert!(refused.message.contains("disabled by default"), "{}", refused.message);
        }
        let recording = std::env::temp_dir().join(format!("hasgard-gate-{}.json", std::process::id()));
        std::fs::write(&recording, r#"[{"action":"eval","timestamp":0,"script":"1"}]"#).expect("write recording");
        let args = json!({"path": recording}).as_object().expect("object").clone();
        let refused = server.call_tool_by_name("replay", args.clone()).await;
        assert!(calls.lock().expect("log").is_empty(), "nothing may reach the application");
        // Turned on, both go through.
        let allowed = server.with_dangerous_tools(true);
        let replayed = allowed.call_tool_by_name("replay", args).await.expect("replay");
        std::fs::remove_file(&recording).expect("remove recording");
        assert!(refused.expect_err("off by default").message.contains("recorded action 'eval'"));
        assert_ne!(replayed.is_error, Some(true), "{replayed:?}");
        let args = json!({"toml": "[[step]]\naction = 'eval'\nscript = '1'"}).as_object().expect("object").clone();
        assert_ne!(allowed.call_tool_by_name("run_scenario", args).await.expect("scenario").is_error, Some(true));
        assert_eq!(*calls.lock().expect("log"), ["eval", "eval"]);
    }

    #[tokio::test]
    async fn a_location_wait_passes_the_frame_on_for_the_application_to_refuse() {
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = calls.clone();
        let server = HasgardMcpServer::in_process(
            move |_, params| {
                log.lock().expect("log").push(params["frame"].clone());
                async move { Ok(json!({"ok": true})) }
            },
            Some("main".to_owned()),
        );
        let args = json!({"load": "load", "frame": ["#pane"]}).as_object().expect("object").clone();
        server.call_tool_by_name("wait", args).await.expect("wait");
        assert_eq!(*calls.lock().expect("log"), [json!(["#pane"])]);
    }

    #[tokio::test]
    async fn the_frame_scope_reaches_every_tool_that_advertises_it() {
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = calls.clone();
        let server = HasgardMcpServer::in_process(
            move |method, params| {
                log.lock().expect("log").push((method.clone(), params["frame"].clone()));
                // Whatever each assertion compares against, so every call completes.
                async move {
                    Ok(match method.as_str() {
                        "text" | "value" => json!("x"),
                        "visible" => json!({"visible": true}),
                        "count" => json!({"count": 1}),
                        _ => json!({"ok": true}),
                    })
                }
            },
            Some("main".to_owned()),
        );
        let frame = json!(["#outer", "#inner"]);
        for (tool, extra) in [
            ("html", json!({})),
            ("scroll", json!({})),
            ("wheel", json!({"delta_y": 10})),
            ("drag", json!({"source": "#a", "target": "#b"})),
            ("wait", json!({"selector": "#a"})),
            ("assert_text", json!({"target": "#a", "expected": "x"})),
            ("assert_value", json!({"target": "#a", "expected": "x"})),
            ("assert_visible", json!({"target": "#a"})),
            ("assert_count", json!({"selector": "#a", "expected": 1})),
        ] {
            let mut arguments = extra.as_object().expect("object").clone();
            arguments.insert("frame".to_owned(), frame.clone());
            let result = server.call_tool_by_name(tool, arguments).await.expect(tool);
            assert_ne!(result.is_error, Some(true), "{tool}: {result:?}");
            let advertised = server.get_tool(tool).expect("listed tool");
            assert!(advertised.input_schema["properties"].get("frame").is_some(), "{tool} must advertise frame");
        }
        for (method, sent) in calls.lock().expect("log").iter() {
            assert_eq!(sent, &frame, "{method} must carry the frame scope");
        }
        assert_eq!(calls.lock().expect("log").len(), 9);
    }

    #[tokio::test]
    async fn scenario_rejects_invalid_input_before_connecting() {
        let server = super::HasgardMcpServer::endpoint(Some(std::path::PathBuf::from("/no-such-application")), None);
        for toml in
            ["", "[[step]]\naction='fill'\ntarget='#x'", "[connect]\nsocket='/another-app'\n[[step]]\naction='wait'"]
        {
            let args = serde_json::json!({"toml":toml}).as_object().expect("object").clone();
            assert!(server.call_tool_by_name("run_scenario", args).await.is_err());
        }
    }

    use super::*;
    #[cfg(unix)]
    use crate::protocol::{Request, Response};
    #[cfg(unix)]
    use serial_test::serial;
    #[cfg(unix)]
    use tokio::net::UnixListener;
    #[cfg(unix)]
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        task::JoinHandle,
    };

    #[test]
    fn tool_list_matches_cli_command_surface() {
        // Validate the complete tool surface; runtime gating of dangerous tools
        // is covered by `dangerous_tools_hidden_by_default` / `dangerous_tools_can_be_enabled`.
        let tools = build_tools_with_flag(true);
        assert!(tools.iter().all(|tool| tool.name.as_ref().starts_with(HASGARD_PREFIX)));
        let names: Vec<&str> = tools.iter().map(|tool| normalize_tool_name(tool.name.as_ref())).collect();
        let expected = vec![
            "assert_checked",
            "assert_contains",
            "assert_count",
            "assert_hidden",
            "assert_text",
            "assert_url",
            "assert_value",
            "assert_visible",
            "attrs",
            "blur",
            "bounding_box",
            "check",
            "checked",
            "clear",
            "click",
            "clipboard",
            "cookies",
            "count",
            "dblclick",
            "dialog",
            "diff",
            "disabled",
            "downloads",
            "drag",
            "drop",
            "eval",
            "event",
            "fill",
            "focus",
            "forms",
            "heap_snapshot",
            "hover",
            "html",
            "ipc",
            "logs",
            "native_dialog",
            "navigate",
            "network",
            "ping",
            "press",
            "query",
            "record_start",
            "record_status",
            "record_stop",
            "replay",
            "route",
            "run_scenario",
            "screenshot",
            "screenshot_native",
            "scroll",
            "select",
            "set_input_files",
            "snapshot",
            "state",
            "storage_clear",
            "storage_get",
            "storage_list",
            "storage_set",
            "text",
            "title",
            "type",
            "url",
            "value",
            "video_start",
            "video_status",
            "video_stop",
            "visible",
            "wait",
            "watch",
            "wheel",
            "window",
            "windows",
        ];
        assert_eq!(names, expected);
    }

    #[test]
    fn tool_name_helpers_are_round_trip_symmetric() {
        assert_eq!(normalize_tool_name("click"), "click");
        assert_eq!(normalize_tool_name("hasgard.click"), "click");
        assert_eq!(namespaced_tool_name("click"), "hasgard.click");
        assert_eq!(namespaced_tool_name("hasgard.click"), "hasgard.click");
    }

    #[test]
    fn tool_name_helpers_handle_corner_cases() {
        // normalize_tool_name: empty, bare prefix, double prefix
        assert_eq!(normalize_tool_name(""), "");
        assert_eq!(normalize_tool_name(HASGARD_PREFIX), "");
        // Single-strip is intentional: a double prefix loses only the outer one.
        assert_eq!(normalize_tool_name("hasgard.hasgard.click"), "hasgard.click");

        // namespaced_tool_name: empty, bare prefix, already-namespaced
        assert_eq!(namespaced_tool_name(""), HASGARD_PREFIX);
        assert_eq!(namespaced_tool_name(HASGARD_PREFIX), HASGARD_PREFIX);
        assert_eq!(namespaced_tool_name("hasgard.click"), "hasgard.click");
    }

    #[test]
    fn get_tool_resolves_bare_and_prefixed_names_to_same_tool() {
        let hasgard = HasgardMcpServer::endpoint(None, None);
        let bare = hasgard.get_tool("click").expect("bare name resolves");
        let prefixed = hasgard.get_tool("hasgard.click").expect("prefixed name resolves");
        assert_eq!(bare.name, prefixed.name);
        assert_eq!(bare.description, prefixed.description);
        assert_eq!(bare.name.as_ref(), "hasgard.click");
    }

    #[test]
    fn schemas_include_window_override() {
        let schema = target_schema();
        let properties = schema.get("properties").and_then(Value::as_object).expect("schema has properties");
        assert!(properties.contains_key("target"));
        assert!(properties.contains_key("window"));
    }

    #[test]
    fn scroll_schema_accepts_top_and_bottom_directions() {
        let schema = scroll_schema();
        let direction = schema
            .get("properties")
            .and_then(Value::as_object)
            .and_then(|p| p.get("direction"))
            .and_then(Value::as_object)
            .expect("scroll schema has direction property");
        let values: Vec<&str> = direction
            .get("enum")
            .and_then(Value::as_array)
            .expect("direction has enum")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(values.len(), 6, "scroll direction enum must have exactly 6 string variants, got {values:?}");
        for expected in ["up", "down", "left", "right", "top", "bottom"] {
            assert!(values.contains(&expected), "scroll direction enum must include {expected}");
        }
    }

    #[test]
    fn hasgard_screenshot_tool_advertises_path_only_contract() {
        let tool = cached_tools(false)
            .iter()
            .find(|t| t.name == "hasgard.screenshot_native")
            .expect("hasgard.screenshot_native tool registered");
        let props = tool.input_schema.get("properties").and_then(Value::as_object).expect("schema has properties");
        for required in ["window_id", "output_path", "format"] {
            assert!(
                props.contains_key(required),
                "hasgard.screenshot_native must advertise `{required}` in its schema"
            );
        }
        let required = tool.input_schema.get("required").and_then(Value::as_array).expect("required list present");
        let required: Vec<&str> = required.iter().filter_map(Value::as_str).collect();
        assert!(
            !required.contains(&"window_id"),
            "hasgard.screenshot_native must resolve `window_id` from the window label rather than demanding it"
        );
        assert!(required.contains(&"output_path"), "hasgard.screenshot_native must require `output_path`");
        // The path-only contract forbids inline byte / base64 fields on either
        // surface — guard against a future revision silently growing one.
        for forbidden in ["bytes", "base64", "data"] {
            assert!(
                !props.contains_key(forbidden),
                "hasgard.screenshot_native must not advertise `{forbidden}` (path-only contract)"
            );
        }
    }

    #[test]
    fn hasgard_screenshot_tool_routes_native_method() {
        // The native contract lives under a distinct name (`screenshot_native`
        // advertised as `hasgard.screenshot_native`) so the existing bridge
        // `screenshot` (html-to-image, base64) keeps working for current
        // CLI/scenario callers. This test pins the surface so a future
        // refactor cannot silently fold the two tools together and resurrect
        // the bytes-inline payload shape.
        let bridge = cached_tools(false)
            .iter()
            .find(|t| t.name == "hasgard.screenshot")
            .expect("bridge hasgard.screenshot tool still registered");
        let native = cached_tools(false)
            .iter()
            .find(|t| t.name == "hasgard.screenshot_native")
            .expect("hasgard.screenshot_native tool registered");
        assert_ne!(
            bridge.input_schema, native.input_schema,
            "bridge `hasgard.screenshot` and native `hasgard.screenshot_native` advertise different schemas"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn hasgard_screenshot_forwards_native_params_to_jsonrpc() {
        let socket =
            std::env::temp_dir().join(format!("tauri-hasgard-mcp-screenshot-native-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket).expect("bind mock socket");
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (reader, mut writer) = stream.into_split();
            let mut reader = BufReader::new(reader);
            let mut line = String::new();
            reader.read_line(&mut line).await.expect("read request");
            let request: Request = serde_json::from_str(line.trim()).expect("parse request");
            assert_eq!(request.method, "screenshot_native");
            let params = request.params.expect("native screenshot params present");
            assert_eq!(params["window_id"], json!(42_u64));
            assert_eq!(params["output_path"], json!("/tmp/out.png"));
            assert_eq!(params["format"], json!("png"));
            let response = Response::success(
                request.id,
                json!({
                    "output_path": "/tmp/out.png",
                    "window_id": 42_u32,
                    "width": 100_u32,
                    "height": 50_u32,
                    "scale_factor": 2.0_f32,
                    "byte_size": 1234_u64,
                    "backend": "screencapture",
                    "tcc_denied": false,
                }),
            );
            let mut bytes = serde_json::to_vec(&response).expect("serialize response");
            bytes.push(b'\n');
            writer.write_all(&bytes).await.expect("write response");
        });

        let hasgard = HasgardMcpServer::endpoint(Some(socket.clone()), None);
        let mut args = Map::new();
        args.insert("window_id".to_owned(), json!(42_u32));
        args.insert("output_path".to_owned(), json!("/tmp/out.png"));
        args.insert("format".to_owned(), json!("png"));
        let result = hasgard.call_tool_by_name("screenshot_native", args).await.expect("tool call succeeds");
        assert_eq!(result.is_error, Some(false));

        server.await.expect("mock server task");
        let _ = std::fs::remove_file(&socket);
    }

    #[test]
    fn windows_schema_omits_window_override() {
        let schema = global_empty_schema();
        let properties = schema.get("properties").and_then(Value::as_object).expect("schema has properties");
        assert!(!properties.contains_key("window"));
    }

    #[test]
    fn startup_banner_explains_stdio_server() {
        let banner = startup_banner(None, Some("main"));

        assert!(banner.contains("tauri-hasgard MCP server"));
        assert!(banner.contains("listening on stdio"));
        assert!(banner.contains("auto-detect on first tool call"));
        assert!(banner.contains("main"));
        assert!(banner.contains("stdout is reserved for MCP JSON-RPC"));
    }

    #[test]
    fn dangerous_tools_hidden_by_default() {
        let tools = build_tools_with_flag(false);
        for dangerous in DANGEROUS_MCP_TOOLS {
            let namespaced = namespaced_tool_name(dangerous);
            assert!(
                !tools.iter().any(|tool| tool.name == namespaced),
                "dangerous tool '{dangerous}' must not be listed unless explicitly enabled"
            );
        }
    }

    #[test]
    fn dangerous_tools_can_be_enabled() {
        let tools = build_tools_with_flag(true);
        for dangerous in DANGEROUS_MCP_TOOLS {
            let namespaced = namespaced_tool_name(dangerous);
            assert!(
                tools.iter().any(|tool| tool.name == namespaced),
                "dangerous tool '{dangerous}' should be listed when explicitly enabled"
            );
        }
    }

    #[tokio::test]
    async fn navigate_rejects_javascript_urls() {
        // Each payload normalizes to `javascript:` once a browser's URL parser
        // strips tab/LF/CR and leading C0 controls/spaces, so the MCP filter
        // must reject them before they reach `window.location.href`.
        let payloads = [
            " javascript:alert(1)",          // leading space
            "JaVaScRiPt:alert(1)",           // mixed case
            "java\tscript:alert(1)",         // embedded tab
            "java\nscript:alert(1)",         // embedded newline
            "java\rscript:alert(1)",         // embedded carriage return
            "\u{0}javascript:alert(1)",      // leading NUL (C0 control)
            "\u{1}\u{2}javascript:alert(1)", // leading C0 controls
        ];

        for payload in payloads {
            let hasgard = HasgardMcpServer::endpoint(None, None);
            let mut args = Map::new();
            args.insert("url".to_owned(), json!(payload));

            // Validation rejects before any socket call, so this surfaces an
            // `Err(McpError)` rather than reaching the app tool.
            let err = hasgard
                .call_tool_by_name("navigate", args)
                .await
                .expect_err(&format!("javascript URL should be rejected: {payload:?}"));
            assert_eq!(err.code, ErrorCode::INVALID_PARAMS, "payload: {payload:?}");
            assert!(
                err.message.contains("does not allow javascript: URLs"),
                "unexpected error message for {payload:?}: {}",
                err.message
            );
        }
    }

    #[test]
    fn validate_navigate_url_allows_safe_urls() {
        // Legitimate schemes and paths that merely contain the substring must
        // not be over-blocked by the prefix check.
        for url in
            ["https://example.com/app", "/relative/path", "https://example.com/javascript:not-a-scheme", "about:blank"]
        {
            validate_navigate_url(url)
                .unwrap_or_else(|err| panic!("safe url wrongly rejected: {url:?} ({})", err.message));
        }
    }

    #[tokio::test]
    async fn replay_export_does_not_connect_to_socket() {
        let recording = std::env::temp_dir().join(format!("tauri-hasgard-mcp-replay-test-{}.json", std::process::id()));
        std::fs::write(&recording, r#"[{"action":"click","timestamp":0,"ref":"e1"}]"#).expect("write recording");

        let missing_socket =
            std::env::temp_dir().join(format!("tauri-hasgard-mcp-missing-{}.sock", std::process::id()));
        let hasgard = HasgardMcpServer::endpoint(Some(missing_socket), None);
        let mut args = Map::new();
        args.insert("path".to_owned(), json!(recording.display().to_string()));
        args.insert("export".to_owned(), json!("sh"));

        let result = hasgard.call_tool_by_name("replay", args).await.expect("tool call succeeds");

        assert_eq!(result.is_error, Some(false));
        let script = result
            .structured_content
            .as_ref()
            .and_then(|content| content.get("result"))
            .and_then(Value::as_str)
            .expect("script result");
        assert!(script.starts_with("#!/bin/bash"));
        assert!(script.contains("tauri-hasgard click '@e1'"));

        let _ = std::fs::remove_file(&recording);
    }

    #[tokio::test]
    #[serial]
    #[cfg(unix)]
    async fn auto_detected_socket_is_pinned_after_first_connection() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::path::PathBuf::from(format!("/tmp/hg-mcp-pin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create socket dir");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("make socket dir private");
        let old_socket = dir.join("tauri-hasgard-old.sock");
        let new_socket = dir.join("tauri-hasgard-new.sock");
        let _ = std::fs::remove_file(&old_socket);
        let _ = std::fs::remove_file(&new_socket);

        let old_server = spawn_click_server(&old_socket, "old", 2);

        // SAFETY: serial attribute serializes tests that touch XDG_RUNTIME_DIR.
        unsafe { std::env::set_var("XDG_RUNTIME_DIR", &dir) };

        let hasgard = HasgardMcpServer::endpoint(None, None);
        let first = call_click(&hasgard).await;
        assert_eq!(tool_result_source(&first), Some("old"));

        let new_server = spawn_click_server(&new_socket, "new", 1);
        let second = call_click(&hasgard).await;
        assert_eq!(tool_result_source(&second), Some("old"));

        unsafe { std::env::remove_var("XDG_RUNTIME_DIR") };
        old_server.await.expect("old mock server task");
        new_server.abort();
        let _ = std::fs::remove_file(&old_socket);
        let _ = std::fs::remove_file(&new_socket);
        let _ = std::fs::remove_dir(&dir);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn click_tool_sends_json_rpc_request() {
        let socket = std::env::temp_dir().join(format!("tauri-hasgard-mcp-click-test-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket).expect("bind mock socket");
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (reader, mut writer) = stream.into_split();
            let mut reader = BufReader::new(reader);
            let mut line = String::new();
            reader.read_line(&mut line).await.expect("read request");
            let request: Request = serde_json::from_str(line.trim()).expect("parse request");
            assert_eq!(request.method, "click");
            assert_eq!(request.params, Some(json!({"ref": "e3"})));
            let mut response =
                serde_json::to_vec(&Response::success(request.id, json!({"ok": true}))).expect("serialize response");
            response.push(b'\n');
            writer.write_all(&response).await.expect("write response");
        });

        let hasgard = HasgardMcpServer::endpoint(Some(socket.clone()), None);
        let mut args = Map::new();
        args.insert("target".to_owned(), json!("@e3"));
        let result = hasgard.call_tool_by_name("click", args).await.expect("tool call succeeds");
        assert_eq!(result.is_error, Some(false));
        assert_eq!(result.structured_content, Some(json!({"result": {"ok": true}})));

        server.await.expect("mock server task");
        let _ = std::fs::remove_file(&socket);
    }

    #[cfg(unix)]
    async fn call_click(hasgard: &HasgardMcpServer) -> CallToolResult {
        let mut args = Map::new();
        args.insert("target".to_owned(), json!("@e3"));
        hasgard.call_tool_by_name("click", args).await.expect("tool call succeeds")
    }

    #[cfg(unix)]
    fn tool_result_source(result: &CallToolResult) -> Option<&str> {
        result
            .structured_content
            .as_ref()
            .and_then(|content| content.get("result"))
            .and_then(|result| result.get("source"))
            .and_then(Value::as_str)
    }

    #[cfg(unix)]
    fn spawn_click_server(socket: &Path, source: &'static str, requests: usize) -> JoinHandle<()> {
        let listener = UnixListener::bind(socket).expect("bind mock socket");
        tokio::spawn(async move {
            for _ in 0..requests {
                let (stream, _) = listener.accept().await.expect("accept");
                let (reader, mut writer) = stream.into_split();
                let mut reader = BufReader::new(reader);
                let mut line = String::new();
                reader.read_line(&mut line).await.expect("read request");
                let request: Request = serde_json::from_str(line.trim()).expect("parse request");
                assert_eq!(request.method, "click");
                let mut response = serde_json::to_vec(&Response::success(request.id, json!({"source": source})))
                    .expect("serialize response");
                response.push(b'\n');
                writer.write_all(&response).await.expect("write response");
            }
        })
    }
}

/// Validation for the `click` tool's enumerated arguments.
///
/// A model guessing "Cmd" or "primary" must be told the accepted set here,
/// where the message is part of the tool contract -- not have the guess relayed
/// into the webview to fail as a JavaScript error the model cannot act on.
#[cfg(test)]
mod click_args_tests {
    use super::*;

    fn args(value: &Value) -> JsonObject {
        value.as_object().cloned().expect("test args must be an object")
    }

    #[test]
    fn a_bare_target_sends_no_option_keys() {
        let params =
            click_params_from_args(&args(&json!({"target": "#save"}))).expect("valid arguments must build params");
        assert_eq!(params, json!({"selector": "#save"}));
    }

    #[test]
    fn every_option_reaches_the_bridge_under_its_wire_name() {
        let params = click_params_from_args(&args(&json!({
            "target": "@e3",
            "modifiers": ["Shift", "Meta"],
            "button": "right",
            "clickCount": 2,
            "position": {"x": 3, "y": 4},
        })))
        .expect("valid arguments must build params");
        assert_eq!(
            params,
            json!({
                "ref": "e3",
                "modifiers": ["Shift", "Meta"],
                "button": "right",
                "clickCount": 2,
                "position": {"x": 3.0, "y": 4.0},
            })
        );
    }

    #[test]
    fn an_unknown_modifier_is_rejected_and_the_message_names_the_accepted_set() {
        let error = click_params_from_args(&args(&json!({"target": "#a", "modifiers": ["Cmd"]})))
            .expect_err("invalid arguments must be rejected");
        let message = format!("{error:?}");
        assert!(message.contains("Cmd"), "must quote the bad value: {message}");
        assert!(message.contains("Shift"), "must list the accepted set: {message}");
    }

    #[test]
    fn an_unknown_button_is_rejected_rather_than_silently_clicking_left() {
        let error = click_params_from_args(&args(&json!({"target": "#a", "button": "primary"})))
            .expect_err("invalid arguments must be rejected");
        assert!(format!("{error:?}").contains("primary"));
    }

    #[test]
    fn a_zero_click_count_is_rejected_rather_than_producing_no_press_at_all() {
        assert!(click_params_from_args(&args(&json!({"target": "#a", "clickCount": 0}))).is_err());
    }

    #[test]
    fn a_non_array_modifiers_value_is_rejected() {
        assert!(click_params_from_args(&args(&json!({"target": "#a", "modifiers": "Shift"}))).is_err());
    }

    #[test]
    fn a_non_string_modifier_is_rejected() {
        assert!(click_params_from_args(&args(&json!({"target": "#a", "modifiers": [1]}))).is_err());
    }

    #[test]
    fn a_half_specified_position_is_rejected_rather_than_defaulting_the_missing_axis() {
        let error = click_params_from_args(&args(&json!({"target": "#a", "position": {"x": 10}})))
            .expect_err("invalid arguments must be rejected");
        assert!(format!("{error:?}").contains("position.y"));
    }

    #[test]
    fn a_non_object_position_is_rejected() {
        assert!(click_params_from_args(&args(&json!({"target": "#a", "position": [1, 2]}))).is_err());
    }

    #[test]
    fn an_empty_modifier_array_is_omitted_rather_than_sent_as_an_empty_list() {
        let params = click_params_from_args(&args(&json!({"target": "#a", "modifiers": []})))
            .expect("valid arguments must build params");
        assert_eq!(params.get("modifiers"), None);
    }

    #[test]
    fn a_zero_position_survives_rather_than_being_dropped_as_falsy() {
        let params = click_params_from_args(&args(&json!({"target": "#a", "position": {"x": 0, "y": 0}})))
            .expect("valid arguments must build params");
        assert_eq!(params["position"], json!({"x": 0.0, "y": 0.0}));
    }

    #[test]
    fn the_advertised_schema_accepts_exactly_what_the_handler_accepts() {
        // A schema that allows a value the handler rejects sends models down a
        // path that always fails; the two lists must not drift.
        let schema = click_schema();
        let properties = schema["properties"].as_object().expect("valid arguments must build params");
        assert_eq!(properties["modifiers"]["items"]["enum"], json!(CLICK_MODIFIERS));
        assert_eq!(properties["button"]["enum"], json!(CLICK_BUTTONS));
    }
}

/// The frame chain shared by every element-targeting MCP tool.
#[cfg(test)]
mod frame_args_tests {
    use super::*;

    fn args(value: &Value) -> JsonObject {
        value.as_object().cloned().expect("test args must be an object")
    }

    #[test]
    fn a_frame_chain_reaches_the_bridge_in_the_order_given() {
        let params = click_params_from_args(&args(&json!({
            "target": "#pay",
            "frame": ["#outer", "#inner"],
        })))
        .expect("valid arguments must build params");
        assert_eq!(params["frame"], json!(["#outer", "#inner"]));
    }

    #[test]
    fn omitting_frame_sends_no_key() {
        let params =
            click_params_from_args(&args(&json!({"target": "#pay"}))).expect("valid arguments must build params");
        assert_eq!(params.get("frame"), None);
    }

    #[test]
    fn an_empty_frame_array_is_treated_as_absent() {
        // Forwarding `[]` would make the bridge walk a chain of length zero
        // rather than skip frame resolution entirely.
        let params = click_params_from_args(&args(&json!({"target": "#pay", "frame": []})))
            .expect("valid arguments must build params");
        assert_eq!(params.get("frame"), None);
    }

    #[test]
    fn a_non_array_frame_is_rejected() {
        assert!(click_params_from_args(&args(&json!({"target": "#a", "frame": "#f"}))).is_err());
    }

    #[test]
    fn a_non_string_or_empty_selector_is_rejected() {
        assert!(click_params_from_args(&args(&json!({"target": "#a", "frame": [1]}))).is_err());
        assert!(click_params_from_args(&args(&json!({"target": "#a", "frame": [""]}))).is_err());
    }

    #[test]
    fn the_target_schema_advertises_frame_so_models_know_it_exists() {
        let schema = target_schema();
        let properties = schema["properties"].as_object().expect("valid arguments must build params");
        assert_eq!(properties["frame"]["type"], json!("array"));
        assert_eq!(properties["frame"]["items"]["type"], json!("string"));
    }
}

/// The `route` tool's action dispatch.
#[cfg(test)]
mod route_schema_tests {
    use super::*;

    #[test]
    fn the_schema_lists_exactly_the_actions_the_handler_accepts() {
        // An advertised action the handler rejects sends models down a path that
        // always fails; an accepted one the schema hides is never discovered.
        let schema = route_schema();
        let properties = schema["properties"].as_object().expect("schema properties must be an object");
        assert_eq!(properties["action"]["enum"], json!(["fulfill", "abort", "list", "clear"]));
    }

    #[test]
    fn pattern_is_not_required_at_the_schema_level_because_list_and_clear_omit_it() {
        let schema = route_schema();
        assert_eq!(schema["required"], json!(["action"]));
    }
}
