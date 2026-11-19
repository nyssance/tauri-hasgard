//! Helpers shared with the `tauri-hasgard` CLI. Not a stable API.

#![allow(
    clippy::must_use_candidate,
    clippy::missing_errors_doc,
    clippy::missing_panics_doc,
    reason = "shared with the tauri-hasgard CLI; not a stable API"
)]

#[cfg(unix)]
use std::path::Path;
use std::{fmt::Write as _, path::PathBuf};

use anyhow::{Context, Result};
use base64::Engine;
use serde_json::{Value, json};

use crate::client::Client;

/// Parsed target for element-targeting commands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Ref(String),
    Selector(String),
    Coords(i32, i32),
}

/// Parse a target string into a `Target` variant.
pub fn parse_target(s: &str) -> Target {
    if let Some(r) = s.strip_prefix('@') {
        return Target::Ref(r.to_owned());
    }

    if let Some((x_str, y_str)) = s.split_once(',')
        && let (Ok(x), Ok(y)) = (x_str.trim().parse::<i32>(), y_str.trim().parse::<i32>())
    {
        return Target::Coords(x, y);
    }

    Target::Selector(s.to_owned())
}

/// The window and frame every element operation is resolved against.
///
/// Carried as one value rather than two threaded arguments so that adding a
/// third dimension later does not mean touching every call site again.
#[derive(Clone, Copy, Default)]
pub struct Scope<'a> {
    pub window: Option<&'a str>,
    pub frame: &'a [String],
}

pub fn with_scope(params: Option<Value>, scope: Scope<'_>) -> Option<Value> {
    if scope.window.is_none() && scope.frame.is_empty() {
        return params;
    }
    let mut map = match params {
        Some(Value::Object(map)) => map,
        Some(other) => return Some(other),
        None => serde_json::Map::new(),
    };
    if let Some(window) = scope.window {
        map.insert("window".to_string(), json!(window));
    }
    if !scope.frame.is_empty() {
        map.insert("frame".to_string(), json!(scope.frame));
    }
    Some(Value::Object(map))
}

pub const MAX_DROP_FILE_SIZE: u64 = 50 * 1024 * 1024; // 50 MB per file

pub const MAX_TOTAL_DROP_SIZE: usize = 100 * 1024 * 1024; // 100 MB total base64 payload

/// Read local paths into the `{name, type, data}` payloads the bridge turns
/// back into `File` objects.
///
/// Shared by `drop` and `set-input-files` so the two cannot diverge on size
/// limits, MIME guessing, or what counts as a readable file — a divergence that
/// would show up as one command accepting a file the other rejects.
pub fn encode_files(paths: &[std::path::PathBuf]) -> Result<Vec<serde_json::Value>> {
    let mut files = Vec::with_capacity(paths.len());
    let mut total_encoded = 0usize;
    for path in paths {
        let meta = std::fs::metadata(path).with_context(|| format!("Failed to stat file: {}", path.display()))?;
        anyhow::ensure!(meta.is_file(), "Not a regular file: {}", path.display());
        anyhow::ensure!(meta.len() <= MAX_DROP_FILE_SIZE, "File too large (>50 MB): {}", path.display());
        let data = std::fs::read(path).with_context(|| format!("Failed to read file: {}", path.display()))?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&data);
        total_encoded += encoded.len();
        anyhow::ensure!(total_encoded <= MAX_TOTAL_DROP_SIZE, "Total file payload exceeds 100 MB limit");
        let name = path
            .file_name()
            .with_context(|| format!("File path has no file name: {}", path.display()))?
            .to_string_lossy()
            .into_owned();
        files.push(json!({"name": name, "type": mime_from_ext(path), "data": encoded}));
    }
    Ok(files)
}

pub async fn run_drop_command(
    client: &mut Client, target: &str, file: Vec<std::path::PathBuf>, window: Option<&str>,
) -> Result<serde_json::Value> {
    let mut p = target_params(target);
    p["files"] = json!(encode_files(&file)?);
    client.call("drop", with_scope(Some(p), Scope { window, ..Scope::default() })).await
}

pub async fn run_set_input_files_command(
    client: &mut Client, target: &str, files: Vec<std::path::PathBuf>, window: Option<&str>,
) -> Result<serde_json::Value> {
    let mut p = target_params(target);
    // An empty list is meaningful here, unlike for `drop`: it deselects.
    p["files"] = json!(encode_files(&files)?);
    client.call("setInputFiles", with_scope(Some(p), Scope { window, ..Scope::default() })).await
}

pub fn target_params(raw: &str) -> serde_json::Value {
    match parse_target(raw) {
        Target::Ref(r) => json!({"ref": r}),
        Target::Selector(s) => json!({"selector": s}),
        Target::Coords(x, y) => json!({"x": x, "y": y}),
    }
}

/// Build params for the `wait` RPC call.
///
/// Routing precedence:
/// - `--selector` flag wins over positional target.
/// - Positional target is parsed via [`parse_target`] (`@x` ref, else selector).
///   Coords are not meaningful for `wait`, so they pass through as a selector
///   so the bridge surfaces a `SyntaxError` from `document.querySelector`
///   instead of silently timing out.
/// - With neither target nor selector, only `gone`/`timeout` are sent and the
///   bridge `waitFor` rejects up-front (issue #74).
pub fn build_wait_params(
    target: Option<&str>, selector: Option<&str>, expression: Option<&str>, poll: Option<u64>, gone: bool, timeout: u64,
) -> serde_json::Value {
    // An expression wait has no element to observe, so `gone` is meaningless
    // here and clap rejects the combination up front. Send only what the
    // bridge's expression branch reads.
    if let Some(expression) = expression {
        let mut params = json!({ "expression": expression, "timeout": timeout });
        if let Some(poll) = poll {
            params["poll"] = json!(poll);
        }
        return params;
    }
    match (selector, target) {
        (Some(s), _) => json!({ "selector": s, "gone": gone, "timeout": timeout }),
        (None, Some(t)) => match parse_target(t) {
            // `@` alone strips to an empty ref. Drop it so the bridge's
            // `waitFor` rejects up-front instead of hanging on a
            // `MutationObserver` until the timeout fires.
            Target::Ref(r) if r.is_empty() => json!({ "gone": gone, "timeout": timeout }),
            Target::Ref(r) => json!({ "ref": r, "gone": gone, "timeout": timeout }),
            Target::Selector(s) => json!({ "selector": s, "gone": gone, "timeout": timeout }),
            Target::Coords(..) => json!({ "selector": t, "gone": gone, "timeout": timeout }),
        },
        (None, None) => json!({ "gone": gone, "timeout": timeout }),
    }
}

pub fn mime_from_ext(path: &std::path::Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("pdf") => "application/pdf",
        Some("json") => "application/json",
        Some("txt") => "text/plain",
        Some("html" | "htm") => "text/html",
        Some("css") => "text/css",
        Some("js") => "application/javascript",
        Some("csv") => "text/csv",
        Some("xml") => "application/xml",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}

pub async fn run_replay_command(
    client: &mut Client, path: &std::path::Path, export: Option<&str>, window: Option<&str>,
) -> Result<Value> {
    let entries = read_replay_entries(path)?;

    if let Some(fmt) = export {
        return export_replay_command(&entries, fmt);
    }

    let total = entries.len();
    let mut prev_ts: u64 = 0;
    let mut passed = 0;
    let mut skipped = 0;

    for (i, entry) in entries.iter().enumerate() {
        let action = entry.get("action").and_then(|a| a.as_str()).unwrap_or("unknown");
        let timestamp = entry.get("timestamp").and_then(serde_json::Value::as_u64).unwrap_or(0);

        let delta = timestamp.saturating_sub(prev_ts);
        if delta > 0 && i > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(delta)).await;
        }
        prev_ts = timestamp;

        if !is_replayable(action) {
            skipped += 1;
            eprintln!("{}", format_replay_step(i + 1, total, action, "SKIP"));
            continue;
        }

        let mut params = serde_json::Map::new();
        if let Some(obj) = entry.as_object() {
            for (k, v) in obj {
                if k != "action" && k != "timestamp" {
                    params.insert(k.clone(), v.clone());
                }
            }
        }

        if let Some(w) = window {
            params.insert("window".to_string(), Value::String(w.to_string()));
        }

        let result = client.call(action, Some(Value::Object(params))).await;

        let status = if result.is_ok() {
            passed += 1;
            "ok"
        } else {
            "FAIL"
        };
        eprintln!("{}", format_replay_step(i + 1, total, action, status));
    }

    let executed = total - skipped;
    let status = if passed == executed { "ok" } else { "failed" };
    Ok(serde_json::json!({
        "status": status,
        "total": total,
        "passed": passed,
        "skipped": skipped,
        "failed": executed - passed
    }))
}

pub fn read_replay_entries(path: &std::path::Path) -> Result<Vec<serde_json::Value>> {
    let content =
        std::fs::read_to_string(path).with_context(|| format!("Failed to read recording file: {}", path.display()))?;
    serde_json::from_str(&content).context("Invalid recording file format")
}

pub fn export_replay_file(path: &std::path::Path, export: &str) -> Result<Value> {
    let entries = read_replay_entries(path)?;
    export_replay_command(&entries, export)
}

pub fn export_replay_command(entries: &[Value], export: &str) -> Result<Value> {
    if export == "sh" {
        return Ok(Value::String(export_shell_script(entries)));
    }
    anyhow::bail!("unsupported export format: {export}; supported: sh")
}

pub fn export_shell_script(entries: &[Value]) -> String {
    let mut script = String::from("#!/bin/bash\n# Generated by tauri-hasgard record/replay\n\n");
    let mut prev_ts: u64 = 0;

    for (i, entry) in entries.iter().enumerate() {
        let action = entry.get("action").and_then(|a| a.as_str()).unwrap_or("unknown");
        let timestamp = entry.get("timestamp").and_then(serde_json::Value::as_u64).unwrap_or(0);

        let delta = timestamp.saturating_sub(prev_ts);
        if delta > 0 && i > 0 {
            let secs = std::time::Duration::from_millis(delta).as_secs_f64();
            let _ = writeln!(script, "sleep {secs:.1}");
        }
        prev_ts = timestamp;

        let command = entry_to_cli_command(action, entry);
        if let (Some(window), Some(arguments)) =
            (entry.get("window").and_then(Value::as_str), command.strip_prefix("tauri-hasgard "))
        {
            let _ = write!(script, "tauri-hasgard --window {} {arguments}", shell_escape(window));
        } else {
            script.push_str(&command);
        }
        script.push('\n');
    }

    script
}

/// Wrap a string in single quotes with proper escaping for shell safety.
pub fn shell_escape(s: &str) -> String {
    let mut escaped = String::with_capacity(s.len() + 2);
    escaped.push('\'');
    for c in s.chars() {
        if c == '\'' {
            escaped.push_str("'\\''");
        } else {
            escaped.push(c);
        }
    }
    escaped.push('\'');
    escaped
}

/// Build a shell-safe CLI target for element refs (e.g. `@e1`).
pub fn shell_escape_ref_target(ref_id: &str) -> String {
    shell_escape(&format!("@{ref_id}"))
}

/// Returns `true` for actions that are safe to replay.
pub fn is_replayable(action: &str) -> bool {
    matches!(
        action,
        "click"
            | "fill"
            | "type"
            | "press"
            | "select"
            | "check"
            | "scroll"
            | "drag"
            | "drop"
            | "navigate"
            | "snapshot"
            | "wait"
            | "eval"
    )
}

/// Extract a CLI target string from a nested source/target object.
/// Handles `{"ref": "e3"}`, `{"selector": ".foo"}`, and `{"x": N, "y": N}`.
pub fn resolve_export_target(val: Option<&Value>) -> Option<String> {
    let obj = val?;
    if let Some(r) = obj.get("ref").and_then(|r| r.as_str()) {
        return Some(shell_escape_ref_target(r));
    }
    if let Some(s) = obj.get("selector").and_then(|s| s.as_str()) {
        return Some(shell_escape(s));
    }
    if let (Some(x), Some(y)) =
        (obj.get("x").and_then(serde_json::Value::as_i64), obj.get("y").and_then(serde_json::Value::as_i64))
    {
        return Some(format!("{x},{y}"));
    }
    None
}

pub fn entry_to_cli_command(action: &str, entry: &Value) -> String {
    let ref_id = entry.get("ref").and_then(|r| r.as_str());
    let selector = entry.get("selector").and_then(|s| s.as_str());
    let target = if let Some(r) = ref_id {
        shell_escape_ref_target(r)
    } else if let Some(s) = selector {
        shell_escape(s)
    } else {
        String::new()
    };

    match action {
        "click" => format!("tauri-hasgard click {target}"),
        "fill" => {
            let value = entry.get("value").and_then(|v| v.as_str()).unwrap_or("");
            format!("tauri-hasgard fill {target} {}", shell_escape(value))
        }
        "type" => {
            let text = entry.get("text").and_then(|v| v.as_str()).unwrap_or("");
            format!("tauri-hasgard type {target} {}", shell_escape(text))
        }
        "press" => {
            let key = entry.get("key").and_then(|k| k.as_str()).unwrap_or("");
            format!("tauri-hasgard press {}", shell_escape(key))
        }
        "select" => {
            let value = entry.get("value").and_then(|v| v.as_str()).unwrap_or("");
            format!("tauri-hasgard select {target} {}", shell_escape(value))
        }
        "check" => format!("tauri-hasgard check {target}"),
        "scroll" => {
            let dir = entry.get("direction").and_then(|d| d.as_str()).unwrap_or("down");
            let mut cmd = format!("tauri-hasgard scroll {}", shell_escape(dir));
            if let Some(amt) = entry.get("amount").and_then(serde_json::Value::as_i64) {
                let _ = write!(cmd, " {amt}");
            }
            if let Some(r) = entry.get("ref").and_then(|r| r.as_str()) {
                let _ = write!(cmd, " --ref {}", shell_escape_ref_target(r));
            }
            cmd
        }
        "drag" => {
            let src = resolve_export_target(entry.get("source"));
            let dst = resolve_export_target(entry.get("target"));
            // Offsets may be stored as floats (browser getBoundingClientRect
            // returns fractional pixels). The CLI --offset parser accepts
            // f64 values, so pass them through without truncation.
            let offset = entry.get("offset").and_then(|o| {
                let x = o.get("x").and_then(serde_json::Value::as_f64)?;
                let y = o.get("y").and_then(serde_json::Value::as_f64)?;
                Some(format!("{x},{y}"))
            });
            match (src, dst, offset) {
                (Some(s), Some(d), _) => format!("tauri-hasgard drag {s} {d}"),
                (Some(s), None, Some(off)) => format!("tauri-hasgard drag {s} --offset {off}"),
                (Some(s), None, None) => format!("tauri-hasgard drag {s}"),
                _ => "# drag: missing source ref/selector".to_string(),
            }
        }
        "drop" => {
            // drop requires --file with file data; cannot be fully exported
            // as a shell command since recordings store base64 file contents.
            format!("# drop {target} (requires --file; not exportable)")
        }
        "navigate" => {
            let url = entry.get("url").and_then(|u| u.as_str()).unwrap_or("");
            format!("tauri-hasgard navigate {}", shell_escape(url))
        }
        _ => {
            let safe = action.replace(['\n', '\r'], " ");
            format!("# unknown action: {safe}")
        }
    }
}

/// Resolve the socket path from explicit arg, env var, or auto-detection.
pub fn resolve_socket(explicit: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        return Ok(path);
    }

    #[cfg(unix)]
    {
        if let Some(xdg) = std::env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty()) {
            let xdg = PathBuf::from(xdg);
            if let Some(socket) = newest_socket_in_dir(&xdg) {
                return Ok(socket);
            }
        }

        newest_socket_in_dir(Path::new("/tmp"))
            .ok_or_else(|| anyhow::anyhow!("No tauri-hasgard socket found. Is a Tauri app running?"))
    }

    #[cfg(windows)]
    {
        resolve_socket_windows()
    }
}

#[cfg(windows)]
pub fn resolve_socket_windows() -> Result<PathBuf> {
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    fn is_pid_alive(pid: u32) -> bool {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) };
        match handle {
            Ok(h) => {
                let alive = unsafe {
                    let mut exit_code: u32 = 0;
                    GetExitCodeProcess(h, &raw mut exit_code).is_ok() && exit_code == STILL_ACTIVE.0 as u32
                };
                unsafe {
                    let _ = CloseHandle(h);
                }
                alive
            }
            Err(_) => false,
        }
    }

    #[derive(serde::Deserialize)]
    struct InstanceEntry {
        pid: u32,
        pipe: String,
        created_at: u64,
    }

    let local_app_data = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty()).ok_or_else(|| {
        anyhow::anyhow!(
            "LOCALAPPDATA environment variable is not set or empty. \
                 Is a Tauri app running?"
        )
    })?;

    let instances_dir = PathBuf::from(local_app_data).join("tauri-hasgard").join("instances");

    if !instances_dir.exists() {
        anyhow::bail!(
            "No tauri-hasgard instances directory found at {}. \
             Is a Tauri app running?",
            instances_dir.display()
        );
    }

    let mut newest: Option<(u64, PathBuf)> = None;
    for entry in std::fs::read_dir(&instances_dir)?.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "skipping corrupted instance file");
                continue;
            }
        };
        let info: InstanceEntry = match serde_json::from_str(&content) {
            Ok(i) => i,
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "skipping malformed instance file");
                continue;
            }
        };
        if !is_pid_alive(info.pid) {
            tracing::debug!(pid = info.pid, path = %path.display(), "skipping stale instance");
            continue;
        }
        let should_update = match newest {
            None => true,
            Some((current_max, _)) => info.created_at > current_max,
        };
        if should_update {
            newest = Some((info.created_at, PathBuf::from(info.pipe)));
        }
    }

    newest
        .map(|(_, pipe)| pipe)
        .ok_or_else(|| anyhow::anyhow!("No active tauri-hasgard instance found. Is a Tauri app running?"))
}

#[cfg(not(windows))]
pub fn newest_socket_in_dir(dir: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                n.starts_with("tauri-hasgard-")
                    && std::path::Path::new(n).extension().is_some_and(|ext| ext.eq_ignore_ascii_case("sock"))
            })
        })
        .filter(|p| {
            use std::os::unix::fs::MetadataExt;
            // SAFETY: getuid() has no preconditions.
            let my_uid = unsafe { libc::getuid() };
            std::fs::metadata(p).is_ok_and(|m| m.uid() == my_uid)
        })
        .collect();

    candidates
        .sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).unwrap_or(std::time::SystemTime::UNIX_EPOCH));

    candidates.pop()
}

/// Format a single replay step.
///
/// Returns a string like "[3/10] click @e3 → ok" with color based on result.
pub fn format_replay_step(step: usize, total: usize, action: &str, result: &str) -> String {
    let action_safe = strip_ansi(action);
    let result_display = if result == "ok" { crate::style::success(result) } else { crate::style::error(result) };
    format!(
        "{} {} \u{2192} {result_display}",
        crate::style::dim(format!("[{step}/{total}]")),
        crate::style::info(action_safe)
    )
}

/// Strip ANSI escape sequences and C0 control characters from a string
/// to prevent terminal injection.
pub fn strip_ansi(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Skip CSI sequences: ESC [ ... final_byte
            if chars.peek() == Some(&'[') {
                chars.next(); // consume '['
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if next.is_ascii_alphabetic() || next == '~' {
                        break;
                    }
                }
            // Skip OSC sequences: ESC ] ... BEL or ESC \ (ST)
            } else if chars.peek() == Some(&']') {
                chars.next();
                let mut prev_was_esc = false;
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if next == '\x07' {
                        break;
                    }
                    if prev_was_esc && next == '\\' {
                        break;
                    }
                    prev_was_esc = next == '\x1b';
                }
            } else {
                // Skip single-char escape (ESC + one char)
                chars.next();
            }
        } else if c.is_control() && c != '\n' && c != '\t' && c != '\r' {
            // Strip C0/C1 control characters (except common whitespace)
        } else {
            result.push(c);
        }
    }
    result
}
