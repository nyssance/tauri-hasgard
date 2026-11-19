//! Native automation for registered applications, in debug and release builds.
//!
//! The embedding application chooses whether to expose local transport. Obtain
//! [`Automation`] from Tauri state after setup; authorize the caller and target
//! before calling it. Do not expose this handle directly to remote web content.
use crate::eval::EvalEngine;
use crate::recorder::Recorder;
use crate::server::{EvalFn, ListWindowsFn, PressHooksRef};
use serde_json::Value;
use std::sync::Arc;

pub use crate::protocol::RpcError;

/// The same executor used by the Hasgard protocol, without a debug server.
#[derive(Clone)]
pub struct Automation {
    engine: EvalEngine,
    eval: EvalFn,
    list: ListWindowsFn,
    press: PressHooksRef,
    recorder: Arc<Recorder>,
}

impl Automation {
    pub(crate) fn new(engine: EvalEngine, eval: EvalFn, list: ListWindowsFn, press: PressHooksRef) -> Self {
        Self { engine, eval, list, press, recorder: Arc::new(Recorder::new()) }
    }

    /// Stop the target's CEF worker and native CDP dispatch.
    /// Returns `false` when the backend cannot interrupt an in-flight action;
    /// the host must retain its lease until that action finishes.
    ///
    /// # Errors
    /// Returns a native worker cleanup failure.
    ///
    /// # Panics
    /// Panics if an internal synchronization lock is poisoned.
    pub fn cancel(&self, target: &str) -> Result<bool, String> {
        let cancel = self.engine.cancel.lock().expect("cancel hook").clone();
        match cancel {
            Some(cancel) => {
                cancel(target, true)?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// The Hasgard tools as an MCP server that calls this application in process.
    ///
    /// Nothing listens and no CLI is involved: serve the result over any `rmcp` transport,
    /// or give it to an ACP bridge that accepts an `rmcp` service. `window` is the label
    /// used by tool calls that name none.
    #[cfg(feature = "mcp")]
    #[must_use]
    pub fn mcp_server(&self, window: Option<String>) -> tauri_hasgard_mcp::HasgardMcpServer {
        let automation = self.clone();
        tauri_hasgard_mcp::HasgardMcpServer::in_process(
            move |method, params| {
                let automation = automation.clone();
                async move {
                    automation.call(&method, params).await.map_err(|error| tauri_hasgard_mcp::RpcError {
                        code: error.code,
                        message: error.message,
                        data: error.data,
                    })
                }
            },
            window,
        )
    }

    /// Execute a previously authorized request using the shared Hasgard protocol.
    /// Every surface operation requires an explicit window or child-webview label.
    ///
    /// # Errors
    /// Returns the protocol error for invalid targets, unsupported capabilities,
    /// failed actions, or missing native permissions. Failed actions are not retried.
    ///
    /// # Panics
    /// Panics if an internal synchronization lock is poisoned.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        if !params.is_object() {
            return Err(RpcError { code: -32602, message: "params must be an object".into(), data: None });
        }
        if !matches!(method, "ping" | "windows.list")
            && params.get("window").and_then(Value::as_str).is_none_or(str::is_empty)
        {
            return Err(RpcError { code: -32602, message: "An explicit window target is required".into(), data: None });
        }
        if let Some(target) = params.get("window").and_then(Value::as_str) {
            let resume = self.engine.cancel.lock().expect("cancel hook").clone();
            if let Some(resume) = resume {
                resume(target, false).map_err(|message| RpcError { code: -32603, message, data: None })?;
            }
        }
        crate::handler::dispatch(
            method,
            Some(&params),
            &self.engine,
            Some(&self.eval),
            Some(&self.list),
            Some(&self.press),
            &self.recorder,
        )
        .await
    }
}

/// Code-level configuration; no product settings or account system is involved.
#[derive(Clone, Copy)]
pub struct Options {
    /// Serve the existing local Hasgard protocol. Disable for in-process use only.
    pub listen: bool,
}
impl Default for Options {
    fn default() -> Self {
        Self { listen: true }
    }
}

/// Initialize Wry automation and its local protocol in debug or release mode.
#[must_use]
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R>
where
    R::Handle: tauri_runtime_wry::AsWryHandle,
{
    init_with_options(Options::default())
}

/// Initialize Wry with a host-selected transport policy.
#[must_use]
pub fn init_with_options<R: tauri::Runtime>(options: Options) -> tauri::plugin::TauriPlugin<R>
where
    R::Handle: tauri_runtime_wry::AsWryHandle,
{
    crate::build_plugin::<R>(true, options.listen, |app, engine| {
        use tauri_runtime_wry::AsWryHandle;
        if app.runtime_handle().as_wry_handle().is_none() {
            return Err(std::io::Error::other("Wry automation requires the Wry runtime").into());
        }
        #[cfg(target_os = "macos")]
        crate::screenshot::register_snapshot_fn(crate::make_snapshot_fn(app));
        #[cfg(any(target_os = "macos", windows))]
        crate::heap::register_heap_snapshot_fn(crate::make_heap_snapshot_fn(app));
        Ok((crate::make_eval_fn(app, engine), crate::make_press_hooks(app)))
    })
}

/// Initialize CEF automation and its local protocol in debug or release mode.
#[cfg(feature = "cef")]
#[must_use]
pub fn init_cef() -> tauri::plugin::TauriPlugin<tauri::DynRuntime> {
    crate::build_plugin(false, true, crate::cef::hooks)
}

/// Initialize CEF with the host's packaged executor and transport policy.
/// The factory runs before the listener accepts any connections.
///
/// # Panics
/// Plugin setup panics if the executor configuration lock is poisoned.
#[cfg(feature = "cef")]
#[must_use]
pub fn init_cef_with_executor(
    options: Options,
    executor: impl Fn(&tauri::AppHandle) -> Result<crate::playwright::ExecutorCommand, Box<dyn std::error::Error>>
    + Send
    + Sync
    + 'static,
) -> tauri::plugin::TauriPlugin<tauri::DynRuntime> {
    crate::build_plugin(false, options.listen, move |app, engine| {
        *engine.executor.lock().expect("executor command") = Some(executor(app)?);
        crate::cef::hooks(app, engine)
    })
}
