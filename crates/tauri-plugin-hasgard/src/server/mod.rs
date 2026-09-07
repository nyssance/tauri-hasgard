use crate::error::Error;
use crate::eval::EvalEngine;
use crate::handler;
use crate::protocol::{Request, Response};
use crate::recorder::Recorder;

use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

/// A function that evaluates JS in the webview.
/// The first argument is an optional window label (`None` means "use default window").
pub(crate) type EvalFn = Arc<dyn Fn(Option<&str>, String) -> Result<(), String> + Send + Sync>;

/// A function that lists all available webview windows and returns their metadata.
pub(crate) type ListWindowsFn = Arc<dyn Fn() -> Result<serde_json::Value, String> + Send + Sync>;

/// Requests focus for a webview window. `None` means "default window" (same
/// resolution as `EvalFn`).
pub(crate) type FocusHook = Box<dyn Fn(Option<&str>) -> Result<(), String> + Send + Sync>;

/// Runs a native key-injection closure on whichever thread the host platform
/// requires, and blocks until it has finished.
pub(crate) type InjectionTask = Box<dyn FnOnce() -> Result<(), String> + Send>;
#[derive(Debug)]
pub(crate) struct InjectionError {
    pub(crate) message: String,
    pub(crate) started: bool,
}
pub(crate) type InjectionRunner =
    Box<dyn Fn(Option<&str>, i64, bool, InjectionTask) -> Result<(), InjectionError> + Send + Sync>;

/// Host hooks the `press` path needs from the Tauri runtime.
///
/// These travel together because native key injection needs both: focus so the
/// synthesised OS events reach the right window, and a runner that places the
/// injection on a thread where it is actually safe to perform.
pub(crate) struct PressHooks {
    pub(crate) focus: FocusHook,
    /// Which thread is required is a per-platform answer, so the choice lives
    /// in the hook rather than in the caller: macOS must hop to the main
    /// thread, and the other backends must not (see `make_press_hooks`).
    pub(crate) run_injection: InjectionRunner,
}

pub(crate) type PressHooksRef = Arc<PressHooks>;

pub(crate) async fn handle_connection<S>(
    stream: S, engine: &EvalEngine, eval_fn: Option<&EvalFn>, list_fn: Option<&ListWindowsFn>,
    press_hooks: Option<&PressHooksRef>, recorder: &Recorder,
) -> Result<(), Error>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    const MAX_LINE_LENGTH: usize = crate::protocol::MAX_REQUEST_BYTES;

    let (mut reader, mut writer) = tokio::io::split(stream);
    let mut reader = BufReader::new(&mut reader);
    let mut line = String::new();

    loop {
        line.clear();
        // Bound the per-line read so a peer flooding bytes without a newline
        // can't OOM us. `Take<R>` re-implements `AsyncBufRead`, so `read_line`
        // still works through it; constructing a fresh `Take` per iteration
        // resets the remaining-byte budget for each line.
        let n = (&mut reader).take(MAX_LINE_LENGTH as u64 + 1).read_line(&mut line).await?;
        if n == 0 {
            break;
        }

        if line.len() > MAX_LINE_LENGTH {
            let response = Response::error(serde_json::Value::Null, -32700, "Request line exceeds maximum length");
            let mut resp_bytes = serde_json::to_vec(&response)?;
            resp_bytes.push(b'\n');
            writer.write_all(&resp_bytes).await?;
            writer.flush().await?;
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<Request>(trimmed) {
            Ok(req) if req.jsonrpc != "2.0" => Response::error(
                serde_json::Value::Number(req.id.into()),
                -32600,
                "Invalid JSON-RPC version (expected \"2.0\")",
            ),
            Ok(req) => dispatch_request(&req, engine, eval_fn, list_fn, press_hooks, recorder).await,
            Err(e) => Response::error(serde_json::Value::Null, -32700, format!("Parse error: {e}")),
        };

        let mut resp_bytes = serde_json::to_vec(&response)?;
        resp_bytes.push(b'\n');
        writer.write_all(&resp_bytes).await?;
        writer.flush().await?;
    }

    Ok(())
}

pub(crate) async fn dispatch_request(
    req: &Request, engine: &EvalEngine, eval_fn: Option<&EvalFn>, list_fn: Option<&ListWindowsFn>,
    press_hooks: Option<&PressHooksRef>, recorder: &Recorder,
) -> Response {
    match handler::dispatch(&req.method, req.params.as_ref(), engine, eval_fn, list_fn, press_hooks, recorder).await {
        Ok(result) => Response::success(req.id, result),
        Err(rpc_err) => Response {
            jsonrpc: "2.0".to_owned(),
            id: serde_json::Value::from(req.id),
            result: None,
            error: Some(rpc_err),
        },
    }
}

#[cfg(unix)]
pub mod unix;
#[cfg(windows)]
pub mod windows;

#[cfg(unix)]
pub use unix::{bind, run, socket_path};
// Windows binds inside `run` (#115), so `bind` is internal to the windows module
// and is not re-exported — only `run` and `socket_path` are used by plugin setup.
#[cfg(windows)]
pub use windows::{run, socket_path};

#[cfg(test)]
mod contract_tests {
    use super::*;

    #[tokio::test]
    async fn request_limit_includes_newline_and_preserves_boundary_requests() {
        let limit = crate::protocol::MAX_REQUEST_BYTES;
        for oversized in [false, true] {
            let (client, server) = tokio::io::duplex(limit * 2);
            let server_task = tokio::spawn(async move {
                handle_connection(server, &EvalEngine::new(), None, None, None, &Recorder::new()).await
            });
            let request = serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "ping"});
            let mut line = request.to_string();
            line.push_str(&" ".repeat(limit - line.len() - 1 + usize::from(oversized)));
            line.push('\n');
            let (reader, mut writer) = tokio::io::split(client);
            writer.write_all(line.as_bytes()).await.expect("write boundary request");
            let mut response = String::new();
            BufReader::new(reader).read_line(&mut response).await.expect("read response");
            let response: Response = serde_json::from_str(&response).expect("valid response envelope");
            if oversized {
                assert!(response.id.is_null());
                assert_eq!(response.error.expect("limit error").code, -32700);
            } else {
                assert_eq!(response.result.expect("ping result")["status"], "ok");
            }
            drop(writer);
            server_task.await.expect("server task").expect("connection handler");
        }
    }
}
