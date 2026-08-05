# Changelog

## 0.3.0

- Add `locator.click(options)` with `modifiers`, `button`, `clickCount`, and
  `position`. A right press raises `contextmenu` and a middle press raises
  `auxclick`; neither raises `click`, matching the platform. `dblclick` is now
  `click({ clickCount: 2 })`, so `detail` escalates across the presses and one
  `dblclick` closes the gesture.
- Add `window.frameLocator(selector)`, chainable for nested frames. Same-origin
  only: injected script is bound by the same-origin policy exactly as page
  script is, and a cross-origin frame reports that rather than looking empty.
- Add `window.routes.{fulfill, abort, list, clear}` to shape what the page's own
  `fetch` and `XMLHttpRequest` receive. Rules are declarative rather than
  per-request callbacks, since the bridge cannot await a handler while the page
  sits inside `fetch`. Tauri's own IPC is never routed; without that exclusion a
  `**` rule would swallow the bridge's replies and brick the session.
- Fix the CLI aborting with `STATUS_STACK_OVERFLOW` on Windows, where the 1 MiB
  main-thread stack could not build the clap command tree. Every invocation
  crashed there, including the Scoop binaries.

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
