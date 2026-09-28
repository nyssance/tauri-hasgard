# 0.6.0-alpha.1

Migrate the plugin and native fixture to Tauri 3 with the Wry runtime.
Tauri 2 applications must stay on the 0.5.x release line.

- Register Wry explicitly with `Builder::default().runtime(tauri_runtime_wry::Wry::default())`.
- Use the Tauri 3 plugin initialization script and Wry native WebView accessors.
- Preserve the shared CLI, MCP and Playwright JSON-RPC contract.
- Export JavaScript with ESNext and use Bun 1.4.2.

CEF is unsupported. This is a prerelease; npm uses the `next` tag and stable
Homebrew/Scoop channels remain unchanged. macOS supports Apple Silicon only.
