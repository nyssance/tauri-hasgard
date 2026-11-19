//! MCP server for [Tauri Hasgard](https://github.com/nyssance/tauri-hasgard).
//!
//! [`HasgardMcpServer`] is an [`rmcp`] `ServerHandler`. It reaches the application either
//! through the plugin's local endpoint ([`HasgardMcpServer::endpoint`]) or through a
//! function the host supplies ([`HasgardMcpServer::in_process`]), so the same tools can be
//! served over stdio, from inside the application, or over an ACP connection.

mod mcp;
mod protocol;

/// Internals shared with the `tauri-hasgard` CLI. Not a stable API.
#[doc(hidden)]
pub mod client;
#[doc(hidden)]
pub mod scenario;
#[doc(hidden)]
pub mod style;
#[doc(hidden)]
pub mod support;

pub use client::InProcessCall;
pub use mcp::{HasgardMcpServer, serve_stdio};
pub use protocol::RpcError;
pub use rmcp;
