use crate::error::Error;
use crate::eval::EvalEngine;
use crate::handler;
use crate::protocol::{Request, Response};
use crate::recorder::Recorder;

use futures_util::stream::{FuturesUnordered, StreamExt};
use std::collections::hash_map::Entry;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

/// Evaluates a raw JS expression. The backend owns result transport (IPC or CDP).
/// The first argument is an optional window label (`None` means "use default window").
/// IPC alone must execute in the application's main world, where Tauri owns
/// its invoke bridge. Ordinary automation stays in its isolated CEF world.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EvalWorld {
    Automation,
    Main,
}

pub(crate) struct EvalScript {
    pub code: String,
    pub world: EvalWorld,
}
impl From<String> for EvalScript {
    fn from(code: String) -> Self {
        Self { code, world: EvalWorld::Automation }
    }
}

pub(crate) type EvalFn = Arc<dyn Fn(Option<&str>, Option<u64>, EvalScript) -> Result<(), String> + Send + Sync>;

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

/// What the reader half hands to the serving half.
enum Incoming {
    Request(Request),
    /// A line that could not become a request; answered without dispatching.
    Reply(Response),
    /// A protocol violation that ends the connection once it is answered.
    Fatal(Response),
}

/// Requests one connection may have accepted but not yet answered. Past this
/// the reader stops, so a peer that pipelines without reading responses is
/// held back by its own socket buffer instead of growing server memory.
const MAX_IN_FLIGHT: usize = 64;

/// `wait`, `watch` and `downloads.wait` only observe: they hold their response
/// open until something happens, which is usually caused by a later request on
/// the same connection. They therefore never occupy a window's lane.
fn is_observer(method: &str) -> bool {
    matches!(method, "wait" | "watch" | "downloads.wait")
}

async fn write_response<W>(writer: &mut W, response: &Response) -> Result<(), Error>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut bytes = serde_json::to_vec(response)?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}

/// Turn the peer's lines into requests for the serving half.
///
/// Reading stays in its own future because `read_line` cannot be resumed once
/// dropped: racing it against request completion would lose bytes.
async fn read_requests<R>(reader: R, tx: tokio::sync::mpsc::Sender<Incoming>) -> Result<(), Error>
where
    R: tokio::io::AsyncRead + Unpin,
{
    const MAX_LINE_LENGTH: usize = crate::protocol::MAX_REQUEST_BYTES;

    let mut reader = BufReader::new(reader);
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
            let _ = tx.send(Incoming::Fatal(response)).await;
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let incoming = match serde_json::from_str::<Request>(trimmed) {
            Ok(req) if req.jsonrpc != "2.0" => Incoming::Reply(Response::error(
                serde_json::Value::Number(req.id.into()),
                -32600,
                "Invalid JSON-RPC version (expected \"2.0\")",
            )),
            Ok(req) => Incoming::Request(req),
            Err(e) => Incoming::Reply(Response::error(serde_json::Value::Null, -32700, format!("Parse error: {e}"))),
        };
        if tx.send(incoming).await.is_err() {
            break;
        }
    }
    Ok(())
}

/// Serve one connection.
///
/// Requests are pipelined: a response is written when its request finishes,
/// matched to it by `id`, not in arrival order. Requests for the same window
/// still run one at a time in the order they arrived, so `fill` then `click`
/// keeps its meaning; requests for different windows, and the observers
/// `wait` and `watch`, run alongside them. Without this a single pending
/// `watch` held every later request on the connection until it timed out.
pub(crate) async fn handle_connection<S>(
    stream: S, engine: &EvalEngine, eval_fn: Option<&EvalFn>, list_fn: Option<&ListWindowsFn>,
    press_hooks: Option<&PressHooksRef>, recorder: &Recorder,
) -> Result<(), Error>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Incoming>(1);

    let read = read_requests(reader, tx);

    let serve = async {
        // `lane` is the window a request occupies, or `None` for an observer.
        let run = |req: Request, lane: Option<String>| async move {
            (lane, dispatch_request(&req, engine, eval_fn, list_fn, press_hooks, recorder).await)
        };
        // A key is present exactly while a request for that window is running;
        // its queue holds the requests waiting behind it.
        let mut lanes: HashMap<String, VecDeque<Request>> = HashMap::new();
        let mut queued = 0_usize;
        let mut running = FuturesUnordered::new();
        let mut open = true;

        loop {
            tokio::select! {
                Some((lane, response)) = running.next() => {
                    write_response(&mut writer, &response).await?;
                    if let Some(lane) = lane {
                        match lanes.get_mut(&lane).and_then(VecDeque::pop_front) {
                            Some(next) => {
                                queued -= 1;
                                running.push(run(next, Some(lane)));
                            }
                            None => {
                                lanes.remove(&lane);
                            }
                        }
                    }
                }
                incoming = rx.recv(), if open && running.len() + queued < MAX_IN_FLIGHT => match incoming {
                    None => open = false,
                    Some(Incoming::Reply(response)) => write_response(&mut writer, &response).await?,
                    Some(Incoming::Fatal(response)) => {
                        write_response(&mut writer, &response).await?;
                        return Ok(());
                    }
                    Some(Incoming::Request(req)) if is_observer(&req.method) => running.push(run(req, None)),
                    Some(Incoming::Request(req)) => {
                        // A request that names no window targets `main`, so it shares that
                        // lane; a lane of its own would let it overtake `main`'s requests.
                        let lane = req
                            .params
                            .as_ref()
                            .and_then(|params| params.get("window"))
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("main")
                            .to_owned();
                        match lanes.entry(lane.clone()) {
                            Entry::Occupied(mut waiting) => {
                                waiting.get_mut().push_back(req);
                                queued += 1;
                            }
                            Entry::Vacant(free) => {
                                free.insert(VecDeque::new());
                                running.push(run(req, Some(lane)));
                            }
                        }
                    }
                },
                else => break,
            }
        }
        Ok::<(), Error>(())
    };

    tokio::pin!(read);
    tokio::pin!(serve);
    // The peer closing its write side ends `read` first; `serve` then finishes
    // the requests already accepted, as the serial loop did.
    let mut read_result = None;
    loop {
        tokio::select! {
            result = &mut read, if read_result.is_none() => read_result = Some(result),
            result = &mut serve => {
                result?;
                break;
            }
        }
    }
    read_result.unwrap_or(Ok(()))
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

    type EvalCalls = tokio::sync::mpsc::UnboundedReceiver<(Option<String>, u64)>;
    type Lines = tokio::io::Lines<BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>;

    /// A connection whose evals stay pending until the test resolves them, so
    /// the test decides which request finishes first.
    fn pipelined_connection() -> (EvalEngine, EvalCalls, tokio::io::WriteHalf<tokio::io::DuplexStream>, Lines) {
        let engine = EvalEngine::new();
        let (calls_tx, calls) = tokio::sync::mpsc::unbounded_channel();
        let eval_fn: EvalFn = Arc::new(move |window, id, _script| {
            calls_tx
                .send((window.map(str::to_owned), id.expect("bridge evals carry an id")))
                .map_err(|error| error.to_string())
        });
        let (client, server) = tokio::io::duplex(64 * 1024);
        let shared = engine.clone();
        tokio::spawn(
            async move { handle_connection(server, &shared, Some(&eval_fn), None, None, &Recorder::new()).await },
        );
        let (reader, writer) = tokio::io::split(client);
        (engine, calls, writer, BufReader::new(reader).lines())
    }

    async fn send(writer: &mut tokio::io::WriteHalf<tokio::io::DuplexStream>, id: u64, method: &str, window: &str) {
        let request = serde_json::json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": {"window": window, "selector": "#x"}
        });
        writer.write_all(format!("{request}\n").as_bytes()).await.expect("write request");
    }

    async fn next_response_id(lines: &mut Lines) -> u64 {
        let line = lines.next_line().await.expect("read response").expect("connection stays open");
        let response: Response = serde_json::from_str(&line).expect("valid response envelope");
        response.id.as_u64().expect("response id")
    }

    #[tokio::test]
    async fn a_pending_watch_does_not_hold_later_requests_for_the_same_window() {
        let (engine, mut calls, mut writer, mut lines) = pipelined_connection();

        send(&mut writer, 1, "watch", "main").await;
        send(&mut writer, 2, "text", "main").await;
        let (_, watch) = calls.recv().await.expect("watch reaches the webview");
        let (_, text) = calls.recv().await.expect("text is dispatched while watch is still pending");

        engine.resolve(text, Ok(serde_json::json!("hello")));
        assert_eq!(next_response_id(&mut lines).await, 2);
        engine.resolve(watch, Ok(serde_json::json!({"added": [], "removed": [], "modified": []})));
        assert_eq!(next_response_id(&mut lines).await, 1);
    }

    #[tokio::test]
    async fn requests_keep_arrival_order_per_window_and_run_across_windows() {
        let (engine, mut calls, mut writer, mut lines) = pipelined_connection();

        send(&mut writer, 1, "text", "main").await;
        send(&mut writer, 2, "text", "main").await;
        send(&mut writer, 3, "text", "settings").await;
        let (first_window, first) = calls.recv().await.expect("first request");
        let (other_window, other) = calls.recv().await.expect("the other window does not wait for main");
        assert_eq!(first_window.as_deref(), Some("main"));
        assert_eq!(other_window.as_deref(), Some("settings"));

        engine.resolve(other, Ok(serde_json::json!("settings")));
        assert_eq!(next_response_id(&mut lines).await, 3);
        assert!(calls.try_recv().is_err(), "the second main request must wait for the first");

        engine.resolve(first, Ok(serde_json::json!("one")));
        assert_eq!(next_response_id(&mut lines).await, 1);
        let (second_window, second) = calls.recv().await.expect("second main request starts after the first");
        assert_eq!(second_window.as_deref(), Some("main"));
        engine.resolve(second, Ok(serde_json::json!("two")));
        assert_eq!(next_response_id(&mut lines).await, 2);
    }

    #[tokio::test]
    async fn a_request_without_a_window_waits_behind_main_which_it_targets() {
        let (engine, mut calls, mut writer, mut lines) = pipelined_connection();

        send(&mut writer, 1, "text", "main").await;
        let unlabelled = serde_json::json!({"jsonrpc": "2.0", "id": 2, "method": "text", "params": {"selector": "#x"}});
        writer.write_all(format!("{unlabelled}\n").as_bytes()).await.expect("write request");
        send(&mut writer, 3, "text", "settings").await;
        let (_, first) = calls.recv().await.expect("first request");
        let (other_window, other) = calls.recv().await.expect("another window runs alongside");
        assert_eq!(other_window.as_deref(), Some("settings"), "the unlabelled request must not overtake main");

        engine.resolve(other, Ok(serde_json::json!("settings")));
        assert_eq!(next_response_id(&mut lines).await, 3);
        engine.resolve(first, Ok(serde_json::json!("one")));
        assert_eq!(next_response_id(&mut lines).await, 1);
        let (_, second) = calls.recv().await.expect("the unlabelled request starts after main's first");
        engine.resolve(second, Ok(serde_json::json!("two")));
        assert_eq!(next_response_id(&mut lines).await, 2);
    }

    #[tokio::test]
    async fn accepted_requests_are_answered_after_the_peer_stops_writing() {
        let (engine, mut calls, mut writer, mut lines) = pipelined_connection();

        send(&mut writer, 1, "text", "main").await;
        writer.shutdown().await.expect("close the write side");
        let (_, text) = calls.recv().await.expect("request reaches the webview");

        engine.resolve(text, Ok(serde_json::json!("late")));
        assert_eq!(next_response_id(&mut lines).await, 1);
        assert!(lines.next_line().await.expect("clean end of stream").is_none());
    }
}
