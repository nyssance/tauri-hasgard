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

/// Inline file data must fit in one request beside the rest of its params. Past
/// this the files are named by path and the application reads them itself.
pub const MAX_INLINE_FILE_BYTES: usize = crate::protocol::MAX_REQUEST_BYTES / 2;

/// Turn local paths into the `files` entries of `drop` and `setInputFiles`.
///
/// Small files travel inline as `{name, type, data}`, read here, so they work
/// even when the application cannot read the caller's files. Once the encoded
/// total would crowd the request limit, every file is sent as `{name, type,
/// path}` and read by the application, which has no such limit.
///
/// Shared by `drop` and `set-input-files` so the two cannot diverge on MIME
/// guessing or on what counts as a readable file.
pub fn encode_files(paths: &[std::path::PathBuf]) -> Result<Vec<serde_json::Value>> {
    let mut entries = Vec::with_capacity(paths.len());
    let mut total_encoded = 0usize;
    for path in paths {
        let meta = std::fs::metadata(path).with_context(|| format!("Failed to stat file: {}", path.display()))?;
        anyhow::ensure!(meta.is_file(), "Not a regular file: {}", path.display());
        let encoded_len = usize::try_from(meta.len().div_ceil(3).saturating_mul(4)).unwrap_or(usize::MAX);
        total_encoded = total_encoded.saturating_add(encoded_len);
        let name = path
            .file_name()
            .with_context(|| format!("File path has no file name: {}", path.display()))?
            .to_string_lossy()
            .into_owned();
        entries.push((path, name));
    }
    let inline = total_encoded <= MAX_INLINE_FILE_BYTES;
    entries
        .into_iter()
        .map(|(path, name)| {
            if inline {
                let data = std::fs::read(path).with_context(|| format!("Failed to read file: {}", path.display()))?;
                let encoded = base64::engine::general_purpose::STANDARD.encode(&data);
                Ok(json!({"name": name, "type": mime_from_ext(path), "data": encoded}))
            } else {
                let absolute = std::path::absolute(path)
                    .with_context(|| format!("Failed to resolve file path: {}", path.display()))?;
                Ok(json!({"name": name, "type": mime_from_ext(path), "path": absolute}))
            }
        })
        .collect()
}

pub async fn run_drop_command(
    client: &mut Client, target: &str, file: Vec<std::path::PathBuf>, scope: Scope<'_>,
) -> Result<serde_json::Value> {
    let mut p = target_params(target);
    p["files"] = json!(encode_files(&file)?);
    client.call("drop", with_scope(Some(p), scope)).await
}

pub async fn run_set_input_files_command(
    client: &mut Client, target: &str, files: Vec<std::path::PathBuf>, scope: Scope<'_>,
) -> Result<serde_json::Value> {
    let mut p = target_params(target);
    // An empty list is meaningful here, unlike for `drop`: it deselects.
    p["files"] = json!(encode_files(&files)?);
    client.call("setInputFiles", with_scope(Some(p), scope)).await
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

/// The protocol method and params for a native window action.
///
/// `size` is width and height, `position` is x and y, both in logical pixels.
pub fn window_request(
    action: &str, size: Option<(f64, f64)>, position: Option<(f64, f64)>,
) -> Result<(&'static str, Option<serde_json::Value>)> {
    Ok(match action {
        "state" => ("window.state", None),
        "resize" => {
            let (width, height) = size.context("window resize requires a width and a height")?;
            ("window.resize", Some(json!({"width": width, "height": height})))
        }
        "move" => {
            let (x, y) = position.context("window move requires x and y")?;
            ("window.move", Some(json!({"x": x, "y": y})))
        }
        "minimize" => ("window.minimize", None),
        "maximize" => ("window.maximize", None),
        "restore" => ("window.restore", None),
        "close" => ("window.close", None),
        other => anyhow::bail!(
            "unknown window action: {other}; expected state, resize, move, minimize, maximize, restore or close"
        ),
    })
}

/// Params for a `wait` on where the window is rather than on an element.
pub fn build_location_wait_params(url: Option<&str>, load: Option<&str>, timeout: u64) -> serde_json::Value {
    let mut params = json!({ "timeout": timeout });
    if let Some(url) = url {
        params["url"] = json!(url);
    }
    if let Some(load) = load {
        params["load"] = json!(load);
    }
    params
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
        let (action, timestamp) = replay_step(i, entry)?;

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

        // An event recorded without a window was sent to every listener; naming one on replay
        // would narrow it to that window's.
        let broadcast = action == "event.emit" && !params.contains_key("window");
        if let Some(w) = window
            && !broadcast
        {
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
        return Ok(Value::String(export_shell_script(entries)?));
    }
    anyhow::bail!("unsupported export format: {export}; supported: sh")
}

/// The `action` and `timestamp` every recorded entry carries. A recording
/// without them is damaged; replaying it as an unknown action at time zero
/// would report a run that never happened.
fn replay_step(index: usize, entry: &Value) -> Result<(&str, u64)> {
    let action = entry
        .get("action")
        .and_then(Value::as_str)
        .with_context(|| format!("Recording entry {} has no string 'action'", index + 1))?;
    let timestamp = entry
        .get("timestamp")
        .and_then(Value::as_u64)
        .with_context(|| format!("Recording entry {} has no integer 'timestamp'", index + 1))?;
    Ok((action, timestamp))
}

pub fn export_shell_script(entries: &[Value]) -> Result<String> {
    let mut script = String::from("#!/bin/bash\n# Generated by tauri-hasgard record/replay\n\n");
    let mut prev_ts: u64 = 0;

    for (i, entry) in entries.iter().enumerate() {
        let (action, timestamp) = replay_step(i, entry)?;

        let delta = timestamp.saturating_sub(prev_ts);
        if delta > 0 && i > 0 {
            let secs = std::time::Duration::from_millis(delta).as_secs_f64();
            let _ = writeln!(script, "sleep {secs:.1}");
        }
        prev_ts = timestamp;

        script.push_str(&scoped_cli_command(action, entry));
        script.push('\n');
    }

    Ok(script)
}

/// The command for one recorded entry, aimed at the window and the frame it was recorded in.
pub fn scoped_cli_command(action: &str, entry: &Value) -> String {
    let command = entry_to_cli_command(action, entry);
    let Some(arguments) = command.strip_prefix("tauri-hasgard ") else {
        // A comment: there is no command to scope.
        return command;
    };
    let mut scope = String::new();
    if let Some(window) = entry.get("window").and_then(Value::as_str) {
        let _ = write!(scope, "--window {} ", shell_escape(window));
    }
    // One selector per nesting level, outermost first; a single frame may be recorded bare.
    let frames: Vec<&str> = match entry.get("frame") {
        Some(Value::String(frame)) => vec![frame],
        Some(Value::Array(frames)) => frames.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    for frame in frames {
        let _ = write!(scope, "--frame {} ", shell_escape(frame));
    }
    format!("tauri-hasgard {scope}{arguments}")
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
            | "hover"
            | "focus"
            | "blur"
            | "dblclick"
            | "drag"
            | "drop"
            | "navigate"
            | "snapshot"
            | "wait"
            | "eval"
            | "wheel"
            | "setInputFiles"
            | "dialog.handle"
            | "nativeDialog.handle"
            | "route.add"
            | "route.clear"
            | "storage.set"
            | "storage.clear"
            | "cookies.set"
            | "cookies.clear"
            | "window.resize"
            | "window.move"
            | "event.emit"
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
        (obj.get("x").and_then(serde_json::Value::as_f64), obj.get("y").and_then(serde_json::Value::as_f64))
    {
        return Some(format!("{x},{y}"));
    }
    None
}

fn recorded_text<'a>(entry: &'a Value, field: &str) -> Option<&'a str> {
    entry.get(field).and_then(Value::as_str)
}

fn missing_field(action: &str, field: &str) -> String {
    format!("# {action}: the recording has no {field}")
}

pub fn entry_to_cli_command(action: &str, entry: &Value) -> String {
    // A ref, a selector, or a point: whatever the action was aimed at.
    let target = resolve_export_target(Some(entry)).unwrap_or_default();

    // A command missing what it acts on would run and do something else; say what is missing instead.
    if target.is_empty()
        && matches!(action, "click" | "fill" | "type" | "select" | "check" | "hover" | "focus" | "blur" | "dblclick")
    {
        return missing_field(action, "ref, selector or point");
    }
    match action {
        "click" => {
            let mut cmd = format!("tauri-hasgard click {target}");
            for modifier in
                entry.get("modifiers").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)
            {
                let _ = write!(cmd, " --modifier {}", shell_escape(modifier));
            }
            if let Some(button) = recorded_text(entry, "button") {
                let _ = write!(cmd, " --button {}", shell_escape(button));
            }
            if let Some(count) = entry.get("clickCount").and_then(Value::as_u64) {
                let _ = write!(cmd, " --click-count {count}");
            }
            let offset = |axis: &str| entry.get("position").and_then(|p| p.get(axis)).and_then(Value::as_f64);
            if let (Some(x), Some(y)) = (offset("x"), offset("y")) {
                let _ = write!(cmd, " --position {x},{y}");
            }
            cmd
        }
        "fill" => match recorded_text(entry, "value") {
            Some(value) => format!("tauri-hasgard fill {target} {}", shell_escape(value)),
            None => missing_field(action, "value"),
        },
        "type" => match recorded_text(entry, "text") {
            Some(text) => format!("tauri-hasgard type {target} {}", shell_escape(text)),
            None => missing_field(action, "text"),
        },
        "press" => match recorded_text(entry, "key") {
            Some(key) => format!("tauri-hasgard press {}", shell_escape(key)),
            None => missing_field(action, "key"),
        },
        "select" => {
            let several = entry.get("values").and_then(Value::as_array);
            let chosen: Vec<&str> = match (recorded_text(entry, "value"), several) {
                (Some(value), _) => vec![value],
                (None, Some(values)) => values.iter().filter_map(Value::as_str).collect(),
                (None, None) => Vec::new(),
            };
            if chosen.is_empty() {
                return missing_field(action, "value");
            }
            let mut cmd = format!("tauri-hasgard select {target}");
            for value in chosen {
                let _ = write!(cmd, " {}", shell_escape(value));
            }
            cmd
        }
        // Without a recorded state the action was a toggle, and exports as one.
        "check" => match entry.get("checked").and_then(Value::as_bool) {
            Some(checked) => format!("tauri-hasgard check {target} --state {}", if checked { "on" } else { "off" }),
            None => format!("tauri-hasgard check {target}"),
        },
        "hover" | "focus" | "blur" | "dblclick" => format!("tauri-hasgard {action} {target}"),
        "scroll" => {
            // The protocol's own default direction.
            let dir = recorded_text(entry, "direction").unwrap_or("down");
            let mut cmd = format!("tauri-hasgard scroll {}", shell_escape(dir));
            if let Some(amt) = entry.get("amount").and_then(serde_json::Value::as_i64) {
                let _ = write!(cmd, " {amt}");
            }
            // A scroll of an element names it; without one the document scrolls.
            if !target.is_empty() {
                let _ = write!(cmd, " --target {target}");
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
        "navigate" => match recorded_text(entry, "url") {
            Some(url) => format!("tauri-hasgard navigate {}", shell_escape(url)),
            None => missing_field(action, "url"),
        },
        _ => later_action_command(action, entry, &target),
    }
}

/// The commands for the actions recorded since the first set: input the page cannot
/// tell from a user's, and the standing state a flow depends on.
fn later_action_command(action: &str, entry: &Value, target: &str) -> String {
    match action {
        "wheel" => {
            // An axis left out is one that did not move.
            let delta = |axis: &str| entry.get(axis).and_then(Value::as_f64).unwrap_or(0.0);
            let mut cmd = format!("tauri-hasgard wheel --delta-x {} --delta-y {}", delta("deltaX"), delta("deltaY"));
            if !target.is_empty() {
                let _ = write!(cmd, " {target}");
            }
            cmd
        }
        "dialog.handle" | "nativeDialog.handle" => {
            let command = if action == "dialog.handle" { "dialog" } else { "native-dialog" };
            let Some(policy) = recorded_text(entry, "action") else {
                return missing_field(action, "action");
            };
            let mut cmd = format!("tauri-hasgard {command} {}", shell_escape(policy));
            if let Some(text) = entry.get("promptText").and_then(Value::as_str) {
                let _ = write!(cmd, " --prompt-text {}", shell_escape(text));
            }
            for path in entry.get("paths").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                let _ = write!(cmd, " --path {}", shell_escape(path));
            }
            if let Some(button) = entry.get("button").and_then(Value::as_str) {
                let _ = write!(cmd, " --button {}", shell_escape(button));
            }
            cmd
        }
        "route.clear" => "tauri-hasgard route clear".to_owned(),
        "route.add" => {
            let Some(pattern) = recorded_text(entry, "pattern") else {
                return missing_field(action, "pattern");
            };
            let abort = entry.get("action").and_then(Value::as_str) == Some("abort");
            let mut cmd =
                format!("tauri-hasgard route {} {}", if abort { "abort" } else { "fulfill" }, shell_escape(pattern));
            if !abort {
                if let Some(status) = entry.get("status").and_then(Value::as_u64) {
                    let _ = write!(cmd, " --status {status}");
                }
                if let Some(body) = entry.get("body").and_then(Value::as_str) {
                    let _ = write!(cmd, " --body {}", shell_escape(body));
                }
                if let Some(content_type) = entry.get("contentType").and_then(Value::as_str) {
                    let _ = write!(cmd, " --content-type {}", shell_escape(content_type));
                }
            }
            // Which requests the rule answers is part of the rule.
            if let Some(method) = entry.get("method").and_then(Value::as_str) {
                let _ = write!(cmd, " --method {}", shell_escape(method));
            }
            if let Some(times) = entry.get("times").and_then(Value::as_u64) {
                let _ = write!(cmd, " --times {times}");
            }
            cmd
        }
        "window.resize" | "window.move" => {
            let (verb, first, second) =
                if action == "window.resize" { ("resize", "width", "height") } else { ("move", "x", "y") };
            let number = |field: &str| entry.get(field).and_then(Value::as_f64);
            match (number(first), number(second)) {
                (Some(a), Some(b)) => format!("tauri-hasgard window {verb} {a} {b}"),
                _ => missing_field(action, &format!("{first} and {second}")),
            }
        }
        "event.emit" => {
            let Some(event) = recorded_text(entry, "event") else {
                return missing_field(action, "event");
            };
            let payload = entry.get("payload").map_or_else(|| "null".to_owned(), Value::to_string);
            format!("tauri-hasgard event emit {} --payload {}", shell_escape(event), shell_escape(&payload))
        }
        "storage.set" | "storage.clear" => {
            let session = if entry.get("session").and_then(Value::as_bool) == Some(true) { " --session" } else { "" };
            if action == "storage.clear" {
                return format!("tauri-hasgard storage{session} clear");
            }
            match (recorded_text(entry, "key"), recorded_text(entry, "value")) {
                (Some(key), Some(value)) => {
                    format!("tauri-hasgard storage{session} set {} {}", shell_escape(key), shell_escape(value))
                }
                _ => missing_field(action, "key and value"),
            }
        }
        "cookies.clear" => {
            let mut cmd = "tauri-hasgard cookies clear".to_owned();
            for filter in ["url", "name", "domain"] {
                if let Some(value) = recorded_text(entry, filter) {
                    let _ = write!(cmd, " --{filter} {}", shell_escape(value));
                }
            }
            cmd
        }
        // These carry data a one-line command cannot: file contents, or a cookie's many fields.
        "setInputFiles" | "cookies.set" => {
            format!("# {action}: replayed from the recording; not exportable as one command")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_exported_command_names_what_the_recording_lacks_instead_of_running_without_it() {
        assert_eq!(
            entry_to_cli_command("fill", &serde_json::json!({"selector": "#a"})),
            "# fill: the recording has no value"
        );
        assert_eq!(
            entry_to_cli_command("click", &serde_json::json!({})),
            "# click: the recording has no ref, selector or point"
        );
        assert_eq!(entry_to_cli_command("navigate", &serde_json::json!({})), "# navigate: the recording has no url");
        assert_eq!(
            entry_to_cli_command("window.resize", &serde_json::json!({"width": 800})),
            "# window.resize: the recording has no width and height"
        );
        assert_eq!(
            entry_to_cli_command("route.add", &serde_json::json!({"action": "abort"})),
            "# route.add: the recording has no pattern"
        );
        // An empty value is a value: clearing a field is a real action.
        assert!(
            entry_to_cli_command("fill", &serde_json::json!({"selector": "#a", "value": ""}))
                .starts_with("tauri-hasgard fill ")
        );
    }

    #[test]
    fn an_exported_route_and_scroll_keep_what_narrows_them() {
        let route = serde_json::json!({
            "pattern": "**/api", "status": 201, "body": "{}", "contentType": "application/json",
            "method": "POST", "times": 1
        });
        let command = entry_to_cli_command("route.add", &route);
        for part in
            ["route fulfill", "--status 201", "--content-type", "application/json", "--method", "POST", "--times 1"]
        {
            assert!(command.contains(part), "{command} lacks {part}");
        }
        let abort = entry_to_cli_command(
            "route.add",
            &serde_json::json!({"pattern": "**/x", "action": "abort", "method": "GET"}),
        );
        assert!(abort.contains("route abort") && abort.contains("--method") && !abort.contains("--status"), "{abort}");
        // A scroll of an element must not export as a scroll of the document.
        let scroll = entry_to_cli_command("scroll", &serde_json::json!({"direction": "down", "selector": "#list"}));
        assert!(scroll.contains("--target") && scroll.contains("#list"), "{scroll}");
        let page = entry_to_cli_command("scroll", &serde_json::json!({"direction": "down", "amount": 40}));
        assert_eq!(page, "tauri-hasgard scroll 'down' 40");
    }

    #[test]
    fn an_exported_command_keeps_its_frame_point_and_options() {
        let json = |value: serde_json::Value| value;
        let framed = json(serde_json::json!({"selector": "#pay", "window": "main", "frame": ["#pane", "#inner"]}));
        assert_eq!(
            scoped_cli_command("click", &framed),
            "tauri-hasgard --window 'main' --frame '#pane' --frame '#inner' click '#pay'"
        );
        let bare = json(serde_json::json!({"selector": "#pay", "frame": "#pane"}));
        assert_eq!(scoped_cli_command("click", &bare), "tauri-hasgard --frame '#pane' click '#pay'");
        // A comment has nothing to scope.
        assert!(scoped_cli_command("click", &serde_json::json!({"window": "main"})).starts_with("# click"));

        let point = serde_json::json!({"x": 100, "y": 200.5, "clickCount": 2, "button": "right",
            "modifiers": ["Shift", "Meta"], "position": {"x": 3, "y": 4}});
        assert_eq!(
            entry_to_cli_command("click", &point),
            "tauri-hasgard click 100,200.5 --modifier 'Shift' --modifier 'Meta' --button 'right' --click-count 2 --position 3,4"
        );
        let scroll = entry_to_cli_command("scroll", &serde_json::json!({"direction": "down", "x": 10, "y": 20}));
        assert_eq!(scroll, "tauri-hasgard scroll 'down' --target 10,20");
        let check = entry_to_cli_command("check", &serde_json::json!({"selector": "#a", "checked": false}));
        assert_eq!(check, "tauri-hasgard check '#a' --state off");
        assert_eq!(entry_to_cli_command("check", &serde_json::json!({"selector": "#a"})), "tauri-hasgard check '#a'");
    }

    #[test]
    fn storage_and_cookie_clears_export_as_commands() {
        let set = serde_json::json!({"session": true, "key": "token", "value": "-abc"});
        assert_eq!(entry_to_cli_command("storage.set", &set), "tauri-hasgard storage --session set 'token' '-abc'");
        assert_eq!(entry_to_cli_command("storage.clear", &serde_json::json!({})), "tauri-hasgard storage clear");
        assert_eq!(
            entry_to_cli_command("storage.set", &serde_json::json!({"key": "k"})),
            "# storage.set: the recording has no key and value"
        );
        let clear = serde_json::json!({"name": "session", "domain": "app.test"});
        assert_eq!(
            entry_to_cli_command("cookies.clear", &clear),
            "tauri-hasgard cookies clear --name 'session' --domain 'app.test'"
        );
    }

    #[test]
    fn a_multiple_selection_exports_every_value() {
        let entry = serde_json::json!({"selector": "#tags", "values": ["a", "b c"]});
        let command = entry_to_cli_command("select", &entry);
        assert!(command.starts_with("tauri-hasgard select "), "{command}");
        assert!(command.contains(" a ") || command.contains(" 'a' "), "{command}");
        assert!(command.contains("b c"), "{command}");
    }

    #[test]
    fn small_files_travel_inline_and_large_ones_by_path() {
        let directory = std::env::temp_dir().join(format!("hasgard-encode-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("temp directory");
        let small = directory.join("note.txt");
        let large = directory.join("large.bin");
        std::fs::write(&small, b"hello").expect("write small");
        std::fs::write(&large, vec![1_u8; MAX_INLINE_FILE_BYTES]).expect("write large");

        assert_eq!(
            encode_files(std::slice::from_ref(&small)).expect("inline"),
            [json!({"name": "note.txt", "type": "text/plain", "data": "aGVsbG8="})]
        );
        // One large file moves the whole call to paths, the small file included.
        assert_eq!(
            encode_files(&[large.clone(), small.clone()]).expect("by path"),
            [
                json!({"name": "large.bin", "type": "application/octet-stream", "path": large}),
                json!({"name": "note.txt", "type": "text/plain", "path": small}),
            ]
        );
        assert!(encode_files(std::slice::from_ref(&directory)).is_err());
        std::fs::remove_dir_all(&directory).expect("remove temp directory");
    }
    #[test]
    fn standing_state_and_wheel_export_as_commands_and_replay() {
        for (action, entry, command) in [
            (
                "wheel",
                json!({"deltaX": 0.0, "deltaY": 120.0, "selector": "#list"}),
                "tauri-hasgard wheel --delta-x 0 --delta-y 120 '#list'",
            ),
            (
                "dialog.handle",
                json!({"action": "accept", "promptText": "ok go"}),
                "tauri-hasgard dialog 'accept' --prompt-text 'ok go'",
            ),
            (
                "nativeDialog.handle",
                json!({"action": "accept", "paths": ["/tmp/a b.csv"], "button": "Save"}),
                "tauri-hasgard native-dialog 'accept' --path '/tmp/a b.csv' --button 'Save'",
            ),
            (
                "route.add",
                json!({"pattern": "**/api/user", "action": "fulfill", "status": 503, "body": "down"}),
                "tauri-hasgard route fulfill '**/api/user' --status 503 --body 'down'",
            ),
            ("route.add", json!({"pattern": "**/x", "action": "abort"}), "tauri-hasgard route abort '**/x'"),
            ("route.clear", json!({}), "tauri-hasgard route clear"),
            ("window.resize", json!({"width": 480.0, "height": 800.0}), "tauri-hasgard window resize 480 800"),
            (
                "event.emit",
                json!({"event": "sync:done", "payload": {"n": 1}}),
                "tauri-hasgard event emit 'sync:done' --payload '{\"n\":1}'",
            ),
        ] {
            assert!(is_replayable(action), "{action} must replay");
            assert_eq!(entry_to_cli_command(action, &entry), command);
        }
        assert!(entry_to_cli_command("setInputFiles", &json!({})).starts_with("# setInputFiles"));
        assert!(is_replayable("setInputFiles"));
    }
}
