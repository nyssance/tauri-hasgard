# Changelog

## 0.1.1

- Keep Windows builds, E2E coverage, release archives, and Scoop distribution enabled.
- Skip the unsupported WebView2 Tab-traversal assertion without weakening the remaining Windows E2E suite.

## 0.1.0

- Introduce the protocol-native `HasgardApplication`, `HasgardWindow`, and `HasgardLocator` APIs.
- Add Playwright Test worker fixtures with explicit socket and Tauri window isolation.
- Add CSS, accessibility role/name, snapshot-ref, and coordinate targets.
- Add per-window serialization for atomic `snapshot → match → action` operations.
- Add strict JSON-RPC 2.0 framing, response-ID matching, and typed RPC errors.
- Add native failure screenshots and a real multi-window Tauri E2E fixture.
- Remove the copied fake `Page`, browser mock mode, CDP fallback, and whitespace-split process launcher.
