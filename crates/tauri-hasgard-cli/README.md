# tauri-hasgard

CLI and stdio MCP server for running Tauri 3 Wry applications. Requires `tauri-plugin-hasgard` in the app and a debug build.

```sh
cargo install tauri-hasgard-cli
# Start your Tauri app in another terminal, then:
tauri-hasgard ping
tauri-hasgard windows
tauri-hasgard --window main snapshot
```

Use a window label returned by `windows`. Run `tauri-hasgard mcp` to connect an AI client.

[Setup and tutorial](https://github.com/nyssance/tauri-hasgard/blob/main/docs/getting-started.md) · [Protocol](https://github.com/nyssance/tauri-hasgard/blob/main/docs/protocol.md)
