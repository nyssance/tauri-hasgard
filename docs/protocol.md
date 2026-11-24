# Protocol reference

Every Hasgard client speaks the same JSON-RPC 2.0 to the plugin. Use this page to write a client, or to look up the exact behavior of a method.

```json
{"jsonrpc":"2.0","id":1,"method":"snapshot","params":{"window":"main","interactive":true}}
{"jsonrpc":"2.0","id":1,"result":{"elements":[]}}
```

## Envelope

- One UTF-8 JSON object per line, terminated by `\n`.
- IDs are nonnegative safe integers. Responses can arrive out of order; match them by ID.
- A connection is pipelined: send the next request without waiting for the previous response. Requests for the same `window` run one at a time in arrival order. Requests for different windows, and the observers `wait` and `watch`, run alongside them, so a pending `watch` sees the action sent after it. At most 64 requests are in flight per connection; the plugin stops reading past that.
- A response has exactly one of `result` or `error`. `result: null` is success; a missing result is a protocol error.
- A `null` ID marks an error that could not be tied to a request. Clients surface it and fail their pending calls.
- A request is at most **1,048,576 bytes** including the newline, base64 payloads included. Clients check the size before sending and fail locally, leaving the connection usable. Files for `setInputFiles` and `drop` can be named by path instead, which this limit does not bound.

Error codes:

| Code     | Meaning                                                    |
| -------- | ---------------------------------------------------------- |
| `-32601` | Unknown method, or one the active backend does not support |
| `-32602` | Invalid parameters                                         |
| `-32603` | The operation failed                                       |
| `-32002` | Webview not ready yet; retry until your deadline           |

The CLI with `--json` prints `{"error":{"code":...,"message":...,"data":...}}` and exits unsuccessfully. MCP tool failures keep their `error` text and carry the original code, message and data as `rpcError` in `structuredContent`.

## Endpoint

| Platform     | Transport   | Default                                   |
| ------------ | ----------- | ----------------------------------------- |
| macOS, Linux | Unix socket | Path derived from the Tauri app identifier |
| Windows      | Named pipe  | Name derived from the Tauri app identifier |

Environment variables:

| Variable                                   | Read by       | Effect                                                                                              |
| ------------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------- |
| `TAURI_HASGARD_SOCKET`                     | app, CLI, MCP | Endpoint path or pipe name. Set the same value on both sides.                                       |
| `TAURI_HASGARD_WINDOW`                     | CLI, MCP      | Default window label.                                                                               |
| `TAURI_HASGARD_PRESS`                      | app           | macOS Wry: `system` (default) or `window`. See [keyboard](#native-keyboard-completion).             |
| `TAURI_HASGARD_PLAYWRIGHT`                 | app           | CEF: absolute path of the Playwright executor during development.                                   |
| `TAURI_HASGARD_MCP_ENABLE_DANGEROUS_TOOLS` | MCP           | `1` exposes the `eval`, `ipc` and `drop` tools, which are hidden by default.                        |
| `TAURI_HASGARD_DISPLAY`                    | test fixtures | `secondary`, a display index from 0, or a display name. The plugin moves a window only on a `window.*` request. |

## Windows and targets

`params.window` is a Tauri webview label. A call without one targets `main`, and a missing `main` is an error. An explicit `window` must be a non-empty string; an invalid value never falls back to `main`. `params` must be an object.

An element target takes one of three forms:

| Target             | JSON                                   |
| ------------------ | -------------------------------------- |
| Snapshot reference | `{ "ref": "e12" }`                     |
| CSS selector       | `{ "selector": "[data-testid=save]" }` |
| Viewport point     | `{ "x": 120, "y": 80 }`                |

## Methods

| Area      | Methods                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------- |
| App       | `ping`, `windows.list`, `state`, `url`, `title`, `navigate`, `ipc`, `eval`                           |
| Read      | `snapshot`, `diff`, `query`, `filter`, `text`, `html`, `value`, `attrs`, `boundingBox`, `forms.dump` |
| State     | `visible`, `count`, `checked`, `disabled`                                                            |
| Act       | `click`, `dblclick`, `hover`, `focus`, `blur`, `fill`, `type`, `check`, `select`, `scroll`, `drag`   |
| Input     | `press`, `wheel`, `setInputFiles`, `drop`                                                            |
| Wait      | `wait`, `watch`                                                                                      |
| Window    | `window.state`, `window.resize`, `window.move`, `window.minimize`, `window.maximize`, `window.restore`, `window.close` |
| Capture   | `screenshot`, `screenshot_native`, `heap.snapshot`, `video.start`, `video.stop`, `video.status`      |
| Console   | `console.getLogs`, `console.clear`                                                                   |
| Network   | `network.getRequests`, `network.clear`, `route.add`, `route.list`, `route.clear`                     |
| Dialogs   | `dialog.list`, `dialog.handle`, `dialog.clear`                                                       |
| Storage   | `storage.get`, `storage.set`, `storage.list`, `storage.clear`                                        |
| Cookies   | `cookies.get`, `cookies.set`, `cookies.clear` |
| Clipboard | `clipboard.read`, `clipboard.write` |
| Recording | `record.start`, `record.add`, `record.stop`, `record.status`                                         |

Parameters match the CLI options; `tauri-hasgard <command> --help` documents each. `wait` and `watch` take integer timeouts from 0 through 2,147,483,647 ms.

`drop` and `setInputFiles` take `files`, each either `{ name, type?, data }` with base64 contents or `{ name?, type?, path }` with an absolute path the application reads itself. Inline data counts toward the request limit; paths do not, and one call reads at most 64 MiB.

`clipboard.read` answers `{ text }` with the system clipboard's text, or `null` when it holds none; `clipboard.write` takes `text`. The clipboard is shared with whoever uses the machine.

`cookies.*` use the webview's own cookie store, so `HttpOnly` cookies are included. `cookies.get` takes an optional `url` (the cookies a request to it would carry) and `name`. `cookies.set` takes `name`, `value` and either `domain` or `url` (which supplies the domain, the path `/` and `secure` for https), plus optional `path`, `expires` (seconds since the Unix epoch), `httpOnly`, `secure` and `sameSite` (`Strict`, `Lax`, `None`). `cookies.clear` deletes the cookies matching every one of `url`, `name` and `domain` given, or all of them, and answers `{ removed }`.

`window.*` act on the native window that holds the labelled webview. `window.state` reports `x`, `y`, `width`, `height` (logical pixels), `scaleFactor`, and `visible`, `focused`, `minimized`, `maximized`, `fullscreen`; `window.resize` takes `width` and `height`, `window.move` takes `x` and `y`, and each change answers with the state at reply time, which the window manager may still be applying.

`wait` takes an element (`selector` or `ref`, optionally `gone`), an `expression`, or a location: `url` (a glob string in which `*` stays within a path segment and `**` crosses them, or `{ source, flags }`) and `load` (`load` or `domcontentloaded`), alone or together. A location wait is held by the plugin and polls whichever document is current, so it survives the navigation that reaches the URL; it resolves with `{ found, url, readyState }`. CEF differences are listed in the [CEF guide](cef.md#what-works).

Platform support for capture:

| Method              | macOS                  | Windows                 | Linux                 |
| ------------------- | ---------------------- | ----------------------- | --------------------- |
| `screenshot`        | Document redrawn in the page | Composited pixels (WebView2) | Document redrawn in the page |
| `screenshot_native` | Yes                    | `-32601`                | `-32601`              |
| `heap.snapshot`     | Yes (`jsc`)            | Yes (`v8`)              | `-32601`              |
| `video.*`           | Yes                    | `-32601`                | `-32601`              |

A redrawn document cannot show cross-origin images, frames or native controls; composited pixels do. CEF takes composited pixels on every platform.

## Snapshot

```ts
interface SnapshotElement {
  ref: string
  role: string
  depth: number
  name?: string
  value?: string
  checked?: boolean
  disabled?: boolean
}
```

- Refs are valid until the next snapshot in that webview, or until their element leaves the document. A ref whose element was removed or replaced fails with `Stale ref`; it never acts on the detached node. `wait` with `gone` resolves for such a ref.
- `query` returns elements in the same shape without resetting refs. `by` is `text`, `label`, `placeholder`, `testid`, `alt`, `title`, `selector` or `role`. For `role`, `value` is the role and the optional `name` is a string (a case-sensitive substring, or equality with `exact`) or a `{ "source", "flags" }` pattern; it reports what a snapshot would report for that role.
- The Playwright client holds a per-window lock across `query → unique match → action`. Role locators query by role, require exactly one match, then send that ref.
- `diff` baselines are kept per window. Reference and returned snapshots must include their `elements` arrays.

## Native keyboard completion

`press` takes `key`, optional `completion`, optional `waitFor` and an optional `timeout` for `waitFor`.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "press",
  "params": { "window": "main", "key": "Tab", "waitFor": "document.activeElement.id === 'save'", "timeout": 1000 }
}
```

### Delivery

`system` (default). On macOS the plugin activates and reveals the target window, restores it if minimized, focuses the native webview, then posts OS keyboard events. A focus failure stops before anything is posted. A press is rejected if Shift, Control, Option or Command is physically held.

`window` (`TAURI_HASGARD_PRESS=window`, macOS Wry only). The events go straight to the target window on the main thread and the application is never activated, so a run neither takes keyboard focus from the person using the machine nor loses it to them.

- A Command or Control key-down is offered to the window's key equivalents, then the main menu, then the first responder, as `NSApplication` does.
- The window is made key among the application's own windows, so typed text lands there.
- Keys are looked up on the current keyboard layout; a character the layout cannot type is an error.
- System-wide shortcuts (`tauri-plugin-global-shortcut`) are not triggered.
- CEF rejects this mode.

Each modifier may appear once, aliases included (`Ctrl`/`Control`).

### Completion

| `completion`        | Confirms                                                              | Use for                                                    |
| ------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------- |
| `webview` (default) | A trusted `keyup` in the target document or its same-origin frames    | Ordinary keys and text                                     |
| `native`            | Only that the OS accepted the events                                  | Native menus, global shortcuts, keys that close a document |

With `webview`:

- Presses are serialized across connections until acknowledged, so the next press cannot switch windows mid-key.
- Only keyups paired with trusted keydowns seen after registration count, modifiers included, in either delivery order.
- Confirmation expires after 10 seconds. Navigation, a native menu or a closed document can prevent it; completion is never silently downgraded.

With `native`, application receipt is not confirmed and unfinished WebKit text edits are not protected. Bare modifier keys always use it. Observe the application result before switching windows.

### Postcondition

`waitFor` is a JavaScript expression evaluated in the target window after completion. The ordering lock is held until it is truthy or fails. `timeout` defaults to 10,000 ms, must be an integer from 0 through 10,000, and is invalid without `waitFor`. Use a separate `wait` for longer application work.

### Errors

| `data.phase`       | `data.injected` | Retry                                |
| ------------------ | --------------- | ------------------------------------ |
| `focus`, `prepare` | `false`         | Safe once the cause is fixed         |
| `injection`        | `"unknown"`     | Do not resend automatically          |
| `completion`       | `true`          | Do not resend; the key was delivered |
| `postcondition`    | `true`          | Do not resend; the key was delivered |

### Limits

Native keys follow the active keyboard layout and input method. A keyup does not commit an IME composition or wait for asynchronous application work; declare a `waitFor` when that matters, and use `fill` for exact text. Hasgard does not switch the system input source. Physical input from a person during a run is outside these guarantees.

## Origin binding

- Each webview completes an IPC handshake after the native page-load event, subject to the app's Tauri capabilities. Until then calls return `-32002`.
- A window accepts only its latest one-use handshake token. Navigation start and window destruction revoke it and fail pending evaluations.
- Every evaluation is bound to an unpredictable token, its window and its origin. The origin is rechecked inside the queued JavaScript, and callbacks after an origin change are rejected. Another window cannot consume the request, and an iframe cannot guess its token.
- Opaque origins are rejected. `navigate` allows same-origin destinations only.
- The eval callback must carry exactly one JSON-encoded result or error; anything else rejects the evaluation.

## Native video (macOS)

All clients use `video.start`, `video.stop`, and `video.status`, with the normal
optional `window` label. Start requires an absolute, nonexistent `output_path`
ending in `.mp4`. Optional `fps` is 1–10 (default 5); `max_duration_ms` is
100–60000 (default 60000). The native ID is resolved from the app's own window
listing; no desktop-wide capture or guessed window ID is used.

Recording requires Screen Recording permission and `ffmpeg` on PATH.
Start checks the encoder and captures the first frame before reporting success.
Stop returns `output_path`, `window_id`, `frames`, `duration_ms`, `byte_size`,
and `backend`. Status returns `active` and `pending_result`; call stop to
collect results even after automatic completion. An existing session must be
collected before another starts for that window.

Frames use the native macOS compositor through `screencapture`. Capture rate is
best effort; encoding uses measured frame durations. Resizing retains the first
frame's output dimensions with letterboxing. Audio is not recorded. Capture and
encoding failures reject; temporary frames are removed, children have deadlines
and are reaped, and the final MP4 is published atomically without overwriting an
existing destination. Publishing requires a filesystem supporting hard links;
an unsupported filesystem returns an error without a non-atomic fallback.
Application exit cancels and joins recording workers, including a concurrent stop.
Destroying a window cancels its recording before its native window ID can be reused.
Unsupported platforms return an explicit error.

## TOML scenarios through MCP

`hasgard.run_scenario` takes `toml` (required string), optional `window`, and
optional `fail_fast`. It runs the same implementation as CLI `run`, including
global/step deadlines and failure reporting. Failed steps set MCP `isError`.
The response includes step statuses and passed/failed/skipped counts.
MCP scenarios reject `[connect]`: the server's configured application remains
the target.

The `storage-get` step requires `key`; optional `session = true` selects session
storage and optional `expected` asserts exact equality. Missing keys fail.
An existing empty string is a valid value, including `expected = ""`.

The `focus` action also activates the native application window and its webview
before focusing the DOM element, so focus events work on an inactive window.

## Maintaining the protocol

`crates/tauri-plugin-hasgard/src/protocol.rs` is the canonical envelope definition and holds `MAX_REQUEST_BYTES`. `protocol/responses.json` holds response vectors exercised by the plugin, the CLI transport used by MCP, and the TypeScript parser. After changing either, run `bun run protocol:sync`; it copies the definition into the CLI crate and the vectors into both Rust crates so published crates build without sibling directories. `bun run protocol:check` rejects stale generated files in CI and before release.
