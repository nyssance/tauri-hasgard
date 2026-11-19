# Tauri Hasgard

[![crates.io](https://img.shields.io/crates/v/tauri-plugin-hasgard)](https://crates.io/crates/tauri-plugin-hasgard)
[![npm](https://img.shields.io/npm/v/@nyssance/tauri-hasgard)](https://www.npmjs.com/package/@nyssance/tauri-hasgard)
[![CI](https://github.com/nyssance/tauri-hasgard/actions/workflows/ci.yml/badge.svg)](https://github.com/nyssance/tauri-hasgard/actions/workflows/ci.yml)

Automation for Tauri 3 applications. Hasgard drives the real native webviews of a running app, so an AI client, a terminal or a Playwright test sees and clicks what a user would.

```console
$ tauri-hasgard windows
main       tauri://localhost                 Hasgard Fixture
settings   tauri://localhost/settings.html   Settings
$ tauri-hasgard --window main snapshot -i
- textbox "Display name" [ref=e1]
- button "Save" [ref=e2]
- button "Open dialog" [ref=e3]
- button "Open settings" [ref=e4]
$ tauri-hasgard --window main click '@e2'
```

| You want to                    | Use                                                                       |
| ------------------------------ | ------------------------------------------------------------------------- |
| Let Claude Code or Codex drive | [`tauri-hasgard mcp`](#connect-claude-code-or-codex)                      |
| Inspect and click by hand      | [`tauri-hasgard` CLI](#use-the-cli)                                       |
| Write E2E tests                | [`@nyssance/tauri-hasgard`](packages/playwright/README.md) for Playwright |

All three talk to one plugin inside your app.

|         | Supported                                   |
| ------- | ------------------------------------------- |
| Tauri   | 3 (Tauri 2: use Hasgard 0.5.x)              |
| Webview | Wry by default, [CEF](docs/cef.md) opt-in   |
| Desktop | macOS Apple Silicon, Windows x64, Linux x64 |

## Register the plugin

```sh
cd src-tauri
cargo add tauri-plugin-hasgard tauri-runtime-wry@3.0.0-alpha.6
```

```rust
tauri::Builder::default()
    .runtime(tauri_runtime_wry::Wry::default())
    .plugin(tauri_plugin_hasgard::init())
    .run(tauri::generate_context!())
    .expect("failed to run Tauri application");
```

Add `hasgard:default` to a capability that covers every window you automate, for example `src-tauri/capabilities/default.json`:

```json
{
  "windows": ["*"],
  "permissions": ["hasgard:default"]
}
```

Without that permission the client connects but every read fails with `hasgard.__callback not allowed`.

The plugin is active in every build that registers it, release builds included. Gate the `.plugin(...)` call yourself if shipped builds must not expose automation.

## Install the CLI

```sh
brew install nyssance/tap/tauri-hasgard        # macOS Apple Silicon
scoop bucket add nyssance https://github.com/nyssance/scoop-bucket
scoop install nyssance/tauri-hasgard           # Windows x64
cargo install tauri-hasgard-cli                # anywhere with Rust
```

Prebuilt archives for macOS Apple Silicon, Windows x64 and Linux x64 are on each [release](https://github.com/nyssance/tauri-hasgard/releases).

## Connect Claude Code or Codex

Start your app, then:

```sh
claude mcp add tauri-hasgard -- tauri-hasgard mcp   # Claude Code
codex mcp add tauri-hasgard -- tauri-hasgard mcp    # Codex
```

Project configuration files and options are in the [walkthrough](docs/getting-started.md#4-hand-it-to-an-ai-client).

## Use the CLI

```sh
tauri-hasgard ping                              # is an app reachable
tauri-hasgard windows                           # window labels
tauri-hasgard --window main snapshot -i         # interactive elements with refs
tauri-hasgard --window main click '@e3'         # by ref from the last snapshot
tauri-hasgard --window main fill '#name' 'Ny'   # by CSS selector
tauri-hasgard --window main press Enter
tauri-hasgard --window main screenshot out.png
tauri-hasgard --window main logs
tauri-hasgard --window main ipc my_command
```

A target is a snapshot ref (`@e3`) or a CSS selector. Refs expire when the UI changes; take a new snapshot. Add `--json` for machine-readable output. `tauri-hasgard --help` lists every command.

## Write Playwright tests

```ts
test("opens settings", async ({ hasgard, window }) => {
  await window.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = await hasgard.waitForWindow("settings", 5_000)
  await expect(settings.getByRole("heading", { name: "Settings" })).toBeVisible()
})
```

Setup is in the [Playwright guide](packages/playwright/README.md). Tests run against the real application; there is no `page` fixture and no mocked browser mode.

## More

- [CEF backend](docs/cef.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Protocol reference](docs/protocol.md) · [Architecture](docs/architecture.md)
- [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

## License

Apache-2.0. Upstream MIT notices are preserved in [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
