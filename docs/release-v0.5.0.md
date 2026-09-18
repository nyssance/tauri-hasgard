# 0.5.0

This release closes the reviewed gaps against the vendored tauri-pilot and
tauri-playwright implementations while retaining one native application and one
JSON-RPC protocol across the plugin, CLI, MCP server, and test client.

- Bind automation and callbacks to an ACL-authorized window origin and fresh
  one-use handshake tokens. Revoke authorization on navigation or destruction;
  reject cross-origin navigation before executing it.
- Record native macOS window video as MP4 through every client. Capture and
  encoding have deadlines; window destruction and application exit cancel and
  reap recording workers. Existing output files are never overwritten.
- Run TOML scenarios through MCP using the same runner as the CLI. Validate
  required values and storage assertions, preserving empty strings as valid data.
- Fix radio selection, native WebView focus, Unix socket ownership cleanup,
  inactive recording errors, and recorded window scope in replay/export.
- Require Windows native E2E to pass alongside macOS and both Linux architectures.

macOS supports Apple Silicon only; Intel Macs are unsupported. Video currently
requires macOS, ffmpeg, screen-recording permission, and an output filesystem
supporting hard links. Windows ARM64 has compile coverage, not native E2E coverage.
Historical local keyboard failures remain documented; this release's validation
uses remote native CI without repeating local keyboard stress tests.

See [the comparison and verification record](https://github.com/nyssance/tauri-hasgard/blob/v0.5.0/benchmarks/macos/COMPARISON-2026-09-19.md)
for the bounded scope and seven rounds of implementation review.
