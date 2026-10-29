# Tauri Hasgard

Automate a running Tauri application through its real native webviews. The CLI, MCP server, and Playwright Test fixture share one JSON-RPC plugin.

This repository targets **Tauri 3 + Wry**; Tauri 2 projects use Hasgard 0.5.x. macOS requires Apple Silicon. CEF is not supported. The plugin is active only in debug builds.

## Choose a client

Every setup requires the Rust plugin in your application.

| Task                       | Install alongside the plugin                     |
| -------------------------- | ------------------------------------------------ |
| Inspect and control an app | `tauri-hasgard` CLI                              |
| Connect an AI client       | Same CLI, launched with `tauri-hasgard mcp`      |
| Run E2E tests              | `@nyssance/tauri-hasgard` and `@playwright/test` |

There is no `init` command or Hasgard project configuration file.

## Register the plugin

```sh
cd src-tauri
cargo add tauri-plugin-hasgard@0.6.2
```

```toml
[dependencies]
tauri = "3.0.0-alpha.5"
tauri-runtime-wry = "3.0.0-alpha.5"
tauri-plugin-hasgard = "0.6.2"
```

```rust
fn run() {
    tauri::Builder::default()
        .runtime(tauri_runtime_wry::Wry::default())
        .plugin(tauri_plugin_hasgard::init())
        .run(tauri::generate_context!())
        .expect("failed to run Tauri application");
}
```

Add `hasgard:default` to the existing permissions in `src-tauri/capabilities/default.json`, covering every window under test. Keep your other permissions; this is only the Hasgard fragment:

```json
{
  "windows": ["*"],
  "permissions": ["hasgard:default"]
}
```

`hasgard:default` grants only the internal `callback` and `__callback` commands used to return WebView evaluation results. Without it, the native server can accept connections, but evaluation, locators, screenshots, and Playwright assertions fail with `hasgard.__callback not allowed`.

The plugin is inert in release builds. In debug builds it creates an application-scoped Unix socket or Windows named pipe and injects the Hasgard bridge into each webview.

## Start here

- [CLI and MCP tutorial](docs/getting-started.md): start the app, inspect a window, click, and capture a screenshot.
- [Playwright tutorial](packages/playwright/README.md): configure, launch, and test your app.
- [Troubleshooting](docs/troubleshooting.md): connection, permissions, readiness, and keyboard input.
- [Contributing](CONTRIBUTING.md): run the repository's example and checks.
- [Architecture](docs/architecture.md) · [Protocol reference](docs/protocol.md) · [Changelog](CHANGELOG.md)

Hasgard exposes `HasgardApplication → HasgardWindow → HasgardLocator`, not a Playwright `Page`. Tests drive the native app; there is no mocked browser mode. For frontend-only browser tests, use stock Playwright against your dev server.

## License

Apache-2.0. Upstream MIT notices are preserved in [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
