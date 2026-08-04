# Changelog

## 0.2.1

Supersedes `0.2.0`, which was tagged but never published.

- Add `locator.filter({ hasText, hasNotText })`. Filters compose and apply before
  `nth`, so `filter(...).first()` is the first _matching_ element.
- Add `locator.setInputFiles(...)`, accepting paths on the test machine or
  in-memory payloads. An empty array deselects.
- Add `locator.wheel(dx, dy)` and `window.wheel(dx, dy)`. The page sees a real
  `wheel` event and may cancel it; the promise resolves to whether it did.
- Add `locator.clear()`.
- Add `window.dialogs.{accept, dismiss, list, clear}`. `alert`/`confirm`/`prompt`
  block the webview until answered, so they are now always answered — dismissed
  by default — and recorded. Without this, an app that calls `confirm()` froze
  and every in-flight call failed on an unrelated timeout.
- Fix `count()` and `waitFor()` ignoring filters on a CSS locator, which reported
  the unfiltered count and woke on an excluded match.

## 0.1.2

- Keep Windows native E2E diagnostics without allowing Windows-only failures to block releases.

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
