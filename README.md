# Tauri Hasgard

[![crates.io](https://img.shields.io/crates/v/tauri-plugin-hasgard)](https://crates.io/crates/tauri-plugin-hasgard)
[![npm](https://img.shields.io/npm/v/@nyssance/tauri-hasgard)](https://www.npmjs.com/package/@nyssance/tauri-hasgard)
[![CI](https://github.com/nyssance/tauri-hasgard/actions/workflows/ci.yml/badge.svg)](https://github.com/nyssance/tauri-hasgard/actions/workflows/ci.yml)

Hasgard is the automation bridge for **Tauri 3**. It connects to one running Tauri application and drives its real native webviews through a shared JSON-RPC protocol.

Use the same running app from:

- **CLI** — inspect windows, take accessibility snapshots, click, fill, press keys, capture screenshots and call IPC.
- **MCP** — give Claude Code, Codex or another MCP client the same tools.
- **Playwright** — write E2E tests with Playwright's test runner and assertions.

Hasgard does not launch a browser, emulate a Tauri webview or provide a fake `Page`. The app must be running and the plugin must be registered in it.

## Quick start

### 1. Register the plugin

From your Tauri project's `src-tauri` directory:

```sh
cargo add tauri-plugin-hasgard tauri-runtime-wry@3.0.0-alpha.6
```

Register the plugin and the Wry runtime in your builder:

```rust
tauri::Builder::default()
    .runtime(tauri_runtime_wry::Wry::default())
    .plugin(tauri_plugin_hasgard::init())
    .run(tauri::generate_context!())
    .expect("failed to run Tauri application");
```

Grant the permission to every window you intend to automate. In `src-tauri/capabilities/default.json`:

```json
{
  "windows": ["*"],
  "permissions": ["hasgard:default"]
}
```

Registering the plugin enables automation in every build, including release builds. If production builds must not expose it, conditionally add the `.plugin(...)` call in your application.

Start the app and leave it running. Hasgard attaches to an existing process:

```sh
bun run tauri dev
```

### 2. Check the connection

Install the CLI with any one of these methods:

```sh
npm install -g tauri-hasgard
# or: brew install nyssance/tap/tauri-hasgard
# or: scoop bucket add nyssance https://github.com/nyssance/scoop-bucket
#     scoop install nyssance/tauri-hasgard
# or: cargo install tauri-hasgard-cli
```

Then inspect the running app:

```console
$ tauri-hasgard ping
✓ Connected. Plugin and CLI both 0.8.2.
$ tauri-hasgard windows
main       tauri://localhost                 My application
$ tauri-hasgard --window main snapshot -i
- textbox "Display name" [ref=e1]
- button "Save" [ref=e2]
```

The `windows` command gives you the label for `--window`. Snapshot refs are short-lived: take a new snapshot after the UI changes.

### 3. Drive the UI

```sh
tauri-hasgard --window main click '@e2'
tauri-hasgard --window main fill 'input[name=email]' 'me@example.com'
tauri-hasgard --window main press Enter
tauri-hasgard --window main wait '#saved'
tauri-hasgard --window main screenshot screen.png
```

Targets can be a ref from the latest snapshot or a CSS selector. Add `--json` for machine-readable output; run `tauri-hasgard --help` for the complete command list.

## Connect an AI client

With the app running, register the MCP server in one command:

```sh
claude mcp add tauri-hasgard -- npx -y tauri-hasgard mcp
codex mcp add tauri-hasgard -- npx -y tauri-hasgard mcp
```

Check the connection with `claude mcp list` or `codex mcp list`, then ask the client to list the application's windows. The MCP server and CLI use the same plugin endpoint and the same tool semantics.

For an app that hosts its own agent, Hasgard also exposes an in-process MCP server. See the [MCP guide](docs/mcp.md).

## Write Playwright tests

Requires Node.js 24 or newer.

Install the test fixture:

```sh
bun add --dev @nyssance/tauri-hasgard @playwright/test
```

The fixture launches or attaches to your app, then exposes `HasgardApplication` and `HasgardWindow` objects:

```ts
test("opens settings", async ({ hasgard, window }) => {
  await window.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = await hasgard.waitForWindow("settings", 5_000)
  await expect(settings.getByRole("heading", { name: "Settings" })).toBeVisible()
})
```

See the [Playwright guide](packages/playwright/README.md) for fixture setup, lifecycle cleanup, locators and keyboard behavior. Tests run against real native windows; there is no mocked browser mode and no `page` fixture.

## Supported platforms

| Component | Support |
| --- | --- |
| Tauri | 3.0.0-alpha.6 |
| Webview | Wry; CEF is opt-in |
| CLI binaries | macOS Apple Silicon, Windows x64, Linux x64 |

The CEF setup and its operation limits are documented in [docs/cef.md](docs/cef.md).

## Documentation

- [CLI and MCP walkthrough](docs/getting-started.md)
- [MCP guide](docs/mcp.md)
- [Playwright guide](packages/playwright/README.md)
- [Protocol reference](docs/protocol.md)
- [Architecture](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md)

## License

Apache-2.0. Upstream MIT notices are preserved in [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
