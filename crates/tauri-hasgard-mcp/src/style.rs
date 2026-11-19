#![allow(
    clippy::must_use_candidate,
    clippy::missing_errors_doc,
    clippy::missing_panics_doc,
    reason = "shared with the tauri-hasgard CLI; not a stable API"
)]

use owo_colors::{OwoColorize, Stream::Stdout};
use std::fmt::Display;

/// Format a success message: "✓ {msg}" in green (if terminal supports color).
pub fn success(msg: &str) -> String {
    let symbol = "✓".if_supports_color(Stdout, |text| text.green());
    let message = msg.if_supports_color(Stdout, |text| text.green());
    format!("{symbol} {message}")
}

/// Format an error message: "✗ {msg}" in red.
pub fn error(msg: &str) -> String {
    let symbol = "✗".if_supports_color(Stdout, |text| text.red());
    let message = msg.if_supports_color(Stdout, |text| text.red());
    format!("{symbol} {message}")
}

/// Format info text in cyan.
pub fn info(msg: impl Display) -> String {
    format!("{}", msg.if_supports_color(Stdout, |t| t.cyan()))
}

/// Format text as dimmed (secondary information).
pub fn dim(msg: impl Display) -> String {
    format!("{}", msg.if_supports_color(Stdout, |t| t.dimmed()))
}

/// Format text as bold.
pub fn bold(msg: impl Display) -> String {
    format!("{}", msg.if_supports_color(Stdout, |t| t.bold()))
}

/// Format a failure message in red (no icon, unlike `error`).
pub fn failure(msg: impl Display) -> String {
    format!("{}", msg.if_supports_color(Stdout, |t| t.red()))
}

/// Format a warning message in yellow.
pub fn warn(msg: impl Display) -> String {
    format!("{}", msg.if_supports_color(Stdout, |t| t.yellow()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_contains_checkmark_and_message() {
        let output = success("ok");
        assert!(output.contains('✓'));
        assert!(output.contains("ok"));
    }

    #[test]
    fn error_contains_cross_and_message() {
        let output = error("failed");
        assert!(output.contains('✗'));
        assert!(output.contains("failed"));
    }

    #[test]
    fn info_contains_message() {
        let output = info("note");
        assert!(output.contains("note"));
    }

    #[test]
    fn dim_contains_message() {
        let output = dim("secondary");
        assert!(output.contains("secondary"));
    }

    #[test]
    fn bold_contains_message() {
        let output = bold("important");
        assert!(output.contains("important"));
    }

    #[test]
    fn warn_contains_message() {
        let output = warn("caution");
        assert!(output.contains("caution"));
    }
}
