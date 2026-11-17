//! Reusable Playwright process transport. It does not expose a debugging socket
//! and is available to application-owned automation in release builds as well.
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
    mpsc,
};
use std::time::Duration;

type Pending = Arc<Mutex<HashMap<u64, mpsc::SyncSender<Result<Value, String>>>>>;

/// A host-supplied runtime and arguments, allowing reuse of an application's Bun sidecar.
#[derive(Clone)]
pub struct ExecutorCommand {
    pub program: std::path::PathBuf,
    pub args: Vec<std::ffi::OsString>,
}

/// Bundled worker source for hosts that already ship Bun.
#[must_use]
pub fn worker_source() -> &'static [u8] {
    include_bytes!("../js/playwright-worker.mjs")
}

pub struct PlaywrightExecutor {
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    pending: Pending,
    sequence: AtomicU64,
}

impl PlaywrightExecutor {
    /// Start the packaged executor. The caller routes CDP to exactly one webview.
    ///
    /// # Errors
    /// Returns an error if the executable or its process pipes cannot be opened.
    ///
    /// # Panics
    /// The reader thread panics if an internal synchronization lock is poisoned.
    pub fn start(
        path: &Path, send: impl Fn(Value, bool) -> Result<(), String> + Send + 'static,
    ) -> Result<Self, String> {
        Self::start_command(&ExecutorCommand { program: path.into(), args: Vec::new() }, send)
    }

    /// Start the worker with the host's existing JavaScript runtime.
    ///
    /// # Errors
    /// Returns an error if the executable or process pipes cannot be opened.
    ///
    /// # Panics
    /// The reader thread panics if an internal synchronization lock is poisoned.
    pub fn start_command(
        command: &ExecutorCommand, send: impl Fn(Value, bool) -> Result<(), String> + Send + 'static,
    ) -> Result<Self, String> {
        let mut child = Command::new(&command.program)
            .args(&command.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Cannot start Playwright executor {}: {e}", command.program.display()))?;
        let input = child.stdin.take().ok_or("Executor stdin unavailable")?;
        let output = child.stdout.take().ok_or("Executor stdout unavailable")?;
        let pending: Pending = Arc::default();
        let replies = pending.clone();
        std::thread::spawn(move || {
            let result = (|| -> Result<(), String> {
                for line in BufReader::new(output).lines() {
                    let value: Value =
                        serde_json::from_str(&line.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                    match value["kind"].as_str() {
                        Some("cdp") => send(value["message"].clone(), value["root"] == true)?,
                        Some("result") => {
                            let id = value["id"].as_u64().ok_or("Invalid executor reply id")?;
                            if let Some(reply) = replies.lock().expect("executor replies").remove(&id) {
                                let result = if let Some(error) = value["error"].as_str() {
                                    Err(error.to_owned())
                                } else {
                                    Ok(value["result"].clone())
                                };
                                let _ = reply.send(result);
                            }
                        }
                        _ => return Err("Invalid executor frame".into()),
                    }
                }
                Err("Playwright executor closed".into())
            })();
            let error = result.expect_err("reader only exits on close or failure");
            for (_, reply) in replies.lock().expect("executor replies").drain() {
                let _ = reply.send(Err(error.clone()));
            }
        });
        Ok(Self { child: Mutex::new(child), input: Mutex::new(input), pending, sequence: AtomicU64::new(1) })
    }

    /// Stop input dispatch and reap the worker before another action can start.
    ///
    /// # Errors
    /// Returns an operating-system error if the worker cannot be stopped.
    ///
    /// # Panics
    /// Panics if an internal synchronization lock is poisoned.
    pub fn stop(&self) -> Result<(), String> {
        let mut child = self.child.lock().expect("executor child");
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            child.kill().map_err(|e| e.to_string())?;
            child.wait().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Deliver a CDP reply or event from the bound native webview.
    ///
    /// # Errors
    /// Returns an error when the process input pipe is closed.
    ///
    /// # Panics
    /// Panics if an internal synchronization lock is poisoned.
    pub fn receive(&self, message: &Value, root: bool) -> Result<(), String> {
        self.write(&json!({"kind":"cdp", "message":message, "root":root}))
    }

    fn write(&self, message: &Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(message).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        let mut input = self.input.lock().expect("executor stdin");
        input.write_all(&bytes).and_then(|()| input.flush()).map_err(|e| e.to_string())
    }

    /// Initialize or execute an action. A timed-out process is terminated.
    ///
    /// # Errors
    /// Returns transport, actionability or timeout errors. Inspect application
    /// state before retrying a failed action because input may have been sent.
    ///
    /// # Panics
    /// Panics if an internal synchronization lock is poisoned.
    pub fn request(&self, mut message: Value) -> Result<Value, String> {
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        message["id"] = json!(id);
        let (tx, rx) = mpsc::sync_channel(1);
        self.pending.lock().expect("executor pending").insert(id, tx);
        let result = self.write(&message).and_then(|()| match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(result) => result,
            Err(error) => {
                // Never leave Playwright retrying an action after its caller timed out.
                let mut child = self.child.lock().expect("executor child");
                let _ = child.kill();
                let _ = child.wait();
                Err(format!("Playwright executor response failed; inspect state before retrying: {error}"))
            }
        });
        self.pending.lock().expect("executor pending").remove(&id);
        if result.is_err() && self.child.lock().expect("executor child").try_wait().ok().flatten().is_some() {
            return Err("Playwright executor exited; reconnect before acting".into());
        }
        result
    }
}

impl Drop for PlaywrightExecutor {
    fn drop(&mut self) {
        let child = self.child.get_mut().expect("executor child");
        let _ = child.kill();
        let _ = child.wait();
    }
}
