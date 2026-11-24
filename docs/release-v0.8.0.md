# 0.8.0

Hasgard can now test the parts of an application the page cannot reach, and CEF is verified on Windows.

New, on Wry and CEF, each as a protocol method, a CLI command, an MCP tool and a Playwright method:

- **Wait for a URL or a load state.** `wait` takes `url` and `load` and holds across the navigation that reaches them: `wait --url`, `waitForURL`, `waitForLoadState`.
- **Native window.** `window.state`, `window.resize`, `window.move`, `window.minimize`, `window.maximize`, `window.restore`, `window.close`.
- **Cookies.** `cookies.get`, `cookies.set`, `cookies.clear` use the webview's own store, so `HttpOnly` cookies are included and a test can start signed in. On CEF a cookie can be set only for the host of the page the webview is showing.
- **Clipboard.** `clipboard.read` and `clipboard.write` for the system clipboard's text.
- **Large uploads.** `drop` and `setInputFiles` take a file by path, which the application reads itself, up to 64 MiB per call. The previous ceiling was about 750 KB.

CEF:

- `heap.snapshot` is implemented and writes V8's `.heapsnapshot`.
- The automation bridge is installed once per document instead of being sent with every call.
- The CEF native test now runs on Windows as well as macOS.

Fixes:

- Windows: a pipe named through `TAURI_HASGARD_SOCKET` without the `tauri-hasgard-` prefix accepted one connection and then moved to another name.
- A ref handed out for a node that had been swept as detached and later re-attached could not be used.
- A request that names no window could run alongside a request sent to `main`, which it targets.

The native suites pass for Wry and CEF on macOS and Windows. A client older than 0.8.0 works with this plugin; the new methods need plugin 0.8.0. JavaScript dialog interception on CEF is still unavailable, and downloads and native operating-system dialogs are not covered.
