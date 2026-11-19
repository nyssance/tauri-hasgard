# MCP server

The Hasgard tools are one MCP server with three ways to reach it. Pick by who starts the agent.

| Setup                             | The user does             | Transport            |
| --------------------------------- | ------------------------- | -------------------- |
| Claude Code, Codex, any MCP client | One `mcp add` command     | stdio                |
| Your app hosts the agent over ACP | Nothing                   | MCP over ACP (draft) |
| Your app serves MCP itself        | Whatever your app exposes | Any `rmcp` transport |

Tools are named `hasgard.<command>`, for example `hasgard.snapshot`, and each takes an optional `window` label.

## stdio

Start your app, then register the server. `npx` downloads the binary for your platform on first use:

```sh
claude mcp add tauri-hasgard -- npx -y tauri-hasgard mcp   # Claude Code
codex mcp add tauri-hasgard -- npx -y tauri-hasgard mcp    # Codex
```

Check that it works, with your app running:

```console
$ npx -y tauri-hasgard ping
✓ Connected. Plugin and CLI both 0.7.0.
$ claude mcp list        # or: codex mcp list
```

`ping` proves the CLI reaches your app; the list should show `tauri-hasgard` as connected. If `ping` fails, see [troubleshooting](troubleshooting.md).

With the CLI [installed](../README.md#install-the-cli), `tauri-hasgard mcp` is the same server without the `npx` startup cost.

Or write the configuration by hand. `.mcp.json` in the project, for Claude Code and clients that read the same format:

```json
{
  "mcpServers": {
    "tauri-hasgard": { "command": "npx", "args": ["-y", "tauri-hasgard", "mcp"] }
  }
}
```

`~/.codex/config.toml` for Codex, which is what `codex mcp add` writes:

```toml
[mcp_servers.tauri-hasgard]
command = "npx"
args = ["-y", "tauri-hasgard", "mcp"]
```

- The server attaches to the running app and does not start it.
- Set a default window with `mcp --window main`.
- With several apps running, pin one: put `--socket /path/to/app.sock` before `mcp`.
- Restart the client's MCP connection after changing the configuration.

## Inside your application

An app that registers the plugin can serve the same tools from its own process: no endpoint is opened, and no CLI is installed. Enable the plugin's `mcp` feature:

```toml
tauri-plugin-hasgard = { version = "0.7", features = ["mcp"] }
```

```rust
use tauri::Manager;

let automation = app.state::<tauri_plugin_hasgard::Automation>().inner().clone();
let server = automation.mcp_server(Some("main".to_owned()));
```

`server` is an [`rmcp`](https://docs.rs/rmcp) `ServerHandler`; serve it over any transport `rmcp` supports. To keep the local endpoint closed as well, register the plugin with `init_with_options(Options { listen: false })`.

## Over ACP

When your app is the ACP client that starts the agent, attach the server to the session. The agent then calls the tools through the ACP connection it already has, so its user configures nothing.

```toml
agent-client-protocol = { version = "5.4", features = ["unstable_mcp_over_acp"] }
agent-client-protocol-rmcp = { version = "5.4", features = ["rmcp_3", "unstable_mcp_over_acp"] }
```

```rust
use agent_client_protocol::{Agent, mcp_server::McpServer};
use agent_client_protocol_rmcp::rmcp_3::McpServerExt;

let hasgard = McpServer::<Agent>::from_rmcp("tauri-hasgard", move || automation.mcp_server(Some("main".to_owned())));
connection.build_session(cwd).with_mcp_server(hasgard)?.start_session();
```

MCP over ACP is a [draft](https://agentclientprotocol.com/rfds/mcp-over-acp) behind unstable features in the ACP SDK, and an agent must advertise support for it. Hasgard depends only on `rmcp`, so a change in the draft is absorbed by the bridge crate. `crates/tauri-hasgard-mcp/tests/acp.rs` runs a tool call through this path. For an agent without the capability, use the stdio setup.

## Dangerous tools

`eval`, `ipc` and `drop` run arbitrary code or commands in the application, so they are hidden by default.

- stdio: set `TAURI_HASGARD_MCP_ENABLE_DANGEROUS_TOOLS=1` in the server's environment, for example `codex mcp add tauri-hasgard --env TAURI_HASGARD_MCP_ENABLE_DANGEROUS_TOOLS=1 -- npx -y tauri-hasgard mcp`, or `-e` for `claude mcp add`.
- In process: `server.with_dangerous_tools(true)`.
