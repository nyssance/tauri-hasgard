# CLI and MCP walkthrough

Prerequisites: the plugin is [registered](../README.md#register-the-plugin) and the CLI is [installed](../README.md#install-the-cli).

## 1. Start the app

```sh
bun run tauri dev
```

Leave it running. Hasgard attaches to a running app; it never launches one.

## 2. Inspect it

```sh
tauri-hasgard ping
tauri-hasgard windows
tauri-hasgard --window main snapshot -i
```

`windows` prints the labels to pass to `--window`. `snapshot -i` prints the interactive elements, each with a ref such as `@e3`.

## 3. Act on it

```sh
tauri-hasgard --window main click '@e3'
tauri-hasgard --window main fill 'input[name=email]' 'me@example.com'
tauri-hasgard --window main press Enter
tauri-hasgard --window main wait '#saved'
tauri-hasgard --window main screenshot screen.png
```

A target is a ref from the latest snapshot or a CSS selector. Refs are invalid after the UI changes.

`screenshot` redraws the document from the DOM. `screenshot-native --output viewport.png` captures the pixels actually on screen; platform support is listed in the [protocol](protocol.md).

## 4. Hand it to an AI client

```sh
claude mcp add tauri-hasgard -- tauri-hasgard mcp   # Claude Code
codex mcp add tauri-hasgard -- tauri-hasgard mcp    # Codex
```

Or write the configuration by hand. `.mcp.json` in the project, for Claude Code and clients that read the same format:

```json
{
  "mcpServers": {
    "tauri-hasgard": { "command": "tauri-hasgard", "args": ["mcp"] }
  }
}
```

`~/.codex/config.toml` for Codex, which is what `codex mcp add` writes:

```toml
[mcp_servers.tauri-hasgard]
command = "tauri-hasgard"
args = ["mcp"]
```

- The server attaches to the running app and does not start it.
- Tools are named `hasgard.<command>`, for example `hasgard.snapshot`, and each takes an optional `window` label. Set a default with `args = ["mcp", "--window", "main"]`.
- `eval`, `ipc` and `drop` are hidden by default. Expose them with `TAURI_HASGARD_MCP_ENABLE_DANGEROUS_TOOLS=1` in the server's environment: `codex mcp add tauri-hasgard --env TAURI_HASGARD_MCP_ENABLE_DANGEROUS_TOOLS=1 -- tauri-hasgard mcp`, or `-e` for `claude mcp add`.
- If the client cannot find the binary, use its absolute path (`which tauri-hasgard`) as `command`.
- Restart the client's MCP connection after changing the configuration.

## Several apps at once

Each app listens on its own endpoint: a Unix socket on macOS and Linux, a named pipe on Windows. The CLI finds a single running app by itself. With more than one, choose explicitly:

```sh
TAURI_HASGARD_SOCKET=/tmp/my-app.sock bun run tauri dev
tauri-hasgard --socket /tmp/my-app.sock --window main snapshot
```

`--socket` goes before the command, including before `mcp`.

## Next

- `tauri-hasgard <command> --help` for options.
- [Protocol reference](protocol.md) for dialogs, routes, storage, recording, video and their limits.
- [Troubleshooting](troubleshooting.md) when a command cannot connect.
