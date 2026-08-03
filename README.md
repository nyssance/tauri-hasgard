# Tauri Hasgard

Tauri Hasgard is one automation surface for Tauri 2 applications. It combines a native Tauri plugin, a cross-platform CLI, an MCP server, and a Playwright Test fixture without pretending that a WebKit webview is a Chromium `Page`.

The project is named after Hasgard, the Taurus Gold Saint from _Saint Seiya: The Lost Canvas_: strong at the boundary, predictable under pressure.

## Packages

| Package                   | Purpose                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `tauri-plugin-hasgard`    | Debug-only JSON-RPC server injected into every Tauri webview                                     |
| `tauri-hasgard`           | CLI and MCP server for inspection, interaction, screenshots, recording, and multi-window control |
| `@nyssance/tauri-hasgard` | Playwright Test fixture backed by the same JSON-RPC protocol                                     |

## What to install

Every Hasgard setup requires `tauri-plugin-hasgard` in the Tauri application. The plugin is the in-process bridge to native webviews; without it, the CLI, MCP server, and Playwright fixture have nothing to connect to.

Choose the client for the job:

| Use case                           | Required                                                     |
| ---------------------------------- | ------------------------------------------------------------ |
| Human or AI inspection and control | Rust plugin + `tauri-hasgard` CLI                            |
| Playwright E2E tests               | Rust plugin + `@nyssance/tauri-hasgard` + `@playwright/test` |
| Both                               | Rust plugin + CLI + Playwright packages                      |

There is no `tauri-hasgard init` command and no Hasgard project configuration file. Registering the plugin is the complete application-side setup.

## Why one protocol

Tests, agents, and local developer tools must observe the same application and invoke the same commands. Hasgard therefore keeps one transport contract and exposes three clients instead of maintaining separate automation stacks.

On macOS and Linux, Hasgard talks to the real WKWebView/WebKitGTK process through the plugin. On Windows, the same protocol remains available while native CDP can still be used separately when a full Chromium `Page` is required.

## 1. Register the required Tauri plugin

```sh
cargo add tauri-plugin-hasgard
```

```toml
[dependencies]
tauri-plugin-hasgard = "0.1"
```

```rust
fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_hasgard::init())
        .run(tauri::generate_context!())
        .expect("failed to run Tauri application");
}
```

The plugin is inert in release builds. In debug builds it creates an application-scoped Unix socket or Windows named pipe and injects the Hasgard bridge into each webview.

## 2A. Use the CLI or connect an AI through MCP

Install the native client:

```sh
# macOS
brew install nyssance/tap/tauri-hasgard

# Windows
scoop bucket add nyssance https://github.com/nyssance/scoop-bucket
scoop install nyssance/tauri-hasgard
```

Use it directly:

```sh
tauri-hasgard windows
tauri-hasgard snapshot
tauri-hasgard click '@e3'
tauri-hasgard mcp
```

`tauri-hasgard mcp` is a standard stdio MCP server. ALwith, Claude Code, and Codex are first-class AI clients; all three launch the same command and receive the same tools.

For ALwith and Claude Code, add the server to the project `.mcp.json`:

```json
{
  "mcpServers": {
    "tauri-hasgard": {
      "command": "tauri-hasgard",
      "args": ["mcp"]
    }
  }
}
```

For Codex, add it to the project `.codex/config.toml`:

```toml
[mcp_servers.tauri-hasgard]
command = "tauri-hasgard"
args = ["mcp"]
```

## 2B. Write Playwright E2E tests

```bash
bun add --dev @nyssance/tauri-hasgard @playwright/test
```

```ts
import { createHasgardTest } from "@nyssance/tauri-hasgard"
import { expect as playwrightExpect, test as playwrightTest } from "@playwright/test"

const { test, expect } = createHasgardTest({
  test: playwrightTest,
  expect: playwrightExpect,
  socketPath: workerIndex => `/tmp/my-app-e2e-${workerIndex}.sock`,
  windowLabel: "main",
  readySelector: '[data-app-ready="true"]',
  launch: {
    command: "bun",
    args: ["run", "tauri", "dev"],
    cwd: import.meta.dirname,
    timeoutMs: 120_000
  }
})

test("opens settings", async ({ hasgard, window }) => {
  await window.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = await hasgard.waitForWindow("settings", 5_000)
  await expect(settings.getByRole("heading", { name: "Settings" })).toBeVisible()
})
```

Hasgard uses Playwright Test for fixtures, isolation, retries, reporters, and parallel workers. The worker-scoped `hasgard` fixture is a `HasgardApplication`; the test-scoped `window` fixture is the configured primary `HasgardWindow`. There is deliberately no `page` fixture: native Tauri webviews do not implement the complete Playwright `Page` contract.

## Status

The repository starts from the strongest parts of `tauri-pilot` and `tauri-playwright`, then converges them on a single JSON-RPC protocol. See [NOTICE.md](NOTICE.md) for provenance.

## License

Apache-2.0. The original MIT notices for adapted upstream work are preserved in [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
