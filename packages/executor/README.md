# Hasgard Playwright executor

Shared page interactions implemented with `playwright-core`. The `act(page,
method, params)` export can be used by an application's existing CDP connection;
it does not start a browser or require the Hasgard debugging plugin. Native
windows, application commands and permissions remain owned by the application.

Hasgard's CEF backend uses the same implementation in a packaged executable.
Build it with `bun run --cwd packages/executor build`, then bundle
`target/hasgard-playwright` beside the application executable. Windows builds use
`hasgard-playwright.exe`. Development fixtures may select its absolute path with
`TAURI_HASGARD_PLAYWRIGHT`. No Node or Bun installation is needed on the user's
machine. The host communicates over private process pipes; no debugging port is
opened. A missing executor fails explicitly and never substitutes DOM events.

The CEF backend routes click, double-click, hover, fill, type, check and select
through Playwright. These now use browser input and actionability checks. Wry's
WKWebView adapter retains its existing implementation; it is not exposed as a
Playwright Page. The method names and result envelopes remain shared, but trusted
input and obstruction detection are CEF capabilities, not claims of Wry parity.

Element refs remain native Hasgard refs. For an action, the host marks the exact
connected node with a unique temporary attribute and removes it afterwards;
Playwright locates that node without guessing a CSS path or executing a synthetic
click. Detached refs fail. Browser-wide commands are unavailable on this scoped
transport, and native target replacement creates a new executor.
