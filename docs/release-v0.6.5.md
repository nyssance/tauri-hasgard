# 0.6.5

Add opt-in CEF automation for Tauri 3, keeping the shared CLI, MCP and Playwright protocol.

- Enable the plugin's `cef` feature and register `init_cef()` with the CEF `DynRuntime`. Existing Wry apps keep `init()`.
- Route native child webviews by their labels. `windows` includes `window_label` to identify the native host.
- Run DOM operations in an isolated CDP world without an external debugging port or remote-page Tauri IPC grants. Support native keyboard input, navigation and same-label child recreation.
- Capture CEF viewport screenshots on macOS separately from whole-window screenshots. Native child webviews still occlude host HTML overlays; this release does not implement SurfaceEmbed.
- Explicitly reject CEF console/network observation, routing, JavaScript dialog interception, IPC calls and heap snapshots until those integrations exist.
- Isolate native fixture profiles and use test-only secret storage, avoiding macOS keychain prompts after rebuilds.

Validated locally on macOS: two consecutive CEF native runs, 370 Rust workspace tests (one ignored), 131 client tests, 138 bridge tests, type checking, and a YiJoy smoke test with a remote child webview. Windows CEF behavior is not yet validated. Existing Wry native tests remain release gates on macOS and Windows.

Requires Tauri 3 alpha.6 and CEF runtime alpha.7 for CEF support. Tauri 2 applications should use Hasgard 0.5.x.
