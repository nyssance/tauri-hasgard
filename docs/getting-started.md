# CLI and MCP tutorial

First [register the plugin](../README.md#register-the-plugin) in an existing Tauri 3 Wry app. Run the following commands from your app root.

## Install the CLI

Install the native client:

```sh
# macOS
brew install nyssance/tap/tauri-hasgard

# Windows
scoop bucket add nyssance https://github.com/nyssance/scoop-bucket
scoop install nyssance/tauri-hasgard

# Linux, or any platform with a Rust toolchain
cargo install tauri-hasgard-cli
```

The Homebrew formula lives in `nyssance/tap`, not in homebrew-core, so the
`nyssance/tap/` prefix is required. Prebuilt archives for all five supported
targets are attached to each [GitHub Release](https://github.com/nyssance/tauri-hasgard/releases).

## Start and inspect the app

In one terminal, start your app in debug mode and leave it running:

```sh
bun run tauri dev
```

This assumes your app has a `tauri` script. Otherwise use your existing Tauri development command.

In another terminal:

```sh
tauri-hasgard ping
tauri-hasgard windows
tauri-hasgard --window main snapshot
```

Use a window label returned by `windows`. From the snapshot, choose the ref of an element you want to click; replace `@e3` below with that ref:

```sh
tauri-hasgard --window main click '@e3'
tauri-hasgard --window main snapshot
tauri-hasgard --window main screenshot screen.png
```

Take a fresh snapshot after UI changes. `screenshot` renders the DOM; for rendered viewport pixels use `screenshot-native --output viewport.png`. See the [protocol](protocol.md) for platform-specific capture support.

If several apps are running, select the endpoint explicitly:

```sh
tauri-hasgard --socket /path/to/app.sock --window main snapshot
```

The endpoint is a Unix socket on macOS/Linux and a named pipe on Windows. You can set `TAURI_HASGARD_SOCKET` before starting the app, then pass the same path to the CLI. See [troubleshooting](troubleshooting.md) if discovery fails.

## Connect an AI client

Keep the debug app running. The AI client starts the CLI as a stdio server; it does not launch your application.

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

For an explicit endpoint, use CLI arguments `--socket`, your endpoint path, then `mcp`. Restart the MCP connection after changing its configuration.

## Next steps

Use `tauri-hasgard --help` or `tauri-hasgard <command> --help` for command options. The [protocol reference](protocol.md) covers scenarios, dialogs, storage, recording, native video, and their limits.
