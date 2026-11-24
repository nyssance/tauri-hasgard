# 0.8.3

Stricter input, and the CEF suite covers what 0.8.2 added.

- `wait` and `watch` reject a `timeout` that is not a whole number instead of using the default.
- A recording exported as CLI commands names the field an entry lacks instead of emitting a command without it, and a multiple selection exports every value.
- Downloads, Tauri events, and frame screenshots and diffs are verified on CEF on macOS and Windows, as they were on Wry.

Two issues in `tauri-runtime-cef` 3.0.0-alpha.7 are documented in `docs/cef.md`: an occasional crash while an application exits on Windows, and an event subscription made while a page loads that is sometimes lost. Neither comes from this plugin.

The native suites pass for Wry and CEF on macOS and Windows. Everything else is unchanged from 0.8.2.
