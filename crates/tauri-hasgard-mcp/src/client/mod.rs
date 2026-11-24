#![allow(
    clippy::must_use_candidate,
    clippy::missing_errors_doc,
    clippy::missing_panics_doc,
    reason = "shared with the tauri-hasgard CLI; not a stable API"
)]

use crate::protocol::{MAX_REQUEST_BYTES, Request, Response, RpcError};

use anyhow::{Result, bail};
use std::{future::Future, path::Path, pin::Pin, sync::Arc};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// Preserve the plugin's error data across CLI and MCP presentation layers.
#[derive(Debug)]
pub struct RpcFailure(pub RpcError);

impl std::fmt::Display for RpcFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "RPC error ({}): {}", self.0.code, self.0.message)?;
        if let Some(data) = &self.0.data {
            write!(formatter, " [data: {data}]")?;
        }
        Ok(())
    }
}

impl std::error::Error for RpcFailure {}

/// A host-supplied path to the application: method and params in, result or protocol error out.
pub type InProcessCall = Arc<
    dyn Fn(String, serde_json::Value) -> Pin<Box<dyn Future<Output = Result<serde_json::Value, RpcError>> + Send>>
        + Send
        + Sync,
>;

#[cfg(unix)]
type Reader = BufReader<tokio::net::unix::OwnedReadHalf>;
#[cfg(unix)]
type Writer = tokio::net::unix::OwnedWriteHalf;
#[cfg(windows)]
type Reader = BufReader<tokio::io::ReadHalf<tokio::net::windows::named_pipe::NamedPipeClient>>;
#[cfg(windows)]
type Writer = tokio::io::WriteHalf<tokio::net::windows::named_pipe::NamedPipeClient>;

enum Transport {
    Endpoint {
        reader: Reader,
        writer: Writer,
        next_id: u64,
        /// The response line being read. It outlives a call that is dropped while it waits
        /// (a step that timed out), so the next call resumes the line instead of losing part of it.
        line: Vec<u8>,
        /// Set while a request is being written: a call dropped then leaves half a request behind.
        writing: bool,
    },
    InProcess(InProcessCall),
}

/// Hasgard protocol client: the plugin's local endpoint, or a call into the host process.
pub struct Client(Transport);

impl Client {
    /// Connect to the plugin's Unix socket or Windows named pipe.
    pub async fn connect(path: &Path) -> Result<Self> {
        #[cfg(unix)]
        {
            unix::connect(path).await
        }
        #[cfg(windows)]
        {
            windows::connect(path).await
        }
    }

    /// Reach the application through a function in this process instead of an endpoint.
    pub fn in_process(call: InProcessCall) -> Self {
        Self(Transport::InProcess(call))
    }

    fn endpoint(reader: Reader, writer: Writer) -> Self {
        Self(Transport::Endpoint { reader, writer, next_id: 1, line: Vec::new(), writing: false })
    }

    /// Send one request and return its result value.
    pub async fn call(&mut self, method: &str, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
        let (reader, writer, next_id, line, writing) = match &mut self.0 {
            Transport::Endpoint { reader, writer, next_id, line, writing } => (reader, writer, next_id, line, writing),
            Transport::InProcess(call) => {
                // The in-process executor takes an object; an absent params value is the empty object.
                let params = params.unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));
                return call(method.to_owned(), params).await.map_err(|error| RpcFailure(error).into());
            }
        };
        if *writing {
            bail!("An earlier request was abandoned while it was being sent; this connection cannot be used further");
        }
        let id = *next_id;
        *next_id += 1;

        let request = Request { jsonrpc: "2.0".to_owned(), id, method: method.to_owned(), params };

        let mut bytes = serde_json::to_vec(&request)?;
        bytes.push(b'\n');
        if bytes.len() > MAX_REQUEST_BYTES {
            bail!("Hasgard request is {} bytes; maximum is {MAX_REQUEST_BYTES} bytes including newline", bytes.len());
        }
        *writing = true;
        writer.write_all(&bytes).await?;
        writer.flush().await?;
        *writing = false;

        let response = loop {
            // Whatever a dropped call had read of a line is still in `line`, and is completed here.
            let n = reader.read_until(b'\n', line).await?;
            if n == 0 {
                bail!("Server closed the connection");
            }
            let response: Result<Response, _> = serde_json::from_slice(line.trim_ascii());
            line.clear();
            let response = response?;

            if response.id.is_null() {
                let err = response.error.ok_or_else(|| anyhow::anyhow!("Uncorrelated response has no error"))?;
                return Err(RpcFailure(err).into());
            }
            // The answer to a call that was given up on, such as a scenario step that timed
            // out, arrives later and belongs to no one; the one waited for comes after it.
            if response.id.as_u64().is_some_and(|answered| answered < id) {
                continue;
            }
            if response.id != serde_json::Value::Number(id.into()) {
                bail!("Response ID mismatch: expected {id}, got {}", response.id);
            }
            break response;
        };

        if let Some(err) = response.error {
            return Err(RpcFailure(err).into());
        }

        // Deserialization preserves explicit null and rejects an absent result.
        response.result.ok_or_else(|| anyhow::anyhow!("RPC response is missing result"))
    }
}

#[cfg(unix)]
pub mod unix;
#[cfg(windows)]
pub mod windows;

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    #[tokio::test]
    async fn shared_response_contract_over_transport() {
        let cases: serde_json::Value = serde_json::from_str(include_str!("../protocol-responses.json")).expect("cases");
        for case in cases.as_array().expect("array") {
            let directory = tempfile::tempdir().expect("temp directory");
            let socket = directory.path().join("rpc.sock");
            let listener = UnixListener::bind(&socket).expect("listen");
            let response = case["response"].clone();
            let handle = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.expect("accept");
                let (reader, mut writer) = stream.into_split();
                let mut line = String::new();
                BufReader::new(reader).read_line(&mut line).await.expect("request");
                writer.write_all(format!("{response}\n").as_bytes()).await.expect("response");
            });
            let mut client = Client::connect(&socket).await.expect("connect");
            let result = client.call("ping", None).await;
            if case["valid"] == true && case["response"].get("result").is_some() {
                assert_eq!(result.expect("valid result"), case["response"]["result"], "{}", case["name"]);
            } else {
                let error = result.expect_err("error response or invalid envelope");
                if case["valid"] == true {
                    let failure = error.downcast_ref::<RpcFailure>().expect("typed RPC error");
                    assert_eq!(serde_json::to_value(&failure.0).expect("error payload"), case["response"]["error"]);
                }
            }
            handle.await.expect("server");
        }
    }

    #[tokio::test]
    async fn a_call_given_up_on_does_not_take_the_next_call_s_answer() {
        let directory = tempfile::tempdir().expect("temp directory");
        let socket = directory.path().join("rpc.sock");
        let listener = UnixListener::bind(&socket).expect("listen");
        // The first answer comes late and in two pieces; the second follows at once.
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (reader, mut writer) = stream.into_split();
            let mut requests = BufReader::new(reader).lines();
            requests.next_line().await.expect("first request");
            tokio::time::sleep(Duration::from_millis(80)).await;
            writer.write_all(br#"{"jsonrpc":"2.0","id":1,"res"#).await.expect("half an answer");
            writer.flush().await.expect("flush");
            requests.next_line().await.expect("second request");
            writer
                .write_all(b"ult\":\"slow\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":\"second\"}\n")
                .await
                .expect("answers");
        });
        let mut client = Client::connect(&socket).await.expect("connect");
        // A step with a deadline: the call is dropped while it waits.
        let given_up = tokio::time::timeout(Duration::from_millis(20), client.call("slow", None)).await;
        assert!(given_up.is_err(), "the first call must time out");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(client.call("next", None).await.expect("the second call's own answer"), "second");
        server.await.expect("server");
    }

    #[tokio::test]
    async fn oversized_request_does_not_poison_connection() {
        let directory = tempfile::tempdir().expect("temp directory");
        let socket = directory.path().join("rpc.sock");
        let handle = mock_server(&socket);
        let mut client = Client::connect(&socket).await.expect("connect");
        let error = client
            .call("eval", Some(serde_json::json!({"script": "界".repeat(MAX_REQUEST_BYTES / 2)})))
            .await
            .expect_err("request exceeds UTF-8 limit");
        assert!(error.to_string().contains("maximum is 1048576"));
        assert_eq!(client.call("ping", None).await.expect("still connected"), serde_json::json!({"status": "ok"}));
        handle.abort();
    }

    /// Build a unique socket path per test invocation so parallel `cargo test`
    /// runs (same process, different tests) don't clobber each other's sockets
    /// or leak a previous test's bind into the next one.
    fn unique_socket_path(tag: &str) -> PathBuf {
        let n = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        PathBuf::from(format!("/tmp/tauri-hasgard-test-{}-{}-{}.sock", tag, std::process::id(), n))
    }

    fn mock_server(path: &PathBuf) -> tokio::task::JoinHandle<()> {
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path).expect("bind mock socket");
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (reader, mut writer) = stream.into_split();
            let mut reader = BufReader::new(reader);
            let mut line = String::new();
            while reader.read_line(&mut line).await.expect("read line") > 0 {
                let req: Request = serde_json::from_str(line.trim()).expect("parse request");
                let resp = if req.method == "ping" {
                    Response::success(req.id, serde_json::json!({"status": "ok"}))
                } else {
                    Response::error(serde_json::Value::Number(req.id.into()), -32601, "Method not found")
                };
                let mut bytes = serde_json::to_vec(&resp).expect("serialize response");
                bytes.push(b'\n');
                writer.write_all(&bytes).await.expect("write bytes");
                writer.flush().await.expect("flush");
                line.clear();
            }
        })
    }

    /// Connect with retry to avoid race with server bind.
    async fn connect_with_retry(path: &Path) -> Client {
        for _ in 0..20 {
            match Client::connect(path).await {
                Ok(c) => return c,
                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        }
        Client::connect(path).await.expect("Failed to connect after retries")
    }

    #[tokio::test]
    async fn test_client_ping_returns_ok() {
        let socket = unique_socket_path("t05a");
        let handle = mock_server(&socket);

        let mut client = connect_with_retry(&socket).await;
        let result = client.call("ping", None).await.expect("ping call");
        assert_eq!(result, serde_json::json!({"status": "ok"}));

        handle.abort();
        let _ = std::fs::remove_file(&socket);
    }

    #[tokio::test]
    async fn test_client_null_result_is_success() {
        // A JSON-RPC response with explicit `"result": null` must be treated as
        // success with Value::Null — not a protocol error. This happens when an
        // eval'd JS expression legitimately returns `undefined` (e.g.,
        // `element.click()`, void functions). Regression test for #48.
        let socket = unique_socket_path("t05c");
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket).expect("bind mock socket");
        let handle = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (reader, mut writer) = stream.into_split();
            let mut reader = BufReader::new(reader);
            let mut line = String::new();
            reader.read_line(&mut line).await.expect("read line");
            let req: Request = serde_json::from_str(line.trim()).expect("parse request");
            // Write `{"result": null}` explicitly to simulate a void JS expr.
            let raw = format!(r#"{{"jsonrpc":"2.0","id":{},"result":null}}"#, req.id);
            writer.write_all(raw.as_bytes()).await.expect("write raw");
            writer.write_all(b"\n").await.expect("write newline");
            writer.flush().await.expect("flush");
        });

        let mut client = connect_with_retry(&socket).await;
        let result = client.call("eval", None).await.expect("eval call");
        assert_eq!(result, serde_json::Value::Null);

        handle.abort();
        let _ = std::fs::remove_file(&socket);
    }

    #[tokio::test]
    async fn test_client_missing_result_is_protocol_error() {
        let socket = unique_socket_path("t05d");
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket).expect("bind mock socket");
        let handle = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (reader, mut writer) = stream.into_split();
            let mut reader = BufReader::new(reader);
            let mut line = String::new();
            reader.read_line(&mut line).await.expect("read line");
            let req: Request = serde_json::from_str(line.trim()).expect("parse request");
            // Neither `result` nor `error` present
            let raw = format!(r#"{{"jsonrpc":"2.0","id":{}}}"#, req.id);
            writer.write_all(raw.as_bytes()).await.expect("write raw");
            writer.write_all(b"\n").await.expect("write newline");
            writer.flush().await.expect("flush");
        });

        let mut client = connect_with_retry(&socket).await;
        let error = client.call("eval", None).await.expect_err("missing result must fail");
        assert!(error.to_string().contains("exactly one of result or error"));

        handle.abort();
        let _ = std::fs::remove_file(&socket);
    }

    #[tokio::test]
    async fn test_client_unknown_method_returns_error() {
        let socket = unique_socket_path("t05b");
        let handle = mock_server(&socket);

        let mut client = connect_with_retry(&socket).await;
        let result = client.call("nonexistent", None).await;
        assert!(result.is_err());
        assert!(result.expect_err("call returns error").to_string().contains("-32601"));

        handle.abort();
        let _ = std::fs::remove_file(&socket);
    }

    #[tokio::test]
    async fn test_client_connect_failure() {
        let err = Client::connect(Path::new("/tmp/tauri-hasgard-nonexistent.sock"))
            .await
            .map(|_| ())
            .expect_err("should fail to connect");
        assert!(err.to_string().contains("Cannot connect"));
    }
}
