# tauri-hasgard-mcp

The [Tauri Hasgard](https://github.com/nyssance/tauri-hasgard) tools as an MCP server: an [`rmcp`](https://docs.rs/rmcp) `ServerHandler` you can serve over stdio, from inside your application, or over an ACP connection.

Most users do not need this crate directly:

- To connect Claude Code or Codex, run `npx -y @nyssance/tauri-hasgard-cli mcp`.
- To serve the tools from a Tauri app, enable the `mcp` feature of `tauri-plugin-hasgard` and call `Automation::mcp_server`.

Use it directly to reach an application another way:

```rust
use tauri_hasgard_mcp::HasgardMcpServer;

// Through the plugin's local endpoint; `None` discovers the running application.
let server = HasgardMcpServer::endpoint(None, Some("main".to_owned()));

// Or through your own function: Hasgard protocol method and params in, result out.
let server = HasgardMcpServer::in_process(|method, params| async move { call_app(method, params).await }, None);
```

`eval`, `ipc` and `drop` are hidden unless `with_dangerous_tools(true)` is called or `TAURI_HASGARD_MCP_ENABLE_DANGEROUS_TOOLS=1` is set.

[MCP guide](https://github.com/nyssance/tauri-hasgard/blob/main/docs/mcp.md), including MCP over ACP.
