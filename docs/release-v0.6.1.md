# 0.6.1

Capture what WebKit shows: `screenshot_native` renders the target webview through `WKWebView` `takeSnapshot:` by default.

- The DOM-based `screenshot` draws scrolled containers and virtualized lists at scroll offset zero, and the window-level backends need screen-recording permission (without it `CGWindowList` omits WebKit's scrolled tiles). The new backend asks WebKit for its own rendered pixels: scrolled content captures as shown, no permission prompt, `backend: "wkwebview"`, `tcc_denied: false`, `scale_factor` from the window's backing scale.
- `screenshot_native` without `window_id` uses it for the scoped window; with `window_id` the existing window capture is unchanged. The CLI and MCP tool omit the id by default and the CLI retries with a resolved id against plugins older than 0.6.1.
- The Playwright `screenshotNative` helper no longer resolves a native id unless one is passed.

First stable release of the Tauri 3 Wry line; the 0.6.0 alphas are superseded. Requires Tauri 3 with Wry. Tauri 2 applications should remain on the 0.5.x line.
CEF is unsupported. Published to crates.io, npm `latest`, Homebrew and Scoop. macOS supports Apple Silicon only.
