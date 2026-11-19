# tauri-plugin-hasgard

The in-app half of [Tauri Hasgard](https://github.com/nyssance/tauri-hasgard): it serves JSON-RPC over a Unix socket or Windows named pipe so the `tauri-hasgard` CLI, its MCP server and the Playwright fixture can drive the application's real webviews.

## Wry

```rust
tauri::Builder::default()
    .runtime(tauri_runtime_wry::Wry::default())
    .plugin(tauri_plugin_hasgard::init())
```

Add `hasgard:default` to a capability covering every webview you automate:

```json
{
  "windows": ["*"],
  "permissions": ["hasgard:default"]
}
```

Without it the client connects but cannot receive evaluation results.

## CEF

Enable the `cef` feature and register `init_cef()` on a builder using `tauri_runtime_cef::Cef`. Bundle the `hasgard-playwright` executor beside the application executable; click, hover, fill, type, check and select go through it. Remote pages need neither `hasgard:default` nor Tauri IPC access. Setup, supported operations and limits are in [docs/cef.md](https://github.com/nyssance/tauri-hasgard/blob/main/docs/cef.md).

## Options

- The plugin is active in every build that registers it, release builds included. Registration is the only switch.
- `init_with_options(Options { listen: false })` registers the Wry executor without opening the local endpoint. The managed `Automation` handle then accepts calls from the host through `call`, with an explicit webview label.
- `init_cef_with_executor(options, factory)` lets a CEF host that already ships a JavaScript runtime and Playwright supply its own executor. `playwright::worker_source()` returns the worker script; pass the packaged Playwright module URL as its argument.
- The `mcp` feature adds `Automation::mcp_server`, the Hasgard tools as an in-process MCP server for an app that hosts its own agent, including over ACP. See the [MCP guide](https://github.com/nyssance/tauri-hasgard/blob/main/docs/mcp.md).
- `TAURI_HASGARD_SOCKET` sets the endpoint path before the app starts.
