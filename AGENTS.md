# Repository rules

- Do not add silent fallbacks or defensive defaults for required data.
- Keep one JSON-RPC protocol shared by the plugin, CLI, MCP server, and Playwright fixture.
- Do not model a native Tauri webview as a complete Playwright `Page`.
- Tests must cover real multi-window behavior, unequal content heights, dialogs, keyboard input, screenshots, and process cleanup.
- Preserve the upstream MIT notices in `LICENSE` and `NOTICE.md`.
