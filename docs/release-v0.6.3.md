# 0.6.3

Fix native keyboard completion and multi-window screenshots, and improve the example debugging app.

- WebKit may deliver keyup before keydown. Hasgard now accepts either order while requiring both trusted events for every key, including modifiers.
- Native screenshots preserve the requested window label across the Playwright client and plugin. Capturing a settings window no longer captures the main window instead.
- The fixture uses shared lightweight styling and a compact toolbar. It opens on a secondary display by default and fails if none is available; explicitly set `TAURI_HASGARD_DISPLAY` to choose another display.
- Setup, Playwright, and troubleshooting tutorials are shorter and complete. Rust dependencies and formatting are standardized.

Validated locally on macOS: 74 native E2E tests, three 200-round multi-window keyboard stress cases, 130 client unit tests, 138 bridge tests, and the Rust workspace tests. Cross-platform checks run in the release workflow.

Requires Tauri 3 + Wry. Tauri 2 applications should use Hasgard 0.5.x. CLI binaries: macOS Apple Silicon, Windows x64, and Linux x64.
