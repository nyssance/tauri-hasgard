use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "tauri-hasgard", version, about = "Interactive testing CLI for Tauri apps")]
pub(crate) struct Cli {
    /// Socket path (auto-detected if omitted).
    #[arg(long, env = "TAURI_HASGARD_SOCKET")]
    pub socket: Option<PathBuf>,

    /// Output JSON instead of text.
    #[arg(long, global = true)]
    pub json: bool,

    /// Target a specific window by label
    #[arg(long, env = "TAURI_HASGARD_WINDOW", global = true)]
    pub window: Option<String>,

    #[command(subcommand)]
    pub command: Command,
}

/// Parse an `X,Y` click offset. Rejected rather than defaulted, because a
/// silently ignored `--position` would click the centre and look like a bug in
/// the page instead of a typo in the command.
fn parse_position(raw: &str) -> Result<(f64, f64), String> {
    let (x, y) = raw.split_once(',').ok_or_else(|| format!("expected X,Y (for example 10,5), got {raw:?}"))?;
    let parse = |part: &str, axis: &str| {
        part.trim().parse::<f64>().map_err(|_| format!("{axis} offset must be a number, got {part:?}"))
    };
    Ok((parse(x, "x")?, parse(y, "y")?))
}

#[derive(Subcommand)]
pub(crate) enum Command {
    /// Start a Model Context Protocol server over stdio.
    Mcp,
    /// List all open windows
    Windows,
    /// Check connectivity with a running Tauri app.
    Ping,
    /// Get app state (url, title, ready).
    State,
    /// Capture an accessibility snapshot of the UI.
    Snapshot {
        #[arg(short, long)]
        interactive: bool,
        #[arg(short, long)]
        selector: Option<String>,
        #[arg(short, long)]
        depth: Option<u8>,
        #[arg(long, value_name = "FILE")]
        save: Option<std::path::PathBuf>,
    },
    /// Compare the current webview with a previous snapshot, showing only differences.
    Diff {
        /// Path to a saved snapshot file to compare against
        #[arg(long, value_name = "FILE")]
        r#ref: Option<std::path::PathBuf>,
        /// Only include interactive elements
        #[arg(short, long)]
        interactive: bool,
        /// CSS selector to scope the snapshot
        #[arg(short, long)]
        selector: Option<String>,
        /// Maximum depth to traverse
        #[arg(short, long)]
        depth: Option<u8>,
    },
    /// Find elements by text, label, placeholder, test id, alt, or title.
    ///
    /// Matching runs against the live DOM, so it sees every naming source
    /// independently — unlike a snapshot `name`, which collapses them into one
    /// truncated field.
    Query {
        /// Dimension to match on.
        #[arg(long, value_parser = ["text", "label", "placeholder", "testid", "alt", "title"])]
        by: String,
        value: String,
        /// Require a full, case-sensitive match. Test ids are always exact.
        #[arg(long)]
        exact: bool,
    },
    /// Click an element.
    ///
    /// A right click raises `contextmenu` and a middle click raises `auxclick`;
    /// neither raises `click`, matching a real press.
    Click {
        target: String,
        /// Repeat to hold several. Meta is Command on macOS.
        #[arg(long = "modifier", value_name = "KEY", value_parser = ["Alt", "Control", "Meta", "Shift"])]
        modifiers: Vec<String>,
        /// Which button to press.
        #[arg(long, value_parser = ["left", "middle", "right"])]
        button: Option<String>,
        /// Presses in one gesture. 2 also raises a single `dblclick`.
        #[arg(long)]
        click_count: Option<u32>,
        /// Press at this offset from the element's top-left, not its centre.
        #[arg(long, value_name = "X,Y", value_parser = parse_position)]
        position: Option<(f64, f64)>,
    },
    /// Double-click an element. Shorthand for `click --click-count 2`.
    Dblclick { target: String },
    /// Move the pointer over an element.
    Hover { target: String },
    /// Focus an element.
    Focus { target: String },
    /// Remove focus from an element.
    Blur { target: String },
    /// Report whether an element is disabled.
    Disabled { target: String },
    /// Report an element's position and size in viewport pixels.
    BoundingBox { target: String },
    /// Clear and fill an input with a value.
    Fill { target: String, value: String },
    /// Empty an input, firing the same events as `fill`.
    Clear { target: String },
    /// Attach files to an `<input type="file">`, by path on this machine.
    SetInputFiles {
        target: String,
        /// Repeat to attach several files. Omit to clear the selection.
        #[arg(long = "file", value_name = "PATH")]
        files: Vec<std::path::PathBuf>,
    },
    /// Scroll by wheel, letting the page cancel it as a real wheel would.
    Wheel {
        /// Omit to scroll the page rather than a specific scrollport.
        target: Option<String>,
        #[arg(long, default_value_t = 0.0, allow_negative_numbers = true)]
        delta_x: f64,
        #[arg(long, default_value_t = 0.0, allow_negative_numbers = true)]
        delta_y: f64,
    },
    /// Inspect or set how modal dialogs (alert/confirm/prompt) are answered.
    #[command(subcommand)]
    Dialog(DialogCommand),
    /// Type text character by character.
    Type { target: String, text: String },
    /// Press a keyboard key.
    Press { key: String },
    /// Select an option in a <select>.
    Select { target: String, value: String },
    /// Toggle a checkbox, or drive it to a state with --state.
    Check {
        target: String,
        /// Drive the checkbox to `on` or `off` instead of toggling. Idempotent,
        /// so a retry cannot invert the box the way a repeated toggle does.
        #[arg(long, value_parser = ["on", "off"])]
        state: Option<String>,
    },
    /// Scroll the webview document or an element.
    Scroll {
        direction: String,
        amount: Option<i32>,
        #[arg(long)]
        r#ref: Option<String>,
    },
    /// Drag an element to another element or by offset.
    Drag {
        source: String,
        #[arg(conflicts_with = "offset")]
        target: Option<String>,
        /// Pixel offset as X,Y (e.g., "0,100").
        #[arg(long, value_name = "X,Y", conflicts_with = "target")]
        offset: Option<String>,
    },
    /// Simulate a file drop on an element.
    Drop {
        target: String,
        /// File(s) to drop. Can be repeated.
        #[arg(long, required = true)]
        file: Vec<std::path::PathBuf>,
    },
    /// Get text content of an element.
    Text { target: String },
    /// Get inner HTML of an element or the full webview document.
    Html { target: Option<String> },
    /// Get the value of an input/select/textarea.
    Value { target: String },
    /// Get all attributes of an element.
    Attrs { target: String },
    /// Evaluate arbitrary JavaScript.
    /// Pass `-` as the script or omit it to read from stdin.
    Eval {
        /// JavaScript to evaluate. Use `-` or omit to read from stdin.
        script: Option<String>,
    },
    /// Invoke a Tauri IPC command.
    Ipc {
        command: String,
        #[arg(long)]
        args: Option<String>,
    },
    /// Capture the full webview document as a PNG.
    Screenshot {
        path: Option<PathBuf>,
        #[arg(long)]
        selector: Option<String>,
    },
    /// Capture a native window screenshot (PNG) by platform window id.
    #[command(name = "screenshot_native", visible_alias = "screenshot-native")]
    ScreenshotNative {
        /// Operating-system window id. Resolved from the target window's label
        /// when omitted; pass it only to capture a window Hasgard does not own.
        #[arg(long)]
        window_id: Option<u32>,
        #[arg(long)]
        output: PathBuf,
        #[arg(long, default_value = "png")]
        format: String,
    },
    /// Navigate to a URL.
    Navigate { url: String },
    /// Get current URL.
    Url,
    /// Get the current webview title.
    Title,
    /// Wait for an element or condition.
    Wait {
        target: Option<String>,
        #[arg(long)]
        selector: Option<String>,
        /// Wait until a JavaScript expression returns a truthy value, and print
        /// that value. Polled, so predicates that flip without a DOM mutation
        /// are caught; a predicate that throws fails the command.
        #[arg(long, conflicts_with_all = ["selector", "gone"])]
        expression: Option<String>,
        /// How often to re-evaluate --expression, in ms.
        #[arg(long, requires = "expression")]
        poll: Option<u64>,
        #[arg(long)]
        gone: bool,
        #[arg(long, default_value = "10000")]
        timeout: u64,
    },
    /// Watch for DOM mutations and report changes.
    Watch {
        /// CSS selector to scope observation to a subtree.
        #[arg(long)]
        selector: Option<String>,
        /// Maximum wait time in ms. With `--require-mutation`, rejects on timeout
        /// if no mutation occurred; otherwise resolves after `--stable` ms of quiet.
        #[arg(long, default_value = "10000")]
        timeout: u64,
        /// Wait until DOM is stable for N ms (no new mutations).
        #[arg(long, default_value = "300")]
        stable: u64,
        /// Defer the stability timer until at least one mutation occurs.
        /// Use after IPC calls that trigger async re-renders (e.g., React state updates).
        #[arg(long)]
        require_mutation: bool,
    },
    /// Display or stream captured console logs.
    Logs {
        /// Filter by log level (log, info, warn, error).
        #[arg(long, value_parser = ["log", "info", "warn", "error"])]
        level: Option<String>,

        /// Show last N log entries.
        #[arg(long)]
        last: Option<usize>,

        /// Clear the log buffer.
        #[arg(long, conflicts_with = "follow")]
        clear: bool,

        /// Continuously poll for new logs.
        #[arg(long, short = 'f')]
        follow: bool,
    },
    /// Display or stream captured network requests.
    Network {
        /// Filter by URL pattern (substring match).
        #[arg(long)]
        filter: Option<String>,

        /// Show only failed requests (4xx/5xx and network errors).
        #[arg(long)]
        failed: bool,

        /// Show last N requests.
        #[arg(long)]
        last: Option<usize>,

        /// Clear the request buffer.
        #[arg(long, conflicts_with = "follow")]
        clear: bool,

        /// Continuously poll for new requests.
        #[arg(long, short = 'f')]
        follow: bool,
    },
    /// Assert element state
    #[command(subcommand)]
    Assert(AssertKind),
    /// Read and write browser storage (localStorage/sessionStorage).
    Storage(StorageArgs),
    /// Dump all form fields in the webview document.
    Forms(FormsArgs),
    /// Record interactions for replay
    Record {
        #[command(subcommand)]
        action: RecordAction,
    },
    /// Replay a recorded session
    Replay {
        /// Path to recording file (JSON)
        path: PathBuf,
        /// Export format instead of replaying (e.g., "sh")
        #[arg(long)]
        export: Option<String>,
    },
    /// Execute a declarative scenario from a TOML file.
    Run {
        /// Path to scenario TOML file.
        scenario: PathBuf,
        /// Write `JUnit` XML report to this path.
        #[arg(long, value_name = "FILE")]
        junit: Option<PathBuf>,
        /// Override `fail_fast` setting from the scenario file.
        #[arg(long)]
        no_fail_fast: bool,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum AssertKind {
    /// Assert exact text content
    Text { target: String, expected: String },
    /// Assert element is visible
    Visible { target: String },
    /// Assert element is hidden
    Hidden { target: String },
    /// Assert input value
    Value { target: String, expected: String },
    /// Assert element count matching selector
    Count { selector: String, expected: u64 },
    /// Assert checkbox is checked
    Checked { target: String },
    /// Assert text contains substring
    Contains { target: String, expected: String },
    /// Assert current URL contains string
    Url { expected: String },
}

#[derive(clap::Args, Debug)]
pub(crate) struct StorageArgs {
    /// Use sessionStorage instead of localStorage.
    #[arg(long)]
    pub session: bool,
    #[command(subcommand)]
    pub action: StorageAction,
}

#[derive(clap::Args, Debug)]
pub(crate) struct FormsArgs {
    /// Target a specific form by CSS selector.
    #[arg(long)]
    pub selector: Option<String>,
}

#[derive(Subcommand, Debug)]
pub(crate) enum StorageAction {
    /// Get a value by key.
    Get { key: String },
    /// Set a key-value pair.
    Set { key: String, value: String },
    /// List all key-value pairs.
    List,
    /// Clear all storage.
    Clear,
}

/// How modal dialogs are answered.
///
/// The bridge must answer `confirm()` synchronously inside the page's own call,
/// so this is a standing policy rather than a per-dialog prompt. It defaults to
/// dismiss, which is what keeps an app that confirms from freezing the webview.
#[derive(Subcommand, Debug)]
pub(crate) enum DialogCommand {
    /// Answer subsequent dialogs with OK.
    Accept {
        /// Text submitted to a `prompt`. Its own default is used when omitted.
        #[arg(long)]
        prompt_text: Option<String>,
    },
    /// Answer subsequent dialogs with Cancel. This is the default.
    Dismiss,
    /// Show the dialogs the page has opened, and the current policy.
    List,
    /// Forget the recorded dialogs, leaving the policy alone.
    Clear,
}

#[derive(Subcommand, Debug)]
pub(crate) enum RecordAction {
    /// Start recording interactions
    Start,
    /// Stop recording and save to file
    Stop {
        /// Output file path (JSON)
        #[arg(short, long)]
        output: PathBuf,
    },
    /// Show recording status
    Status,
}

/// Parsed target for element-targeting commands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Target {
    Ref(String),
    Selector(String),
    Coords(i32, i32),
}

/// Parse a target string into a `Target` variant.
pub(crate) fn parse_target(s: &str) -> Target {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_target_ref() {
        assert_eq!(parse_target("@e1"), Target::Ref("e1".to_owned()));
        assert_eq!(parse_target("@e42"), Target::Ref("e42".to_owned()));
    }

    #[test]
    fn test_parse_target_selector() {
        assert_eq!(parse_target("#submit-btn"), Target::Selector("#submit-btn".to_owned()));
        assert_eq!(parse_target(".class"), Target::Selector(".class".to_owned()));
    }

    #[test]
    fn test_parse_target_coords() {
        assert_eq!(parse_target("100,200"), Target::Coords(100, 200));
        assert_eq!(parse_target("0, 0"), Target::Coords(0, 0));
    }

    #[test]
    fn test_parse_target_invalid_coords_as_selector() {
        assert_eq!(parse_target("abc,def"), Target::Selector("abc,def".to_owned()));
    }

    #[test]
    fn test_parse_diff_command() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "diff"]);
        assert!(matches!(cli.command, Command::Diff { r#ref: None, interactive: false, selector: None, depth: None }));
    }

    #[test]
    fn test_parse_diff_with_ref() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "diff", "--ref", "/tmp/snap.json"]);
        if let Command::Diff { r#ref: Some(path), .. } = cli.command {
            assert_eq!(path, std::path::PathBuf::from("/tmp/snap.json"));
        } else {
            panic!("Expected Diff command with ref");
        }
    }

    #[test]
    fn test_parse_assert_text() {
        let cli =
            Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "assert", "text", "@e1", "Dashboard"]);
        if let Command::Assert(AssertKind::Text { target, expected }) = cli.command {
            assert_eq!(target, "@e1");
            assert_eq!(expected, "Dashboard");
        } else {
            panic!("Expected Assert Text command");
        }
    }

    #[test]
    fn test_parse_assert_visible() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "assert", "visible", "#submit"]);
        if let Command::Assert(AssertKind::Visible { target }) = cli.command {
            assert_eq!(target, "#submit");
        } else {
            panic!("Expected Assert Visible command");
        }
    }

    #[test]
    fn test_parse_assert_count() {
        let cli =
            Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "assert", "count", ".list-item", "5"]);
        if let Command::Assert(AssertKind::Count { selector, expected }) = cli.command {
            assert_eq!(selector, ".list-item");
            assert_eq!(expected, 5);
        } else {
            panic!("Expected Assert Count command");
        }
    }

    #[test]
    fn test_parse_assert_url() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "assert", "url", "/dashboard"]);
        if let Command::Assert(AssertKind::Url { expected }) = cli.command {
            assert_eq!(expected, "/dashboard");
        } else {
            panic!("Expected Assert Url command");
        }
    }

    #[test]
    fn test_parse_watch_command() {
        let cli = Cli::parse_from([
            "tauri-hasgard",
            "--socket",
            "/tmp/test.sock",
            "watch",
            "--selector",
            ".results",
            "--timeout",
            "5000",
            "--stable",
            "500",
        ]);
        if let Command::Watch { selector, timeout, stable, require_mutation } = cli.command {
            assert_eq!(selector, Some(".results".to_owned()));
            assert_eq!(timeout, 5000);
            assert_eq!(stable, 500);
            assert!(!require_mutation);
        } else {
            panic!("Expected Watch command");
        }
    }

    #[test]
    fn test_parse_watch_defaults() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "watch"]);
        if let Command::Watch { selector, timeout, stable, require_mutation } = cli.command {
            assert_eq!(selector, None);
            assert_eq!(timeout, 10000);
            assert_eq!(stable, 300);
            assert!(!require_mutation);
        } else {
            panic!("Expected Watch command");
        }
    }

    #[test]
    fn test_parse_watch_require_mutation() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "watch", "--require-mutation"]);
        if let Command::Watch { require_mutation, .. } = cli.command {
            assert!(require_mutation);
        } else {
            panic!("Expected Watch command");
        }
    }

    #[test]
    fn test_parse_watch_require_mutation_with_selector() {
        let cli = Cli::parse_from([
            "tauri-hasgard",
            "--socket",
            "/tmp/test.sock",
            "watch",
            "--selector",
            "#root",
            "--require-mutation",
            "--stable",
            "500",
        ]);
        if let Command::Watch { selector, stable, require_mutation, .. } = cli.command {
            assert_eq!(selector, Some("#root".to_owned()));
            assert_eq!(stable, 500);
            assert!(require_mutation);
        } else {
            panic!("Expected Watch command");
        }
    }

    #[test]
    fn test_parse_drag_to_element() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/t.sock", "drag", "@e5", "@e6"]);
        assert!(matches!(cli.command, Command::Drag { ref source, target: Some(_), .. } if source == "@e5"));
    }

    #[test]
    fn test_parse_drag_with_offset() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/t.sock", "drag", "@e5", "--offset", "0,100"]);
        assert!(
            matches!(cli.command, Command::Drag { ref source, offset: Some(ref off), .. } if source == "@e5" && off == "0,100")
        );
    }

    #[test]
    fn test_parse_drop_with_file() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/t.sock", "drop", "@e3", "--file", "test.png"]);
        assert!(matches!(cli.command, Command::Drop { ref target, .. } if target == "@e3"));
    }

    #[test]
    fn test_parse_drop_multiple_files() {
        let cli = Cli::parse_from([
            "tauri-hasgard",
            "--socket",
            "/tmp/t.sock",
            "drop",
            "@e3",
            "--file",
            "a.png",
            "--file",
            "b.txt",
        ]);
        if let Command::Drop { file, .. } = cli.command {
            assert_eq!(file.len(), 2);
        } else {
            panic!("expected Drop command");
        }
    }

    #[test]
    fn test_parse_drag_rejects_both_target_and_offset() {
        let result = Cli::try_parse_from([
            "tauri-hasgard",
            "--socket",
            "/tmp/t.sock",
            "drag",
            "@e5",
            "@e6",
            "--offset",
            "0,100",
        ]);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_drop_requires_file() {
        let result = Cli::try_parse_from(["tauri-hasgard", "--socket", "/tmp/t.sock", "drop", "@e3"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_storage_get() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/t.sock", "storage", "get", "auth_token"]);
        if let Command::Storage(StorageArgs { session, action: StorageAction::Get { key } }) = cli.command {
            assert!(!session);
            assert_eq!(key, "auth_token");
        } else {
            panic!("Expected Storage Get command");
        }
    }

    #[test]
    fn test_parse_storage_set() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/t.sock", "storage", "set", "theme", "dark"]);
        if let Command::Storage(StorageArgs { session, action: StorageAction::Set { key, value } }) = cli.command {
            assert!(!session);
            assert_eq!(key, "theme");
            assert_eq!(value, "dark");
        } else {
            panic!("Expected Storage Set command");
        }
    }

    #[test]
    fn test_parse_storage_list_session() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/t.sock", "storage", "--session", "list"]);
        if let Command::Storage(StorageArgs { session, action: StorageAction::List }) = cli.command {
            assert!(session);
        } else {
            panic!("Expected Storage List command with session flag");
        }
    }

    #[test]
    fn test_parse_storage_clear() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/t.sock", "storage", "clear"]);
        assert!(matches!(cli.command, Command::Storage(StorageArgs { action: StorageAction::Clear, .. })));
    }

    #[test]
    fn test_parse_forms_command() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "forms"]);
        if let Command::Forms(FormsArgs { selector }) = cli.command {
            assert_eq!(selector, None);
        } else {
            panic!("Expected Forms command");
        }
    }

    #[test]
    fn test_parse_forms_with_selector() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "forms", "--selector", "#login"]);
        if let Command::Forms(FormsArgs { selector }) = cli.command {
            assert_eq!(selector, Some("#login".to_owned()));
        } else {
            panic!("Expected Forms command with selector");
        }
    }

    #[test]
    fn test_parse_record_start() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "record", "start"]);
        assert!(matches!(cli.command, Command::Record { action: RecordAction::Start }));
    }

    #[test]
    fn test_parse_record_stop_with_output() {
        let cli =
            Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "record", "stop", "--output", "test.json"]);
        if let Command::Record { action: RecordAction::Stop { output } } = cli.command {
            assert_eq!(output, std::path::PathBuf::from("test.json"));
        } else {
            panic!("Expected Record Stop command with output");
        }
    }

    #[test]
    fn test_parse_record_stop_requires_output() {
        let result = Cli::try_parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "record", "stop"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_replay_with_export() {
        let cli =
            Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "replay", "test.json", "--export", "sh"]);
        if let Command::Replay { path, export } = cli.command {
            assert_eq!(path, std::path::PathBuf::from("test.json"));
            assert_eq!(export, Some("sh".to_owned()));
        } else {
            panic!("Expected Replay command with export");
        }
    }

    #[test]
    fn test_windows_command() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "windows"]);
        assert!(matches!(cli.command, Command::Windows));
    }

    #[test]
    fn test_parse_screenshot_native_command() {
        let cli = Cli::parse_from([
            "tauri-hasgard",
            "--socket",
            "/tmp/test.sock",
            "screenshot_native",
            "--window-id",
            "42",
            "--output",
            "/tmp/out.png",
        ]);
        if let Command::ScreenshotNative { window_id, output, format } = cli.command {
            assert_eq!(window_id, Some(42));
            assert_eq!(output, std::path::PathBuf::from("/tmp/out.png"));
            assert_eq!(format, "png");
        } else {
            panic!("Expected ScreenshotNative command");
        }
    }

    #[test]
    fn test_mcp_command() {
        let cli = Cli::parse_from(["tauri-hasgard", "mcp"]);
        assert!(matches!(cli.command, Command::Mcp));
    }

    #[test]
    fn test_window_flag_with_command() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "--window", "settings", "snapshot"]);
        assert_eq!(cli.window, Some("settings".to_owned()));
        assert!(matches!(cli.command, Command::Snapshot { .. }));
    }

    #[test]
    #[serial_test::serial]
    fn test_window_flag_env() {
        // SAFETY: test is serialized via #[serial] to prevent parallel env access
        unsafe {
            std::env::set_var("TAURI_HASGARD_WINDOW", "main");
        }
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "ping"]);
        assert_eq!(cli.window, Some("main".to_owned()));
        unsafe {
            std::env::remove_var("TAURI_HASGARD_WINDOW");
        }
    }

    #[test]
    fn test_parse_eval_with_script_containing_quotes() {
        // Scripts with double quotes are the primary motivation for stdin support —
        // the shell would mangle them if passed as a CLI argument.
        let script = r#"document.querySelector('[data-id="main"]').textContent"#;
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "eval", script]);
        if let Command::Eval { script: parsed } = cli.command {
            assert_eq!(parsed, Some(script.to_owned()));
        } else {
            panic!("Expected Eval command");
        }
    }

    #[test]
    fn test_parse_eval_dash_reads_stdin() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "eval", "-"]);
        if let Command::Eval { script } = cli.command {
            assert_eq!(script, Some("-".to_owned()));
        } else {
            panic!("Expected Eval command with dash");
        }
    }

    #[test]
    fn test_parse_eval_no_arg_reads_stdin() {
        let cli = Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "eval"]);
        if let Command::Eval { script } = cli.command {
            assert_eq!(script, None);
        } else {
            panic!("Expected Eval command with no script");
        }
    }

    #[test]
    fn test_parse_snapshot_with_save() {
        let cli =
            Cli::parse_from(["tauri-hasgard", "--socket", "/tmp/test.sock", "snapshot", "--save", "/tmp/snap.json"]);
        if let Command::Snapshot { save: Some(path), .. } = cli.command {
            assert_eq!(path, std::path::PathBuf::from("/tmp/snap.json"));
        } else {
            panic!("Expected Snapshot command with save");
        }
    }
}

#[cfg(test)]
mod position_tests {
    use super::*;

    #[test]
    fn parses_an_integer_pair() {
        assert_eq!(parse_position("10,5").unwrap(), (10.0, 5.0));
    }

    #[test]
    fn parses_negative_and_fractional_offsets() {
        // Negative offsets are meaningful: they aim outside the box, which is how
        // you test that a handler ignores a press on its margin.
        assert_eq!(parse_position("-3,2.5").unwrap(), (-3.0, 2.5));
    }

    #[test]
    fn tolerates_spaces_around_the_comma() {
        assert_eq!(parse_position(" 10 , 5 ").unwrap(), (10.0, 5.0));
    }

    #[test]
    fn rejects_a_missing_comma_by_naming_the_expected_form() {
        let error = parse_position("10").unwrap_err();
        assert!(error.contains("X,Y"), "unhelpful message: {error}");
    }

    #[test]
    fn rejects_a_non_numeric_axis_rather_than_defaulting_it_to_zero() {
        assert!(parse_position("a,5").unwrap_err().contains("x offset"));
        assert!(parse_position("10,b").unwrap_err().contains("y offset"));
    }
}
