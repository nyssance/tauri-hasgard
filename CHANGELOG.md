# 0.8.3 (2026-11-24)

- `wait` and `watch` reject a `timeout` that is not a whole number instead of using the default.
- A recording exported as CLI commands names the field an entry lacks instead of emitting a command without it, and a multiple selection exports every value.
- The CEF native suite covers downloads, Tauri events, and frame screenshots and diffs.

# 0.8.2 (2026-11-24)

- Add downloads: `downloads.wait`, `downloads.list`, `downloads.setDirectory` and `downloads.clear`. The application passes `tauri_plugin_hasgard::downloads::observer()` to `on_download`, or wraps its own handler with `downloads::observe`. CLI `downloads`, the MCP `downloads` tool, and Playwright `hasgard.waitForDownload` and `hasgard.downloads`.
- Wry: console and network logs follow a flow to the next document of the same origin, as they do on CEF. They are written to session storage as a document is left and taken out by the one that replaces it.
- Recording now includes `wheel`, `setInputFiles`, the dialog and native dialog policies, routes, `storage.set` and `storage.clear`, cookies, window size and position, and emitted events, and replay runs them. Shell export covers those a single command can express.
- Add Tauri events: `event.emit` delivers an event to the application as its backend would, and `event.listen`, `event.list`, `event.unlisten` and `event.clear` record the events it emits. CLI `event`, the MCP `event` tool, and Playwright `hasgard.emit`, `hasgard.events` and `hasgard.waitForEvent`.
- Add `visible`, `checked` and `count` to the CLI and as MCP tools: answers, where the `assert_*` forms fail. `scroll` takes `--target` (CLI) or `target` (MCP) as well as a ref.
- `select` takes several values for a `<select multiple>`: `values` in the protocol and MCP, repeated values in the CLI, an array in Playwright `selectOption`. An empty list clears the selection.
- Playwright `locator.waitFor` accepts `visible` and `hidden` as well as `attached` and `detached`.
- TOML scenarios gain `hover`, `dblclick`, `focus`, `blur`, `drag`, `set-input-files`, `wheel`, `dialog`, `native-dialog`, `route` and `ipc`, and `select` with `values`.
- Native dialog answers work on CEF as well as Wry. The answering code is one self-contained script that runs in the page's own world on both backends; on CEF it is injected into the main world and registered for later documents. The native dialog policy holds across navigation on both.
- Wry: routes, the dialog policy and the native dialog policy hold across a navigation to another document of the same origin, as they already did on CEF. A counted route stays spent. They are handed over through the tab's session storage, in one entry that exists only while a rule or a non-default policy does and that Hasgard's own `storage.*` operations do not show.
- A `timeout` or `sinceId` of the wrong type is rejected by `downloads.wait`, `event.list` and the location `wait` instead of being replaced by the default. The CLI and scenario runner refuse a screenshot result that is not a PNG data URL.
- `screenshot` and `diff` take `frame`: a frame's document, or one element in it, is captured on its own, and a frame keeps a diff baseline apart from its page. CLI `--frame`, the MCP `screenshot` and `diff` tools, and Playwright `frameLocator(...).screenshot()` and `.diff()`.
- The frame scope reaches the operations that ignored it. In the bridge, an untargeted `scroll` or `wheel`, `html` without a target, and both ends of a `drag` (and its drop point for an offset) now use the frame's document. The MCP tools `text`, `html`, `value`, `attrs`, `focus`, `blur`, `disabled`, `bounding_box`, `scroll`, `wheel`, `drag`, `wait` and the `assert_*` tools accept and advertise `frame`.

# 0.8.1 (2026-11-24)

- Add answers for native dialogs: `nativeDialog.handle`, `nativeDialog.list` and `nativeDialog.clear` answer the dialog plugin's open, save and message commands in advance and record them; nothing else in the application's IPC is intercepted. The default, `manual`, leaves the system dialog on screen. CLI `native-dialog`, the MCP `native_dialog` tool, and Playwright `window.nativeDialogs`. Wry only.

# 0.8.0 (2026-11-24)

- Fix a ref that could not be used: once the ref table passed 1,024 entries, a node swept as detached and later re-attached was handed its old ref, which the table no longer knew.
- Fix request ordering for a request that names no window. It targets `main` and now waits in `main`'s lane; before, it could run alongside a request sent to `main` explicitly.
- CEF: implement `heap.snapshot`. It writes V8's `.heapsnapshot` of the selected webview through the DevTools protocol.
- CEF installs the automation bridge once per document instead of sending its 90 KB of source with every call.
- File uploads are no longer bound by the request limit. `drop` and `setInputFiles` accept a file as `{ name, path }`, which the application reads itself (up to 64 MiB per call); the CLI, the MCP server and the Playwright client send small files inline as before and switch to paths when the data would not fit in one request.
- Add system clipboard text: `clipboard.read` and `clipboard.write`. CLI `clipboard`, the MCP `clipboard` tool, and Playwright `hasgard.clipboardText()` and `setClipboardText()`.
- Add cookie store access: `cookies.get`, `cookies.set` and `cookies.clear`, `HttpOnly` cookies included, on Wry and CEF. CLI `cookies`, the MCP `cookies` tool, and Playwright `cookies`, `setCookie` and `clearCookies`.
- Add native window control: `window.state`, `window.resize`, `window.move`, `window.minimize`, `window.maximize`, `window.restore` and `window.close`, on Wry and CEF. CLI `window`, the MCP `window` tool, and Playwright `nativeState`, `setSize`, `setPosition`, `minimize`, `maximize`, `restore` and `close`.
- Add a location wait: `wait` takes `url` (glob or pattern) and `load`, and holds across the navigation that reaches them. CLI `wait --url` and `--load`, the MCP `wait` tool, and Playwright `waitForURL` and `waitForLoadState`.
- Windows: a pipe named through `TAURI_HASGARD_SOCKET` without the `tauri-hasgard-` prefix accepted one connection and then moved to `\\.\pipe\tauri-hasgard-unknown`, so every later client failed to connect. The server keeps the name it was bound to.
- The CEF native test uses the Playwright package's launch, endpoint and transport, runs under Bun, and covers Windows as well as macOS. On Windows it checks page screenshots; whole-window occlusion stays macOS only.
- `HasgardProcess.diagnostics()` reports the application's pid and exit on Windows.
- CI runs clippy and the format check.
- Release validation checks the committed versions against the tag instead of rewriting them, and runs the unit suites. Native E2E is a manual workflow.

# 0.7.3 (2026-11-23)

- Requests on one connection are pipelined: a response is written when its request finishes, matched by `id`. Requests for the same window keep their arrival order; other windows and the observers `wait` and `watch` run alongside. A pending `watch` no longer holds later requests until it times out.
- A ref whose element left the document fails with `Stale ref` instead of acting on the detached node and reporting success; `wait` with `gone` on a ref now resolves. A node keeps one ref across repeated queries, and detached nodes are swept from the ref table.
- Add the `role` dimension to `query` (`value` is the role; optional `name` is a string or `{ source, flags }`). Playwright `getByRole` uses it, so it no longer takes a full snapshot per action, resets other refs, or overwrites the `diff` baseline.
- Text queries walk the document once instead of comparing every match pairwise. A frame-scoped `wait` observes the frame's own document.
- Wry on Windows: `screenshot` takes composited pixels through WebView2's `Page.captureScreenshot`, like CEF. `press` confirms the target is the foreground window and fails if Windows refuses the activation, instead of sleeping 80 ms and typing into whichever window had focus; consecutive presses into one window no longer wait.
- `screenshot_native` and `video.*` off macOS return `-32601`, the code every unsupported method uses (`screenshot_native` carries `UNSUPPORTED_PLATFORM`).
- MCP `screenshot` returns image content instead of a base64 data URL in text.
- File uploads state their real limit: one request carries about 750 KB of file data. The 50 MB and 100 MB constants that could never be reached are replaced by `MAX_FILE_PAYLOAD_BYTES`.
- Replay runs `hover`, `focus`, `blur` and `dblclick` instead of skipping them, and rejects an entry without `action` or `timestamp`. CLI `scroll --ref` accepts `@e3` as well as `e3`.
- Playwright: add `toBeHidden`, `toBeEnabled`, `toBeDisabled`, `toBeChecked`, `toContainText`, `toHaveValue`, `toHaveAttribute` and `toHaveCount`; assertions re-read after 10, 20, then 50 ms instead of a fixed 50 ms.
- `SECURITY.md` no longer claims the plugin is inert in release builds.

# 0.7.0 (2026-11-19)

- Add the `tauri-hasgard-mcp` crate: the Hasgard tools as an `rmcp` `ServerHandler`, reaching the application through the plugin's endpoint (`HasgardMcpServer::endpoint`) or a host-supplied function (`HasgardMcpServer::in_process`). `tauri-hasgard mcp` is now this library over stdio; its tools and behavior are unchanged.
- Add the plugin's `mcp` feature with `Automation::mcp_server`, which serves the tools from inside the application with no endpoint and no CLI. The server attaches to an ACP session through the official `agent-client-protocol-rmcp` bridge (MCP over ACP, a draft), verified by an end-to-end test.
- Publish the CLI to npm as `tauri-hasgard` with prebuilt binaries for macOS Apple Silicon, Windows x64 and Linux x64, so an MCP client is connected with one command: `npx -y tauri-hasgard mcp`.
- `HasgardMcpServer::with_dangerous_tools` sets the `eval`, `ipc` and `drop` gate per server; the environment variable remains the default.
- List the server in the official MCP Registry as `io.github.nyssance/tauri-hasgard`.
- Docs: add the MCP guide (`docs/mcp.md`).

# 0.6.10 (2026-11-19)

- CEF: implement `console.getLogs` and `console.clear` from CDP console events, including output written before the first automation request. Object arguments are shallow; see `docs/cef.md`.
- CEF: implement `network.getRequests` and `network.clear` from the CDP Network domain for `fetch` and `XMLHttpRequest`.
- CEF: implement `route.add`, `route.list` and `route.clear` through the CDP Fetch domain with the Wry rule semantics.
- Docs: rewrite the README, walkthrough, CEF guide and protocol reference. The README leads with the MCP setup for Claude Code and Codex; the protocol reference lists every method, error code and environment variable; MCP tool naming and the `TAURI_HASGARD_MCP_ENABLE_DANGEROUS_TOOLS` gate are documented. Troubleshooting no longer claims release builds disable the plugin.
- Versions are aligned again: 0.6.9 was published for the plugin crate only.
- CI: build the Playwright executor before Rust tests, and poll click results in the CEF native test.

# 0.6.8 (2026-11-15)

- CEF: `ipc` runs through the page's own Tauri bridge in the top frame's main world and returns real command results; other automation stays in the isolated world.
- CEF: `screenshot` takes its pixels from the compositor through `Page.captureScreenshot`, so cross-origin images, embedded content and effects appear as on screen, for the document and for one element alike. Other runtimes keep redrawing the document in the page.
- Capture a page that holds an image it cannot read back, such as a cross-origin image without CORS; the image is drawn empty instead of failing the whole capture.
- Update `download-cef` to 3.0.1; 3.0.0 fails to build because the CEF index exceeds its response limit.

# 0.6.7 (2026-11-13)

- Add `TAURI_HASGARD_PRESS=window` for macOS Wry: `press` hands its key events to the target window through `AppKit`'s own key-equivalent and responder dispatch instead of posting them to the system input layer. The application is not activated, so a native run neither steals keyboard focus from the developer nor fails with `failed to focus target window` when another application takes the foreground. Menu shortcuts, trusted DOM key events, modifier pairs and text input into the requested window keep working; system-wide shortcuts are not triggered in this mode. The default (`system`) is unchanged, an unknown value is an error, and CEF rejects `window`.

# 0.6.6 (2026-11-09)

- Include the Windows icon required to compile the CEF fixture. Gate publication on Windows all-features Rust validation in addition to the existing native and macOS checks.
- Complete the CEF release across distribution channels after the interrupted 0.6.5 publication.

# 0.6.5 (2026-11-09)

- Add opt-in CEF automation with `init_cef()`: route native child webviews, evaluate DOM operations through an isolated CDP world, deliver native keys, and capture CEF viewport pixels. Keep the existing CLI/MCP protocol.
- Include `window_label` in webview listings to distinguish the page routing identity from its native host. Whole-window screenshots remain separate from viewport screenshots.
- Add a native CEF fixture covering multiple windows, remote pages without IPC grants, navigation, child recreation, keyboard input and modal occlusion.

# 0.6.4 (2026-11-02)

- Add `heap.snapshot` (CLI `heap-snapshot --output`, MCP `heap_snapshot`, Playwright `window.heapSnapshot(path)`): writes a JavaScript heap snapshot of the target webview after a full collection, and reports its `format`. macOS connects WebKit's in-process inspector (`_WKInspector`, no window) and asks its heap agent, giving JavaScriptCore's inspector JSON (`jsc`); the inspector is detached again afterwards. Windows uses WebView2's DevTools protocol `HeapProfiler.takeHeapSnapshot`, giving a V8 `.heapsnapshot` (`v8`). Debug builds only, like the rest of the plugin.

# 0.6.3 (2026-11-01)

- Fix native keyboard completion when WebKit delivers a trusted keyup before its keydown. Completion still requires paired trusted events for the main key and modifiers.
- Preserve window labels in native screenshot requests through both the Playwright client and plugin dispatcher; secondary-window captures no longer target the main window.
- Restyle the fixture with shared lightweight CSS and compact toolbars. Local fixture windows now start hidden and open on the secondary display by default; a missing display is an error. CI explicitly selects display 0.
- Add concise setup, Playwright, and troubleshooting tutorials; align formatting with alwith-desktop and simplify stable Rust dependency requirements.

# 0.6.2 (2026-10-28)

- Add `TAURI_HASGARD_DISPLAY` (`secondary`, a display index, or a display name) to place every new window on one display: the plugin moves it by that display's own scale factor, shrinks it to fit, and shows it, so automated runs stay off the developer's main screen. Applications that create their windows hidden in test builds never flash on the primary display.

# 0.6.1 (2026-10-27)

First stable release of the Tauri 3 Wry line; the 0.6.0 alphas are superseded.

- Wire the `WKWebView` `takeSnapshot:` backend and make it the default for `screenshot_native` when no `window_id` is given: WebKit renders the target webview's own pixels, so scrolled containers and virtualized lists capture as shown and no screen-recording permission is involved (`backend: "wkwebview"`, `tcc_denied: false`). An explicit `window_id` keeps the `screencapture`/`CGWindowList` window capture. The CLI retries with a resolved window id against plugins older than this release.
- Document that the DOM `screenshot` rasterises scrolled content at offset zero and point to `screenshot_native` for rendered pixels.

# 0.6.0-alpha.5 (2026-10-26)

- Build CLI release binaries with fat LTO, one codegen unit, stripped symbols, and abort-on-panic; the macOS Apple Silicon binary shrinks from 7.0 MB to 3.0 MB.
- Declare `rust-version = "1.95"` for every crate to match Tauri 3, exclude bridge unit tests from the published plugin crate, and fix the rustdoc warning in the CLI `select` help text.
- Stop shipping test declaration files in the npm package and require Node 24 or later.
- Clear every `bun lint` warning and fail CI on new ones; type the MCP stdio E2E client and attach `cause` to launch-cleanup and top-level-await errors.
- Run native E2E and release builds on macOS 26 and Ubuntu 26.04 runners, pass `--locked` and `--frozen-lockfile` in every CI job, and group Dependabot updates per ecosystem.
- Point the fixture Tauri config schema at 3.0.0-alpha.5 and drop TypeScript options that TypeScript 7 already implies.

# 0.6.0-alpha.4 (2026-10-26)

- Supersede the unpublished alpha.3 release attempt with its dependency and tooling updates.
- Use an uncatchable signal in the JavaScript process diagnostics test so runtime crash handlers do not delay exit reporting. Native Tauri SIGTRAP coverage remains unchanged.

# 0.6.0-alpha.3 (2026-10-26)

- Update Tauri/Wry to 3.0.0-alpha.5 and refresh Rust and JavaScript dependencies.
- Modernize the handwritten WebView bridge and include it in lint and formatting checks.
- Cover asynchronous evaluation, trailing comments, statement completion, and one-time execution of runtime errors.
- Build the Playwright package with Bun instead of tsup/Rollup.
- Replace Biome/Prettier with Bun tooling and add ts7-lint checks.
- Add `fab u` to update dependencies across the workspace.

# 0.6.0-alpha.2 (2026-09-28)

- Migrate the plugin and native fixture to Tauri 3 with explicit Wry runtime initialization.
- Use Wry extension APIs for native WKWebView and WebView2 keyboard focus.
- Preserve the existing JSON-RPC contract across the CLI, MCP server and Playwright fixture.
- Target ESNext and Bun 1.4.2.

# Changelog

All notable changes to this project are documented here. Versions follow
[Semantic Versioning](https://semver.org/); while the project is `0.x`, a minor
bump may carry breaking changes.

The three published artifacts — `tauri-plugin-hasgard`, `tauri-hasgard-cli`, and
`@nyssance/tauri-hasgard` — share one version.

## [0.5.0] — 2026-09-19

- Bind queued automation and callbacks to an ACL-authorized window origin;
  reject cross-origin navigation before it changes the page.
- Add native macOS window MP4 recording across RPC, CLI, MCP, and the test client,
  with bounded capture/encoding, atomic publication, and child cleanup.
- Expose the shared TOML runner through MCP; add storage-get assertions and
  reject missing values and malformed assertion results.
- Focus the native WebView before DOM focus; fix the Windows fixture URL
  expectation and require Windows native E2E to pass.
- Keep repeated radio selection checked, reject non-checkable targets and radio
  uncheck, and emit input/change events only when checked state changes.
- Clean up Unix socket paths using filesystem identity; preserve replacement
  sockets and avoid changing the application's process-wide umask.
- Reject record.stop without an active recording through the shared RPC protocol.
- Preserve recorded window scope in JSON replay and shell exports.

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
