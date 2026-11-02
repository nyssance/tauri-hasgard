# 0.6.4

Add JavaScript heap snapshots of a webview.

- `heap.snapshot` is available as CLI `heap-snapshot --output <path>`, MCP `heap_snapshot`, and Playwright `window.heapSnapshot(path)`. The engine collects garbage first, so the file holds live objects only, and the result reports its `format`.
- macOS connects WebKit's in-process inspector without opening a window and writes JavaScriptCore's inspector JSON (`jsc`). The inspector is detached afterwards, and repeated snapshots in one session work.
- Windows uses WebView2's DevTools protocol (`HeapProfiler.takeHeapSnapshot`) and writes a V8 `.heapsnapshot` (`v8`).

Validated locally on macOS: 75 native E2E tests (including two consecutive heap snapshots), 131 client unit tests, and the Rust workspace tests. The Windows path was checked by cross-target clippy only; native Windows runs in the release workflow.

Requires Tauri 3 + Wry. Tauri 2 applications should use Hasgard 0.5.x. macOS supports Apple Silicon only.
