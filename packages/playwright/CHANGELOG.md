# Changelog

## 0.4.1 — 2026-09-07

- Keep waiting for process-group disappearance when a zero-signal probe returns
  EPERM during macOS teardown; preserve errors from actual termination signals.
- Supersedes the blocked 0.4.0 release attempt and includes its changes below.

## 0.4.0 — 2026-09-07

- Known limitation: native keyboard rechecks still include unresolved failures.
  The review records implementation consensus, not a fully passing native suite.
  See `benchmarks/macos/REVIEW.md` in the repository for the verification record.

- Terminate owned process groups even when endpoint metadata becomes
  inaccessible during startup; retain and retry endpoint cleanup errors.

- **Breaking:** `window.press` defaults to trusted WebView-keyup completion.
  `{ completion: "native" }` confirms OS posting only for native shortcuts or
  navigation. `{ waitFor, timeoutMs }` adds an application postcondition held
  under the plugin's cross-connection keyboard lock, capped at ten seconds.
- Preserve crashes and log tails in `HasgardProcess.diagnostics()` and fixture
  failure attachments. A failed screenshot no longer masks the test error.
- Remove owned stale endpoints after normal teardown and worker death while
  preserving replacement files and live foreign sockets.
- Reject RPC errors in both positive and negated assertions; read once even
  when their timeout is zero.

- Watch JavaScript and declarations separately in development, avoiding tsup
  declaration generation that is incompatible with the installed TypeScript API.

- Reap managed macOS applications after a Playwright worker is SIGKILLed using an
  independent IPC supervisor. Share normal and orphan group cleanup, bound IPC
  output buffering, and verify both real native teardown and resistant children.
- Make fixture turn heights actually unequal and assert their rendered dimensions.

- Fix Unix process-group cleanup, restart after launch failures, concurrent stop,
  live socket preservation, connection-based readiness, and bounded diagnostics.
- Validate JSON-RPC envelopes against shared contract cases. Preserve explicit
  null results, reject missing results, and report uncorrelated server errors.
- Reject requests above the plugin's 1 MiB UTF-8 line limit before sending them.

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
