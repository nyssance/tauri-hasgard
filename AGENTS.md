# Repository rules

- Do not add silent fallbacks or defensive defaults for required data.
- Keep one JSON-RPC protocol shared by the plugin, CLI, MCP server, and Playwright fixture.
- Do not model a native Tauri webview as a complete Playwright `Page`.
- Do not add a mocked browser mode. Every Hasgard client drives one running application through the plugin; a faked `window.__TAURI_INTERNALS__` in headless Chromium tests neither the native webview nor the real Tauri commands.
- Tests must cover real multi-window behavior, unequal content heights, dialogs, keyboard input, screenshots, and process cleanup.
- Preserve the upstream MIT notices in `LICENSE` and `NOTICE.md`.
- Run local fixture debugging and native E2E on the secondary display. Never open debug windows on the primary display unless explicitly requested. If no secondary display is available, stop instead of falling back. CI may explicitly select display 0.
- Keep stable Rust dependency requirements concise: major version for 1.0+, major.minor for 0.x. Keep required prerelease identifiers; lock exact resolved versions in Cargo.lock.
- Match alwith-desktop formatting: use the shared Bun formatting options and rustfmt.toml, run Rust formatting with nightly so unstable options are applied. Keep generated and upstream vendor files excluded.
