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
claude mcp add tauri-hasgard -- npx -y tauri-hasgard mcp   # Claude Code
codex mcp add tauri-hasgard -- npx -y tauri-hasgard mcp    # Codex
```

Check the connection with `claude mcp list` or `codex mcp list`, then ask the client to list your app's windows.

Configuration files, options, and serving the tools from inside your app or over ACP are in the [MCP guide](mcp.md).

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
