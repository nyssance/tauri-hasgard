# 0.6.10

CEF gains console, network and route support, and the documentation is rewritten.

- CEF `logs` reads the page's main-world console through CDP, including output written before the first automation request. Object arguments are one level deep.
- CEF `network` lists completed `fetch` and `XMLHttpRequest` exchanges from the CDP Network domain.
- CEF `route` fulfills or aborts `fetch` and `XMLHttpRequest` requests through the CDP Fetch domain, with the Wry rule semantics. Tauri IPC is never routed.
- The README now leads with the MCP setup for Claude Code and Codex. The protocol reference lists every method, error code and environment variable, and documents that the MCP `eval`, `ipc` and `drop` tools appear only with `TAURI_HASGARD_MCP_ENABLE_DANGEROUS_TOOLS=1`.
- Troubleshooting no longer claims that release builds disable the plugin; registration is the only switch.

CEF JavaScript dialog interception and heap snapshots remain unimplemented and return an error. Version 0.6.9 was published for the plugin crate only; this release realigns the plugin, CLI and npm package. Wry behavior and the Playwright client API are unchanged from 0.6.8.
