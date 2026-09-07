# Changelog

All notable changes to this project are documented here. Versions follow
[Semantic Versioning](https://semver.org/); while the project is `0.x`, a minor
bump may carry breaking changes.

The three published artifacts — `tauri-plugin-hasgard`, `tauri-hasgard-cli`, and
`@nyssance/tauri-hasgard` — share one version.

## [0.4.1] — 2026-09-07

- Keep waiting for process-group disappearance when a zero-signal probe returns
  EPERM during macOS teardown; preserve errors from actual termination signals.
- Supersedes the blocked 0.4.0 release attempt and includes its changes below.

## [0.4.0] — 2026-09-07

- Known limitation: native keyboard rechecks still include unresolved failures.
  The review records implementation consensus, not a fully passing native suite.
  See `benchmarks/macos/REVIEW.md` in the repository for the verification record.

- Keep routine native keyboard checks short; move the 600-pair foreground
  switching stress suite to the explicit `test:e2e:stress` command.
- Bound endpoint cleanup retries after the application group is gone. Permanent
  filesystem errors terminate the supervisor with an explicit failure, and
  `stop()` propagates it instead of silently reporting successful cleanup.

- Reject macOS injection before dispatch when modifiers remain held. Report
  pre-dispatch failures as `injected: false`, and cancel queued work atomically
  so a timeout cannot be followed by a late injection.

- Reject duplicate modifier aliases before native injection. Enforce the macOS
  main-thread requirement at the Enigo boundary so accidental worker-thread
  calls fail explicitly before reaching HIToolbox.

- Keep terminating owned process groups when endpoint metadata becomes
  inaccessible during startup; report and retry endpoint cleanup separately.

- Preserve plugin error code, message, and data through the Rust client. MCP
  tool errors now expose `rpcError`; CLI `--json` prints the structured plugin
  error while retaining a nonzero exit status. Real native CLI/MCP tests verify
  successful key delivery and postcondition failures without losing injection
  status.

- **Breaking:** native `press` now waits for a trusted WebView keyup by default.
  Cross-window presses share one ordering lock through completion. Use
  `--completion native` (MCP `completion`, Playwright `PressOptions.completion`)
  for OS shortcuts or navigation; it explicitly confirms posting only.
  Optional `waitFor` postconditions retain keyboard ownership for at most ten
  seconds. Errors identify the phase and whether injection occurred.
- Confirm AppKit activation and native WebView focus instead of assuming a
  fixed delay succeeded. Keep keyboard-layout access on the main thread.
- Preserve real crash signals and log tails in fixture failure diagnostics,
  and keep screenshot failures from replacing the original test failure.
- Remove owned stale socket files after process-group cleanup, including worker
  death. Confirm ownership before readiness returns and preserve replaced files
  or accepting endpoints belonging to another application.
- Reject invalid window and timeout parameters. Isolate snapshot baselines by
  window, reject missing snapshot arrays, and clean cancelled eval requests.
- Reject missing, conflicting, or malformed internal eval callback results
  instead of fabricating a successful null or accepting non-JSON data.
- Keep negated assertions from passing when an RPC fails. Zero-timeout
  assertions still perform one read.

- Exclude exterior window shadows from macOS native captures so screenshot
  dimensions and scale metadata match the window, verified on a real display.

- Reap managed macOS applications after a Playwright worker is SIGKILLed using an
  independent IPC supervisor. Share normal and orphan group cleanup, bound IPC
  output buffering, and verify both real native teardown and resistant children.
- Make fixture turn heights actually unequal and assert their rendered dimensions.

- Fix Unix fixture cleanup when a launcher exits before its children, startup
  fails, or an application ignores SIGTERM. Wait for the process group to exit,
  support repeated launches and concurrent cleanup, and bound startup logs.
- Refuse to unlink live application endpoints and require a real connection
  for readiness. Add native multi-window Tauri teardown tests for both successful
  and failed Playwright runs, plus real process lifecycle regression tests.
- Generate Rust envelopes from one source and check generated files in CI and
  release validation. Share response vectors across Rust and TypeScript.
- Reject malformed RPC envelopes, preserving explicit null results and surfacing
  uncorrelated server errors. Missing results are now errors rather than silent
  success. Enforce the existing 1 MiB request limit before sending in all clients.
- Load the native E2E configuration explicitly so its single-worker setting,
  timeouts, and HTML reporting apply to the normal test command.

## [0.3.0]

### Added

- `click` takes `modifiers`, `button`, `clickCount`, and `position`. Until now a
  click could only be an unmodified left press at the element centre, which put
  Shift-extended multi-select, right-click context menus, and anything that
  branches on `detail` out of reach entirely.

  The event stream follows the platform rather than being convenient: a right
  press raises `contextmenu` and a middle press raises `auxclick`, and **neither
  raises `click`**. An app that binds its context menu to `click` therefore fails
  here, which is the point — it is already broken for every real user.
  `clickCount: 2` escalates `detail` across the presses and ends in a single
  `dblclick`, so the two are distinguishable.

  Available on all four surfaces: `locator.click(options)`, the `click` MCP tool,
  and `tauri-hasgard click --modifier Shift --button right --click-count 2
--position 10,5`.

- `window.frameLocator(selector)` scopes locators to a same-origin `<iframe>`,
  and chains for nested frames. Everything inside a frame was previously
  unreachable: the bridge only ever queried the top document, so an embedded
  checkout, docs pane, or OAuth callback simply had no locator.

  Cross-origin frames stay out of reach and say so. The same-origin policy binds
  injected script exactly as it binds the page's own, so this is a wall rather
  than a gap -- and reporting it beats the alternative of falling back to the
  top document and answering "no element matches" for a page where the element
  plainly exists.

  On the CLI this is a global `--frame SELECTOR`, repeated per nesting level;
  MCP element tools take a `frame` array.

- `window.routes.{fulfill, abort, list, clear}` shape what the page's own
  `fetch` and `XMLHttpRequest` receive. Network activity could be observed but
  not changed, so the branches an app most needs tested -- offline, 500, empty --
  were reachable only by breaking the real backend.

  Rules are declarative rather than Playwright's per-request callback. The bridge
  only ever answers requests; it cannot call back into the test process and await
  a handler while the page sits inside `fetch`. The same constraint produced the
  standing dialog policy.

  Patterns are anchored globs where `*` stays inside a path segment and `**`
  crosses separators, matched in registration order with first match winning.
  `times` bounds how many requests a rule answers, which is what a retry test
  needs. Routed requests still appear in `networkRequests()`: the app did issue
  them and did get an answer, and a test asserting "the app called /api/user"
  must not go blind the moment that call is stubbed.

  Resources the webview loads itself -- the document, `<img src>`, stylesheets --
  are not covered, since no page script is involved in fetching them. Tauri's own
  IPC is excluded deliberately: eval results travel back through
  `__TAURI_INTERNALS__.invoke`, so without the exclusion a `**` rule would
  swallow the bridge's own replies and brick the session, including the call
  that would have removed the rule.

### Fixed

- The CLI aborted with `STATUS_STACK_OVERFLOW` on Windows. Building the clap
  command tree overflowed the 1 MiB stack Windows gives a process's main thread,
  against 8 MiB on Linux and macOS, so **every** invocation crashed there --
  including `--version`, and including the binaries published through Scoop. The
  parse now runs on a thread this process sizes itself, and Tokio's workers get
  the same size since command handlers build the same structures.

  Only CI's Windows runner can observe this; it cannot reproduce on a platform
  whose main stack was never close to the limit.

### Changed

- `dblclick` is now `click({ clickCount: 2 })` on every surface, one
  implementation instead of two. The previous version replayed the whole gesture
  twice, which reset `detail` to 1 on the second press and raised `dblclick`
  unconditionally — neither matches a real double click.

## [0.2.1]

Supersedes `v0.2.0`, which was tagged but published nothing: its release run
failed in the end-to-end gate before any registry job started, so no crate, npm
package, or GitHub Release for `0.2.0` exists.

### Fixed since the 0.2.0 tag

- Two end-to-end tests asserted behaviour that only holds on one platform:
  `resolves its own operating-system window id` expected a native id everywhere,
  though `native_window_id` returns `None` off macOS by design; and
  `moves focus in and out of a real input` depended on `#search` not already
  being focused, which an earlier test leaves it.

### Fixed

- **macOS: `press` of a plain character aborted the host application.** enigo's
  layout lookup reaches HIToolbox's `TSMGetInputSourceProperty`, which asserts it
  is on the main dispatch queue and raises `SIGTRAP` anywhere else — killing the
  process rather than returning an error. Injection now runs on the main thread.
  Named keys such as `Tab` carry fixed keycodes and never took that path, which
  is why the bug survived a release. The hop is confined to macOS: Windows'
  `SendInput` and the Linux X11/libei backends inject from any thread, and
  blocking the Linux main loop can deadlock `Enigo::new`'s portal handshake.
- **macOS: `windows.list` read `NSWindow.windowNumber` off the main thread.** The
  same class of unsafe AppKit access, in a spot that happens not to assert. The
  read now hops, bounded at 2s so a wedged main thread degrades the listing to
  "no id" rather than hanging it.
- `count()` and `waitFor()` on a filtered locator took a CSS fast path that
  ignored the filter, reporting the unfiltered count and waking on an excluded
  match.

### Added

- **Modal dialog handling.** `alert`, `confirm`, and `prompt` block the webview
  until answered; unanswered, the app freezes and every in-flight call dies on an
  unrelated timeout. The bridge now answers them — dismissing by default, as
  Playwright does — and records each one. This is a standing policy rather than a
  per-event handler because the answer must be produced synchronously inside the
  page's own call. `window.dialogs.{accept,dismiss,list,clear}`; CLI `dialog`.
- **`setInputFiles`.** Populates an `<input type="file">` without a native file
  chooser, which an embedded webview gives no way to drive. Rejects a non-file
  target, where the assignment would silently no-op, and rejects overfilling a
  single-file input, where the browser would keep only the last file. CLI
  `set-input-files`.
- **`wheel`.** Reproduces the browser's two steps — dispatch, then scroll only if
  the page did not cancel — and reports which happened. A synthetic `WheelEvent`
  alone fires listeners without moving the scrollport. CLI `wheel`.
- **`filter({ hasText, hasNotText })`.** Refines any locator kind. Filters
  compose and apply before `nth`, so `filter(...).first()` is the first
  _matching_ element.
- **`clear`.** Routed through `fill("")` in every surface so the two cannot drift
  on which events they fire. CLI `clear`.
- MCP tools for each of the above: `clear`, `dialog`, `set_input_files`, `wheel`.

### Changed

- CLI results of the form `{ok: true, …}` no longer discard their sibling
  fields — `wheel` reports whether the page cancelled and `set-input-files` how
  many files landed. `disabled` and `bounding-box` print as prose rather than raw
  JSON.
- `drop` and `set-input-files` share one file encoder, so the two cannot diverge
  on size limits or MIME guessing.

### Known issues

- The native-keyboard tests depend on the fixture window holding OS focus. One
  failure was observed in roughly eight full-suite runs, immediately after a
  rebuild, and could not be reproduced in twelve subsequent runs. Unresolved.
- Only macOS is verified on real hardware; Linux and Windows rely on CI, where
  the Windows end-to-end job is currently allowed to fail.

## [0.1.2] and earlier

Released before this file existed. See the Git history and the GitHub Releases
page.
