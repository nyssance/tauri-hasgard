# tauri-hasgard

CLI and stdio MCP server for a running Tauri 3 application. The app must register [`tauri-plugin-hasgard`](https://crates.io/crates/tauri-plugin-hasgard).

```sh
cargo install tauri-hasgard-cli
```

## CLI

Start your app, then:

```sh
tauri-hasgard windows
tauri-hasgard --window main snapshot -i
tauri-hasgard --window main click '@e3'
tauri-hasgard --window main screenshot out.png
```

`tauri-hasgard --help` lists every command.

## MCP

```sh
claude mcp add tauri-hasgard -- tauri-hasgard mcp   # Claude Code
codex mcp add tauri-hasgard -- tauri-hasgard mcp    # Codex
```

Any other MCP client: launch `tauri-hasgard mcp` as a stdio server. Tools are named `hasgard.<command>` and take an optional `window` label. `eval`, `ipc` and `drop` appear only with `TAURI_HASGARD_MCP_ENABLE_DANGEROUS_TOOLS=1`.

[Setup](https://github.com/nyssance/tauri-hasgard#readme) · [Walkthrough](https://github.com/nyssance/tauri-hasgard/blob/main/docs/getting-started.md) · [Protocol](https://github.com/nyssance/tauri-hasgard/blob/main/docs/protocol.md)
