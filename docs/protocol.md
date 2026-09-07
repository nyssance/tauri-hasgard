# JSON-RPC protocol

Hasgard uses JSON-RPC 2.0 over a platform-native byte stream. Every request and response is one UTF-8 JSON object followed by `\n`.

```json
{"jsonrpc":"2.0","id":1,"method":"snapshot","params":{"window":"main","interactive":true}}
{"jsonrpc":"2.0","id":1,"result":{"elements":[]}}
```

Response IDs are authoritative: clients must support multiple in-flight requests and may not assume response order.

## Envelope contract and limits

`crates/tauri-plugin-hasgard/src/protocol.rs` is the canonical Rust envelope
definition, formatted normally by `cargo fmt`. Run `bun run protocol:sync` after
changing it or `protocol/responses.json`. The generator copies the definition
into the CLI crate and the response vectors into both Rust crates,
so published crates build and test without sibling workspace directories or a
new registry dependency. `bun run protocol:check` rejects stale generated files
in CI and before release.

`protocol/responses.json` exercises the same response cases in the plugin, the
CLI transport used by MCP, and the TypeScript parser and transport. Responses
must contain JSON-RPC version `2.0`, an ID, and exactly one of `result` or `error`.
Explicit `result: null` is successful; an absent result is a protocol error.
Hasgard uses nonnegative safe integer IDs. A null ID is reserved for errors that
cannot be correlated to a request; clients surface that error instead of hiding
it behind an ID mismatch. TypeScript rejects all pending calls for such errors.

The protocol module's `MAX_REQUEST_BYTES` defines a **1,048,576-byte request
limit**, including the trailing newline, and generates the TypeScript constant.
CLI, MCP, and TypeScript requests are checked after JSON and
UTF-8 encoding, before transmission. Base64 file payloads and other parameters
count toward the same limit. Oversized requests fail locally with the actual
and maximum byte counts, leaving the connection usable. This does not add
chunked file transfer or change the server's existing limit.

These checks cover envelopes and the transport limit. Method-specific parameter
and result contracts remain covered by their existing operation tests.
The internal Tauri eval callback also requires exactly one result or error;
its result must be JSON-encoded. Missing, conflicting, or malformed callback
data rejects the eval instead of becoming a successful null or raw string.

## Transport

- macOS/Linux: private Unix socket. A managed test supplies `TAURI_HASGARD_SOCKET`; otherwise the plugin derives a path from the Tauri application identifier.
- Windows: named pipe. A managed test supplies the full named-pipe path through the same environment variable.

## Window routing

`params.window` is a Tauri webview label. Public Playwright APIs always send it. Low-level CLI calls without one target `main`; a missing `main` is an error.

Supplied parameters must be an object. An explicit `window` must be a non-empty
string; invalid values never route to `main`. `wait` and `watch` accept integer
timeouts from 0 through 2,147,483,647 milliseconds, matching JavaScript timers.

## Native keyboard completion

`press` takes `key`, optional `completion`, optional `waitFor`, and an optional
postcondition `timeout`. On macOS it activates and reveals the target window,
restores it if minimized, and focuses the actual native WebView before posting
OS keyboard events. Focus failure stops the operation before injection.
Each modifier may occur only once, including aliases such as `Ctrl`/`Control`.
Duplicate modifiers are invalid parameters, preventing an unbounded sequence of
OS events from a single malformed gesture.

The default `completion: "webview"` observes a trusted `keyup` in the target
document or its accessible same-origin frames. The plugin serializes native
presses across connections through this acknowledgement, so its next press
cannot switch windows while WebKit is still processing the preceding key.
Only keyups paired with trusted keydowns observed after registration count;
late modifier releases from the preceding press cannot satisfy a new one.
Confirmation expires after 10 seconds. No synthetic DOM keyboard events are
used to satisfy it. Navigation, native menu interception, or a closed document
can prevent a DOM acknowledgement; they never silently downgrade completion.

Use `completion: "native"` for native menus, global shortcuts, or keys that
navigate or close the document. This explicitly confirms OS posting only,
not application receipt or completion. Bare modifier keys also use posting
completion because they have no text-producing keyup. Native completion does
not provide the default mode's protection against unfinished WebKit text edits.
In this mode `window` constrains focus before posting, not the eventual OS
dispatch target. Do not immediately switch windows after a window-specific
native action without observing its application result.

`waitFor` is a JavaScript expression evaluated in the target window after
completion. The same ordering lock is retained until it becomes truthy or
fails. Its timeout defaults to 10,000 ms and must be an integer from 0 through
10,000; `timeout` without `waitFor` is invalid. Use a separate `wait` for longer
application work that need not retain keyboard ownership.

Errors report their phase. A postcondition or WebView-completion failure has
`data: {phase: "postcondition" | "completion", injected: true}`. An injection
failure may have `injected: "unknown"` because some OS events may already have
been posted. Focus and observer-setup (`prepare`) failures report
`injected: false`. Do not automatically
retry a press after an uncertain or completed injection.

The Rust client preserves the complete RPC error. CLI commands with `--json`
emit `{"error":{"code":...,"message":...,"data":...}}` for plugin errors and
still exit unsuccessfully; human-readable diagnostics remain on stderr. MCP
tool failures retain their `error` text and include `rpcError` with the original
code, message, and optional data in `structuredContent`.

Native keys respect the active keyboard layout and input method. A keyup does
not commit an IME composition or acknowledge arbitrary asynchronous application
work; declare a suitable `waitFor` when that matters. Use `fill` for exact text.
Hasgard does not switch the user's system input source. Concurrent physical
user input is outside these ordering guarantees.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "press",
  "params": { "window": "main", "key": "Tab", "waitFor": "document.activeElement.id === 'save'", "timeout": 1000 }
}
```

## Snapshot

Snapshot elements contain:

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

Refs are valid until the next snapshot in that webview. The Playwright client therefore holds a per-window lock across `snapshot → unique match → action`; this sequence may not interleave with another semantic action in the same window.

Implicit `diff` baselines are stored separately per window. A snapshot of
`settings` never replaces `main`'s baseline. Reference and returned snapshots
must include their `elements` arrays; missing data is an error.

On macOS, a press is rejected before injection if Shift, Control, Option, or
Command remains held at dispatch time. Release modifiers before retrying an
`injected: false` failure. A failure after dispatch starts remains `injected: "unknown"`; the client must not automatically resend the gesture.
