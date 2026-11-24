#![allow(
    clippy::must_use_candidate,
    clippy::missing_errors_doc,
    clippy::missing_panics_doc,
    reason = "shared with the tauri-hasgard CLI; not a stable API"
)]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::client::Client;
use crate::support::{Scope, build_wait_params, target_params, with_scope};

// ── TOML schema ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scenario {
    pub connect: Option<Connect>,
    #[serde(default)]
    pub scenario: ScenarioMeta,
    #[serde(default)]
    pub step: Vec<Step>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Connect {
    pub socket: Option<PathBuf>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScenarioMeta {
    pub name: Option<String>,
    #[serde(default = "default_true")]
    pub fail_fast: bool,
    pub global_timeout_ms: Option<u64>,
}

impl Default for ScenarioMeta {
    fn default() -> Self {
        Self { name: None, fail_fast: true, global_timeout_ms: None }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub name: Option<String>,
    pub action: String,
    pub timeout_ms: Option<u64>,
    pub target: Option<String>,
    pub value: Option<String>,
    pub text: Option<String>,
    pub key: Option<String>,
    pub session: Option<bool>,
    pub url: Option<String>,
    pub script: Option<String>,
    pub expected: Option<String>,
    pub selector: Option<String>,
    pub direction: Option<String>,
    pub amount: Option<i32>,
    #[serde(rename = "ref")]
    pub step_ref: Option<String>,
    pub gone: Option<bool>,
    pub stable: Option<u64>,
    pub require_mutation: Option<bool>,
    pub path: Option<PathBuf>,
    /// `drag`: where the source is dropped.
    pub to: Option<String>,
    /// `set-input-files`: the files to attach; an empty list clears the input.
    pub files: Option<Vec<PathBuf>>,
    /// `dialog` and `native-dialog`: `accept`, `dismiss`, or for native dialogs `manual`.
    pub policy: Option<String>,
    /// `native-dialog`: what an open or save dialog returns.
    pub paths: Option<Vec<String>>,
    /// `native-dialog`: the message dialog button to press.
    pub button: Option<String>,
    /// `route`: the URL glob to answer, or `clear = true` to remove every rule.
    pub pattern: Option<String>,
    pub status: Option<u16>,
    pub body: Option<String>,
    pub content_type: Option<String>,
    pub method: Option<String>,
    pub abort: Option<bool>,
    pub clear: Option<bool>,
    /// `wheel`: pixels to scroll.
    pub delta_x: Option<f64>,
    pub delta_y: Option<f64>,
    /// `ipc`: the Tauri command and its arguments.
    pub command: Option<String>,
    pub args: Option<toml::Value>,
    /// `select`: several options in a multiple select, instead of `value`.
    pub values: Option<Vec<String>>,
}

impl Step {
    fn display_name(&self, idx: usize) -> String {
        self.name.clone().unwrap_or_else(|| format!("step-{}", idx + 1))
    }
}

// ── Execution result types ────────────────────────────────────────────────────

#[derive(Debug)]
pub enum StepOutcome {
    Passed { duration: Duration },
    Failed { duration: Duration, message: String },
    Skipped,
}

#[derive(Debug)]
pub struct StepResult {
    pub name: String,
    pub outcome: StepOutcome,
}

#[derive(Debug)]
pub struct ScenarioReport {
    pub name: String,
    pub results: Vec<StepResult>,
    pub total_duration: Duration,
}

impl ScenarioReport {
    #[must_use]
    pub fn passed(&self) -> usize {
        self.results.iter().filter(|r| matches!(r.outcome, StepOutcome::Passed { .. })).count()
    }

    #[must_use]
    pub fn failed(&self) -> usize {
        self.results.iter().filter(|r| matches!(r.outcome, StepOutcome::Failed { .. })).count()
    }

    #[must_use]
    pub fn skipped(&self) -> usize {
        self.results.iter().filter(|r| matches!(r.outcome, StepOutcome::Skipped)).count()
    }

    #[must_use]
    pub fn all_passed(&self) -> bool {
        self.failed() == 0
    }
}

// ── Main runner ───────────────────────────────────────────────────────────────

pub fn load_scenario(path: &Path) -> Result<Scenario> {
    let content =
        std::fs::read_to_string(path).with_context(|| format!("Failed to read scenario file: {}", path.display()))?;
    parse_scenario(&content).with_context(|| format!("Failed to parse scenario TOML: {}", path.display()))
}

pub fn parse_scenario(content: &str) -> Result<Scenario> {
    let scenario: Scenario = toml::from_str(content)?;
    anyhow::ensure!(!scenario.step.is_empty(), "scenario requires at least one step");
    for (index, step) in scenario.step.iter().enumerate() {
        validate_step(step).with_context(|| format!("invalid step {} ({})", index + 1, step.display_name(index)))?;
    }
    Ok(scenario)
}

fn validate_step(step: &Step) -> Result<()> {
    let required: &[(&str, Option<&str>)] = match step.action.as_str() {
        "click" | "dblclick" | "hover" | "focus" | "blur" | "set-input-files" | "assert-exists" | "assert-visible"
        | "assert-hidden" => &[("target", step.target.as_deref())],
        "select" if step.values.is_some() => &[("target", step.target.as_deref())],
        "fill" | "select" => &[("target", step.target.as_deref()), ("value", step.value.as_deref())],
        "drag" => &[("target", step.target.as_deref()), ("to", step.to.as_deref())],
        "dialog" | "native-dialog" => &[("policy", step.policy.as_deref())],
        "route" if step.clear != Some(true) => &[("pattern", step.pattern.as_deref())],
        "ipc" => &[("command", step.command.as_deref())],
        "type" => &[("target", step.target.as_deref()), ("text", step.text.as_deref())],
        "press" | "storage-get" => &[("key", step.key.as_deref())],
        "navigate" => &[("url", step.url.as_deref())],
        "eval" => &[("script", step.script.as_deref())],
        "assert-text" | "assert-value" => &[("target", step.target.as_deref()), ("expected", step.expected.as_deref())],
        "assert-url" => &[("expected", step.expected.as_deref())],
        "scroll" | "wait" | "watch" | "screenshot" | "wheel" | "route" => &[],
        action => anyhow::bail!("unknown step action: {action:?}"),
    };
    for (name, value) in required {
        anyhow::ensure!(value.is_some(), "{} requires '{name}'", step.action);
    }
    Ok(())
}

pub async fn run_scenario(
    client: &mut Client, scenario: &Scenario, window: Option<&str>, fail_fast_override: Option<bool>,
) -> Result<ScenarioReport> {
    let run = run_scenario_steps(client, scenario, window, fail_fast_override);
    match scenario.scenario.global_timeout_ms {
        Some(ms) => tokio::time::timeout(Duration::from_millis(ms), run)
            .await
            .map_err(|_| anyhow::anyhow!("scenario exceeded global timeout of {ms}ms"))?,
        None => run.await,
    }
}

async fn run_scenario_steps(
    client: &mut Client, scenario: &Scenario, window: Option<&str>, fail_fast_override: Option<bool>,
) -> Result<ScenarioReport> {
    let meta = &scenario.scenario;
    let name = meta.name.clone().unwrap_or_else(|| "unnamed scenario".to_string());
    let fail_fast = fail_fast_override.unwrap_or(meta.fail_fast);

    let total_start = Instant::now();
    let mut results = Vec::with_capacity(scenario.step.len());
    let mut failed = false;

    for (idx, step) in scenario.step.iter().enumerate() {
        let step_name = step.display_name(idx);

        if failed && fail_fast {
            print_step_line(idx, scenario.step.len(), &step_name, "SKIP");
            results.push(StepResult { name: step_name, outcome: StepOutcome::Skipped });
            continue;
        }

        let step_start = Instant::now();

        let outcome = match run_step(client, step, window).await {
            Ok(_) => {
                let dur = step_start.elapsed();
                print_step_line(idx, scenario.step.len(), &step_name, "ok");
                StepOutcome::Passed { duration: dur }
            }
            Err(e) => {
                let dur = step_start.elapsed();
                let msg = format!("{e:#}");
                print_step_fail(idx, scenario.step.len(), &step_name, &msg);
                if let Err(error) = take_failure_screenshot(client, &step_name, window).await {
                    eprintln!("  {} {error:#}", crate::style::dim("failure screenshot not saved:"));
                }
                failed = true;
                StepOutcome::Failed { duration: dur, message: msg }
            }
        };

        results.push(StepResult { name: step_name, outcome });
    }

    Ok(ScenarioReport { name, results, total_duration: total_start.elapsed() })
}

async fn run_step(client: &mut Client, step: &Step, window: Option<&str>) -> Result<Value> {
    // wait/watch send timeout in RPC params; all other actions use a tokio deadline
    let is_rpc_timed = matches!(step.action.as_str(), "wait" | "watch");
    match (is_rpc_timed, step.timeout_ms) {
        (false, Some(ms)) => tokio::time::timeout(Duration::from_millis(ms), dispatch_step(client, step, window))
            .await
            .map_err(|_| anyhow::anyhow!("step '{}' timed out after {ms}ms", step.action))?,
        _ => dispatch_step(client, step, window).await,
    }
}

#[expect(clippy::too_many_lines)]
async fn dispatch_step(client: &mut Client, step: &Step, window: Option<&str>) -> Result<Value> {
    let timeout_ms = step.timeout_ms;
    match step.action.as_str() {
        "click" => {
            let t = require_target(step)?;
            client.call("click", with_scope(Some(target_params(t)), Scope { window, ..Scope::default() })).await
        }
        "fill" => {
            let t = require_target(step)?;
            let value = step.value.as_deref().ok_or_else(|| anyhow::anyhow!("{} requires value", step.action))?;
            let mut p = target_params(t);
            p["value"] = json!(value);
            client.call("fill", with_scope(Some(p), Scope { window, ..Scope::default() })).await
        }
        "type" => {
            let t = require_target(step)?;
            let text = step.text.as_deref().ok_or_else(|| anyhow::anyhow!("type requires text"))?;
            let mut p = target_params(t);
            p["text"] = json!(text);
            client.call("type", with_scope(Some(p), Scope { window, ..Scope::default() })).await
        }
        "press" => {
            let key = step.key.as_deref().ok_or_else(|| anyhow::anyhow!("press step requires 'key'"))?;
            client.call("press", with_scope(Some(json!({"key": key})), Scope { window, ..Scope::default() })).await
        }
        "select" => {
            let t = require_target(step)?;
            let mut p = target_params(t);
            match (&step.values, step.value.as_deref()) {
                (Some(values), None) => p["values"] = json!(values),
                (None, Some(value)) => p["value"] = json!(value),
                _ => anyhow::bail!("select takes either 'value' or 'values'"),
            }
            client.call("select", with_scope(Some(p), Scope { window, ..Scope::default() })).await
        }
        "dblclick" => {
            let mut p = target_params(require_target(step)?);
            p["clickCount"] = json!(2);
            client.call("click", with_scope(Some(p), Scope { window, ..Scope::default() })).await
        }
        action @ ("hover" | "focus" | "blur") => {
            let p = target_params(require_target(step)?);
            client.call(action, with_scope(Some(p), Scope { window, ..Scope::default() })).await
        }
        "drag" => {
            let to = step.to.as_deref().ok_or_else(|| anyhow::anyhow!("drag requires 'to'"))?;
            let p = json!({"source": target_params(require_target(step)?), "target": target_params(to)});
            client.call("drag", with_scope(Some(p), Scope { window, ..Scope::default() })).await
        }
        "set-input-files" => {
            let files = step.files.clone().unwrap_or_default();
            crate::support::run_set_input_files_command(
                client,
                require_target(step)?,
                files,
                Scope { window, ..Scope::default() },
            )
            .await
        }
        "wheel" => {
            let mut p = step.target.as_deref().map_or_else(|| json!({}), target_params);
            p["deltaX"] = json!(step.delta_x.unwrap_or(0.0));
            p["deltaY"] = json!(step.delta_y.unwrap_or(0.0));
            client.call("wheel", with_scope(Some(p), Scope { window, ..Scope::default() })).await
        }
        "dialog" => {
            let mut p = json!({"action": step.policy});
            if let Some(text) = &step.text {
                p["promptText"] = json!(text);
            }
            client.call("dialog.handle", with_scope(Some(p), Scope { window, ..Scope::default() })).await
        }
        "native-dialog" => {
            let mut p = json!({"action": step.policy});
            if let Some(paths) = &step.paths {
                p["paths"] = json!(paths);
            }
            if let Some(button) = &step.button {
                p["button"] = json!(button);
            }
            client.call("nativeDialog.handle", with_scope(Some(p), Scope { window, ..Scope::default() })).await
        }
        "route" if step.clear == Some(true) => {
            client.call("route.clear", with_scope(None, Scope { window, ..Scope::default() })).await
        }
        "route" => {
            let mut p = json!({
                "pattern": step.pattern,
                "action": if step.abort == Some(true) { "abort" } else { "fulfill" },
            });
            for (key, value) in [
                ("status", step.status.map(|status| json!(status))),
                ("body", step.body.as_ref().map(|body| json!(body))),
                ("contentType", step.content_type.as_ref().map(|kind| json!(kind))),
                ("method", step.method.as_ref().map(|method| json!(method))),
            ] {
                if let Some(value) = value {
                    p[key] = value;
                }
            }
            client.call("route.add", with_scope(Some(p), Scope { window, ..Scope::default() })).await
        }
        "ipc" => {
            let mut p = json!({"command": step.command});
            if let Some(args) = &step.args {
                p["args"] = serde_json::to_value(args).context("ipc 'args' cannot be sent as JSON")?;
            }
            let result = client.call("ipc", with_scope(Some(p), Scope { window, ..Scope::default() })).await?;
            if let Some(expected) = step.expected.as_deref() {
                let actual = result.as_str().map_or_else(|| result.to_string(), str::to_owned);
                anyhow::ensure!(actual == expected, "expected ipc result {expected:?}, got {actual:?}");
            }
            Ok(result)
        }
        "check" => {
            let t = require_target(step)?;
            client.call("check", with_scope(Some(target_params(t)), Scope { window, ..Scope::default() })).await
        }
        "scroll" => {
            let direction = step.direction.as_deref().unwrap_or("down");
            client
                .call(
                    "scroll",
                    with_scope(
                        Some(json!({
                            "direction": direction,
                            "amount": step.amount,
                            "ref": step.step_ref,
                        })),
                        Scope { window, ..Scope::default() },
                    ),
                )
                .await
        }
        "navigate" => {
            let url = step.url.as_deref().ok_or_else(|| anyhow::anyhow!("navigate step requires 'url'"))?;
            client.call("navigate", with_scope(Some(json!({"url": url})), Scope { window, ..Scope::default() })).await
        }
        "wait" => {
            let timeout = timeout_ms.unwrap_or(10_000);
            // TOML allows `ref = "e1"` on any element-targeting step. For
            // `wait` we render it as the same `@e1` syntax `parse_target`
            // accepts, so the helper stays single-input. Reject ambiguous
            // steps that set both `target` and `ref` instead of silently
            // dropping one.
            if step.target.is_some() && step.step_ref.is_some() {
                anyhow::bail!(
                    "wait step sets both `target` and `ref`; pick one (use `ref = \"e1\"` for snapshot refs, `target = \"#sel\"` for CSS selectors)"
                );
            }
            let target_from_ref = step.step_ref.as_deref().map(|r| format!("@{r}"));
            let target = step.target.as_deref().or(target_from_ref.as_deref());
            let params =
                build_wait_params(target, step.selector.as_deref(), None, None, step.gone.unwrap_or(false), timeout);
            client.call("wait", with_scope(Some(params), Scope { window, ..Scope::default() })).await
        }
        "watch" => {
            let timeout = timeout_ms.unwrap_or(10_000);
            let stable = step.stable.unwrap_or(300);
            let require_mutation = step.require_mutation.unwrap_or(false);
            let mut params = serde_json::Map::new();
            params.insert("timeout".into(), json!(timeout));
            params.insert("stable".into(), json!(stable));
            if require_mutation {
                params.insert("requireMutation".into(), json!(true));
            }
            if let Some(sel) = &step.selector {
                params.insert("selector".into(), json!(sel));
            }
            client.call("watch", with_scope(Some(Value::Object(params)), Scope { window, ..Scope::default() })).await
        }
        "eval" => {
            let script = step.script.as_deref().ok_or_else(|| anyhow::anyhow!("eval step requires 'script'"))?;
            client.call("eval", with_scope(Some(json!({"script": script})), Scope { window, ..Scope::default() })).await
        }
        "screenshot" => {
            let result = client
                .call(
                    "screenshot",
                    with_scope(
                        Some(json!({"path": step.path, "selector": step.selector})),
                        Scope { window, ..Scope::default() },
                    ),
                )
                .await?;
            if let Some(path) = &step.path {
                save_screenshot_result(&result, path)?;
            }
            Ok(result)
        }
        "storage-get" => {
            let key = step.key.as_deref().ok_or_else(|| anyhow::anyhow!("storage-get requires key"))?;
            let result = client
                .call(
                    "storage.get",
                    with_scope(
                        Some(json!({"key":key, "session":step.session.unwrap_or(false)})),
                        Scope { window, ..Scope::default() },
                    ),
                )
                .await?;
            validate_storage_result(&result, step.expected.as_deref())?;
            Ok(result)
        }
        "assert-text" => {
            let t = require_target(step)?;
            let expected =
                step.expected.as_deref().ok_or_else(|| anyhow::anyhow!("assert-text requires 'expected'"))?;
            let result =
                client.call("text", with_scope(Some(target_params(t)), Scope { window, ..Scope::default() })).await?;
            let actual =
                result.as_str().ok_or_else(|| anyhow::anyhow!("{} returned a non-string result", step.action))?;
            anyhow::ensure!(actual == expected, "expected text {expected:?}, got {actual:?}");
            Ok(json!({"ok": true}))
        }
        "assert-exists" => {
            let t = require_target(step)?;
            client
                .call("visible", with_scope(Some(target_params(t)), Scope { window, ..Scope::default() }))
                .await
                .with_context(|| format!("element '{t}' was not found in the DOM"))?;
            Ok(json!({"ok": true}))
        }
        "assert-visible" => {
            let t = require_target(step)?;
            let result = client
                .call("visible", with_scope(Some(target_params(t)), Scope { window, ..Scope::default() }))
                .await?;
            let visible = result
                .get("visible")
                .and_then(Value::as_bool)
                .ok_or_else(|| anyhow::anyhow!("visible response requires boolean visible"))?;
            anyhow::ensure!(visible, "element is not visible");
            Ok(json!({"ok": true}))
        }
        "assert-hidden" => {
            let t = require_target(step)?;
            let result = client
                .call("visible", with_scope(Some(target_params(t)), Scope { window, ..Scope::default() }))
                .await?;
            let visible = result
                .get("visible")
                .and_then(Value::as_bool)
                .ok_or_else(|| anyhow::anyhow!("visible response requires boolean visible"))?;
            anyhow::ensure!(!visible, "element is visible");
            Ok(json!({"ok": true}))
        }
        "assert-value" => {
            let t = require_target(step)?;
            let expected =
                step.expected.as_deref().ok_or_else(|| anyhow::anyhow!("assert-value requires 'expected'"))?;
            let result =
                client.call("value", with_scope(Some(target_params(t)), Scope { window, ..Scope::default() })).await?;
            let actual =
                result.as_str().ok_or_else(|| anyhow::anyhow!("{} returned a non-string result", step.action))?;
            anyhow::ensure!(actual == expected, "expected value {expected:?}, got {actual:?}");
            Ok(json!({"ok": true}))
        }
        "assert-url" => {
            let expected = step.expected.as_deref().ok_or_else(|| anyhow::anyhow!("assert-url requires 'expected'"))?;
            let result = client.call("url", with_scope(None, Scope { window, ..Scope::default() })).await?;
            let actual =
                result.as_str().ok_or_else(|| anyhow::anyhow!("{} returned a non-string result", step.action))?;
            anyhow::ensure!(actual.contains(expected), "URL does not contain {expected:?}, got {actual:?}");
            Ok(json!({"ok": true}))
        }
        other => anyhow::bail!("unknown step action: {other:?}"),
    }
}

fn validate_storage_result(result: &Value, expected: Option<&str>) -> Result<()> {
    let found = result
        .get("found")
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow::anyhow!("storage.get requires boolean found"))?;
    anyhow::ensure!(found, "storage key was not found");
    let actual = result
        .get("value")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("storage.get requires string value when found"))?;
    if let Some(expected) = expected {
        anyhow::ensure!(actual == expected, "expected storage value {expected:?}, got {actual:?}");
    }
    Ok(())
}

fn require_target(step: &Step) -> Result<&str> {
    step.target.as_deref().ok_or_else(|| anyhow::anyhow!("step '{}' requires 'target'", step.action))
}

// ── Screenshot on failure ─────────────────────────────────────────────────────

async fn take_failure_screenshot(client: &mut Client, step_name: &str, window: Option<&str>) -> Result<()> {
    let dir = Path::new("tauri-hasgard-failures");
    std::fs::create_dir_all(dir)?;

    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());

    let safe_name: String =
        step_name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    let filename = format!("{safe_name}-{ts}.png");
    let path = dir.join(filename.as_str());

    let result = client.call("screenshot", with_scope(Some(json!({})), Scope { window, ..Scope::default() })).await?;
    save_screenshot_result(&result, &path)?;
    let arrow = crate::style::dim("failure screenshot →");
    eprintln!("  {arrow} {}", path.display());
    Ok(())
}

fn save_screenshot_result(result: &Value, path: &Path) -> Result<()> {
    let data_url = result.as_str().ok_or_else(|| anyhow::anyhow!("screenshot result is not a string"))?;
    let base64_data = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| anyhow::anyhow!("screenshot result is not a PNG data URL"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| anyhow::anyhow!("Failed to decode base64 screenshot: {e}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, bytes)?;
    Ok(())
}

// ── Terminal output helpers ───────────────────────────────────────────────────

fn print_step_line(idx: usize, total: usize, name: &str, status: &str) {
    let step_num = idx + 1;
    let colored = match status {
        "ok" => crate::style::success(status),
        "SKIP" => crate::style::dim(status),
        _ => crate::style::failure(status),
    };
    eprintln!("  [{step_num}/{total}] {name} {colored}");
}

fn print_step_fail(idx: usize, total: usize, name: &str, msg: &str) {
    let step_num = idx + 1;
    let fail_label = crate::style::failure("FAIL");
    let fail_msg = crate::style::failure(msg);
    eprintln!("  [{step_num}/{total}] {name} {fail_label}\n    {fail_msg}");
}

pub fn print_report(report: &ScenarioReport) {
    let passed = report.passed();
    let failed = report.failed();
    let skipped = report.skipped();
    let secs = report.total_duration.as_secs_f64();
    let name = crate::style::bold(&report.name);

    eprintln!();
    eprintln!("Scenario: {name}");
    eprintln!("  {passed} passed · {failed} failed · {skipped} skipped  ({secs:.3}s)");
    eprintln!();
}

// ── JUnit XML output ──────────────────────────────────────────────────────────

pub fn write_junit_xml(report: &ScenarioReport, path: &Path) -> Result<()> {
    use quick_xml::Writer;
    use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event};

    let failures = report.failed();
    let skipped = report.skipped();
    let total_str = report.results.len().to_string();
    let failures_str = failures.to_string();
    let skipped_str = skipped.to_string();
    let elapsed = report.total_duration.as_secs_f64();
    let elapsed_str = format!("{elapsed:.3}");

    let mut buf = Vec::new();
    let mut writer = Writer::new(&mut buf);

    writer.write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None)))?;
    writer.write_event(Event::Text(BytesText::new("\n")))?;

    let mut testsuites = BytesStart::new("testsuites");
    testsuites.push_attribute(("tests", total_str.as_str()));
    testsuites.push_attribute(("failures", failures_str.as_str()));
    testsuites.push_attribute(("errors", "0"));
    testsuites.push_attribute(("skipped", skipped_str.as_str()));
    testsuites.push_attribute(("time", elapsed_str.as_str()));
    writer.write_event(Event::Start(testsuites))?;
    writer.write_event(Event::Text(BytesText::new("\n  ")))?;

    let mut suite = BytesStart::new("testsuite");
    suite.push_attribute(("name", report.name.as_str()));
    suite.push_attribute(("tests", total_str.as_str()));
    suite.push_attribute(("failures", failures_str.as_str()));
    suite.push_attribute(("errors", "0"));
    suite.push_attribute(("skipped", skipped_str.as_str()));
    suite.push_attribute(("time", elapsed_str.as_str()));
    writer.write_event(Event::Start(suite))?;

    for result in &report.results {
        writer.write_event(Event::Text(BytesText::new("\n    ")))?;
        let dur_str = match &result.outcome {
            StepOutcome::Passed { duration } | StepOutcome::Failed { duration, .. } => {
                let d = duration.as_secs_f64();
                format!("{d:.3}")
            }
            StepOutcome::Skipped => "0.000".to_string(),
        };

        let mut tc = BytesStart::new("testcase");
        tc.push_attribute(("name", result.name.as_str()));
        tc.push_attribute(("time", dur_str.as_str()));
        writer.write_event(Event::Start(tc))?;

        match &result.outcome {
            StepOutcome::Passed { .. } => {}
            StepOutcome::Skipped => {
                writer.write_event(Event::Empty(BytesStart::new("skipped")))?;
            }
            StepOutcome::Failed { message, .. } => {
                let mut failure = BytesStart::new("failure");
                failure.push_attribute(("message", message.as_str()));
                writer.write_event(Event::Empty(failure))?;
            }
        }

        writer.write_event(Event::End(BytesEnd::new("testcase")))?;
    }

    writer.write_event(Event::Text(BytesText::new("\n  ")))?;
    writer.write_event(Event::End(BytesEnd::new("testsuite")))?;
    writer.write_event(Event::Text(BytesText::new("\n")))?;
    writer.write_event(Event::End(BytesEnd::new("testsuites")))?;
    writer.write_event(Event::Text(BytesText::new("\n")))?;

    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, &buf).with_context(|| format!("Failed to write JUnit XML to {}", path.display()))?;

    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    #[test]
    fn storage_result_rejects_missing_malformed_and_mismatch() {
        for value in
            [serde_json::json!({}), serde_json::json!({"found":false}), serde_json::json!({"found":true,"value":1})]
        {
            assert!(super::validate_storage_result(&value, None).is_err());
        }
        assert!(super::validate_storage_result(&serde_json::json!({"found":true,"value":""}), Some("")).is_ok());
        assert!(super::validate_storage_result(&serde_json::json!({"found":true,"value":"a"}), Some("b")).is_err());
        assert!(super::parse_scenario("").is_err());
        for action in ["fill", "type", "select"] {
            assert!(super::parse_scenario(&format!("[[step]]\naction='{action}'\ntarget='#x'")).is_err());
        }
        assert!(super::parse_scenario("[[step]]\naction='fill'\ntarget='#x'\nvalue=''").is_ok());
        assert!(super::parse_scenario("[[step]]\naction='wait'\ntimout_ms=1").is_err());
    }

    use super::*;
    use std::time::Duration;

    fn make_report(results: Vec<(&str, StepOutcome)>) -> ScenarioReport {
        ScenarioReport {
            name: "test-scenario".to_string(),
            results: results
                .into_iter()
                .map(|(name, outcome)| StepResult { name: name.to_string(), outcome })
                .collect(),
            total_duration: Duration::from_millis(1234),
        }
    }

    #[test]
    fn test_scenario_report_counts() {
        let report = make_report(vec![
            ("step-1", StepOutcome::Passed { duration: Duration::from_millis(100) }),
            ("step-2", StepOutcome::Failed { duration: Duration::from_millis(50), message: "oops".into() }),
            ("step-3", StepOutcome::Skipped),
        ]);
        assert_eq!(report.passed(), 1);
        assert_eq!(report.failed(), 1);
        assert_eq!(report.skipped(), 1);
        assert!(!report.all_passed());
    }

    #[test]
    fn test_scenario_report_all_passed() {
        let report = make_report(vec![
            ("step-1", StepOutcome::Passed { duration: Duration::from_millis(10) }),
            ("step-2", StepOutcome::Passed { duration: Duration::from_millis(20) }),
        ]);
        assert!(report.all_passed());
    }

    #[test]
    fn test_toml_parse_minimal() {
        let toml_str = r##"
[[step]]
action = "click"
target = "#btn"
"##;
        let scenario: Scenario = toml::from_str(toml_str).expect("valid toml");
        assert_eq!(scenario.step.len(), 1);
        assert_eq!(scenario.step[0].action, "click");
        assert_eq!(scenario.step[0].target.as_deref(), Some("#btn"));
        assert!(scenario.scenario.fail_fast);
    }

    #[test]
    fn test_toml_parse_full_meta() {
        let toml_str = r#"
[connect]
socket = "/tmp/test.sock"
timeout_ms = 5000

[scenario]
name = "login flow"
fail_fast = false
global_timeout_ms = 60000

[[step]]
name = "navigate"
action = "navigate"
url = "http://localhost:5173"
timeout_ms = 3000

[[step]]
name = "assert title"
action = "assert-text"
target = "h1"
expected = "Login"
"#;
        let scenario: Scenario = toml::from_str(toml_str).expect("valid toml");
        assert_eq!(scenario.scenario.name.as_deref(), Some("login flow"));
        assert!(!scenario.scenario.fail_fast);
        assert_eq!(scenario.scenario.global_timeout_ms, Some(60000));
        assert_eq!(scenario.step.len(), 2);

        let connect = scenario.connect.as_ref().expect("connect section");
        assert_eq!(connect.socket.as_deref(), Some(Path::new("/tmp/test.sock")));
        assert_eq!(connect.timeout_ms, Some(5000));

        let step = &scenario.step[1];
        assert_eq!(step.name.as_deref(), Some("assert title"));
        assert_eq!(step.action, "assert-text");
        assert_eq!(step.target.as_deref(), Some("h1"));
        assert_eq!(step.expected.as_deref(), Some("Login"));
    }

    #[test]
    fn test_toml_default_fail_fast() {
        let toml_str = r#"
[[step]]
action = "ping"
"#;
        let scenario: Scenario = toml::from_str(toml_str).expect("valid toml");
        assert!(scenario.scenario.fail_fast);
    }

    #[test]
    fn test_toml_step_display_name_uses_name_field() {
        let step = Step { name: Some("my step".to_string()), action: "click".to_string(), ..Step::default() };
        assert_eq!(step.display_name(0), "my step");
    }

    #[test]
    fn test_toml_step_display_name_fallback() {
        let step = Step { name: None, action: "click".to_string(), ..Step::default() };
        assert_eq!(step.display_name(2), "step-3");
    }

    #[test]
    fn test_junit_xml_all_passed() {
        let report = make_report(vec![
            ("click button", StepOutcome::Passed { duration: Duration::from_millis(123) }),
            ("fill form", StepOutcome::Passed { duration: Duration::from_millis(45) }),
        ]);
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("results.xml");
        write_junit_xml(&report, &path).expect("write junit xml");
        let xml = std::fs::read_to_string(&path).expect("read xml");
        assert!(xml.contains(r#"name="test-scenario""#));
        assert!(xml.contains(r#"tests="2""#));
        assert!(xml.contains(r#"failures="0""#));
        assert!(xml.contains(r#"skipped="0""#));
        assert!(xml.contains(r#"name="click button""#));
        assert!(xml.contains(r#"name="fill form""#));
        assert!(!xml.contains("<failure"));
        assert!(!xml.contains("<skipped"));
    }

    #[test]
    fn test_junit_xml_with_failures_and_skips() {
        let report = make_report(vec![
            ("step-1", StepOutcome::Passed { duration: Duration::from_millis(10) }),
            ("step-2", StepOutcome::Failed { duration: Duration::from_millis(20), message: "oops & done".into() }),
            ("step-3", StepOutcome::Skipped),
        ]);
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("results.xml");
        write_junit_xml(&report, &path).expect("write junit xml");
        let xml = std::fs::read_to_string(&path).expect("read xml");
        assert!(xml.contains(r#"failures="1""#));
        assert!(xml.contains(r#"skipped="1""#));
        assert!(xml.contains(r#"message="oops &amp; done""#));
        assert!(xml.contains("<skipped"));
    }
    #[tokio::test]
    async fn the_actions_added_for_whole_flows_send_their_protocol_calls() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = calls.clone();
        let mut client = Client::in_process(std::sync::Arc::new(move |method, params| {
            log.lock().expect("log").push((method.clone(), params));
            Box::pin(async move { Ok(if method == "ipc" { json!("pong") } else { json!({"ok": true}) }) })
        }));
        let scenario = parse_scenario(
            r##"
[scenario]
name = "flow"

[[step]]
action = "hover"
target = "#menu"

[[step]]
action = "dblclick"
target = "#row"

[[step]]
action = "drag"
target = "#card"
to = "#lane"

[[step]]
action = "select"
target = "#tags"
values = ["a", "b"]

[[step]]
action = "wheel"
delta_y = 120.0

[[step]]
action = "dialog"
policy = "accept"
text = "typed"

[[step]]
action = "native-dialog"
policy = "accept"
paths = ["/tmp/report.csv"]

[[step]]
action = "route"
pattern = "**/api/user"
status = 503
body = "down"

[[step]]
action = "route"
clear = true

[[step]]
action = "ipc"
command = "ping"
args = { value = 1 }
expected = "pong"
"##,
        )
        .expect("the scenario parses");
        let report = run_scenario(&mut client, &scenario, Some("main"), Some(true)).await.expect("the scenario runs");
        assert_eq!(report.failed(), 0, "{:?}", report.results);

        let sent = calls.lock().expect("log").clone();
        let expected = [
            ("hover", json!({"selector": "#menu", "window": "main"})),
            ("click", json!({"selector": "#row", "clickCount": 2, "window": "main"})),
            ("drag", json!({"source": {"selector": "#card"}, "target": {"selector": "#lane"}, "window": "main"})),
            ("select", json!({"selector": "#tags", "values": ["a", "b"], "window": "main"})),
            ("wheel", json!({"deltaX": 0.0, "deltaY": 120.0, "window": "main"})),
            ("dialog.handle", json!({"action": "accept", "promptText": "typed", "window": "main"})),
            ("nativeDialog.handle", json!({"action": "accept", "paths": ["/tmp/report.csv"], "window": "main"})),
            (
                "route.add",
                json!({"pattern": "**/api/user", "action": "fulfill", "status": 503, "body": "down", "window": "main"}),
            ),
            ("route.clear", json!({"window": "main"})),
            ("ipc", json!({"command": "ping", "args": {"value": 1}, "window": "main"})),
        ];
        assert_eq!(sent.len(), expected.len());
        for ((method, params), (wanted_method, wanted_params)) in sent.iter().zip(expected) {
            assert_eq!((method.as_str(), params), (wanted_method, &wanted_params));
        }
    }

    #[test]
    fn a_new_action_without_what_it_needs_is_rejected_when_parsed() {
        for step in [
            "action = 'drag'\ntarget = '#a'",
            "action = 'dialog'",
            "action = 'route'",
            "action = 'ipc'",
            "action = 'hover'",
        ] {
            assert!(parse_scenario(&format!("[[step]]\n{step}")).is_err(), "{step}");
        }
    }
}
