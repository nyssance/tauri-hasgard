# 0.7.0

The MCP server becomes a library, connects in one command, and can be served from inside an application, including over ACP.

- One step for Claude Code and Codex: `claude mcp add tauri-hasgard -- npx -y @nyssance/tauri-hasgard-cli mcp`. The CLI is now on npm as `@nyssance/tauri-hasgard-cli`, with prebuilt binaries for macOS Apple Silicon, Windows x64 and Linux x64. Homebrew, Scoop and `cargo install` are unchanged.
- New crate `tauri-hasgard-mcp`: the Hasgard tools as an `rmcp` `ServerHandler`. `tauri-hasgard mcp` is this library over stdio, with the same tools and behavior as 0.6.10.
- New plugin feature `mcp`: `Automation::mcp_server` serves the tools from the application's own process, with no endpoint and no CLI.
- MCP over ACP: an application that starts an agent over ACP attaches the server to the session through the official `agent-client-protocol-rmcp` bridge, and the agent's user configures nothing. MCP over ACP is a draft behind unstable features of the ACP SDK; Hasgard itself depends only on `rmcp`.
- `HasgardMcpServer::with_dangerous_tools` sets the `eval`, `ipc` and `drop` gate per server.

Validated by the existing Rust and TypeScript suites, a new in-process server test, and an end-to-end test in which an ACP agent calls a Hasgard tool through `mcp/message`. The npm launcher was installed from locally built packages and started the MCP server on macOS; the Windows and Linux packages are assembled by the same script from the release archives. The CLI commands, the JSON-RPC protocol, the Playwright client API and Wry and CEF behavior are unchanged from 0.6.10.
