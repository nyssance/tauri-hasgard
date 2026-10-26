# 0.6.0-alpha.4

Update the Tauri 3 Wry release line with current dependencies and modern JavaScript tooling.

- Upgrade Tauri and Wry runtime dependencies to 3.0.0-alpha.5; refresh the Rust and JavaScript lockfiles.
- Modernize the handwritten WebView bridge and include it in Bun and ts7-lint checks.
- Expand evaluation regression coverage for async expressions, statements, trailing comments, and runtime errors that must execute only once.
- Replace tsup/Rollup with Bun builds for the Playwright package and process supervisor, retaining TypeScript declarations.
- Replace Biome/Prettier with Bun formatting and linting; add `fab u` for workspace dependency updates.

Local validation includes 73 passing macOS native E2E tests covering real windows, input, dialogs, screenshots, and process cleanup. Release publication also requires the cross-platform native E2E workflow to pass.

Requires Tauri 3 with Wry. Tauri 2 applications should remain on the 0.5.x line.
CEF is unsupported. This prerelease uses the npm `next` tag; stable Homebrew and Scoop channels remain unchanged. macOS supports Apple Silicon only.

Supersedes the unpublished alpha.3 attempt. The JavaScript process diagnostics test uses an uncatchable signal to avoid runtime crash-handler delays; real Tauri SIGTRAP lifecycle coverage is unchanged.
