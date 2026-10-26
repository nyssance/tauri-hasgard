# 0.6.0-alpha.5

Tighten the Tauri 3 Wry release line: smaller CLI binaries, cleaner published packages, and a lint-clean workspace.

- Build CLI release binaries with fat LTO, one codegen unit, stripped symbols, and abort-on-panic; the macOS Apple Silicon binary shrinks from 7.0 MB to 3.0 MB.
- Declare `rust-version = "1.95"` for every crate to match Tauri 3, exclude bridge unit tests from the published plugin crate, and fix the rustdoc warning in the CLI `select` help text.
- Stop shipping test declaration files in the npm package and require Node 24 or later.
- Clear every `bun lint` warning and fail CI on new ones; type the MCP stdio E2E client and attach `cause` to launch-cleanup and top-level-await errors.
- Run native E2E and release builds on macOS 26 and Ubuntu 26.04 runners, pass `--locked` and `--frozen-lockfile` in every CI job, and group Dependabot updates per ecosystem.
- Point the fixture Tauri config schema at 3.0.0-alpha.5 and drop TypeScript options that TypeScript 7 already implies.

Local validation includes 73 passing macOS native E2E tests covering real windows, input, dialogs, screenshots, and process cleanup. Release publication also requires the cross-platform native E2E workflow to pass.

Requires Tauri 3 with Wry. Tauri 2 applications should remain on the 0.5.x line.
CEF is unsupported. This prerelease uses the npm `next` tag; stable Homebrew and Scoop channels remain unchanged. macOS supports Apple Silicon only.
