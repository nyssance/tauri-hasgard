# CEF backend

Opt-in backend for apps built on `tauri-runtime-cef`. The CLI, MCP server and Playwright fixture work unchanged; only the plugin registration differs.

## Setup

```toml
[dependencies]
tauri = { version = "3.0.0-alpha.6", features = ["unstable"] }
tauri-runtime-cef = { version = "3.0.0-alpha.7", features = ["unstable"] }
tauri-plugin-hasgard = { version = "0.8", features = ["cef"] }
```

```rust
let builder = tauri::Builder::default()
    .runtime(tauri_runtime_cef::Cef::default())
    .plugin(tauri_plugin_hasgard::init_cef());
```

Then bundle the Playwright executor, which performs click, hover, fill, type, check and select:

```sh
bun run --cwd packages/executor build
```

Add the generated binary as a Tauri `externalBin`, as `examples/cef-fixture-app` does. The app then carries `hasgard-playwright` (`.exe` on Windows) beside its executable; users install neither Node nor Bun. During development `TAURI_HASGARD_PLAYWRIGHT` may point at an absolute executor path. A missing executor is an error; there is no synthetic-click fallback.

Notes:

- No remote debugging port is needed or opened. The plugin observes CDP in process.
- Remote pages need neither `hasgard:default` nor Tauri IPC access.
- `init_cef()` works in debug and release builds and moves a window only on a `window.*` request.
- A host that already ships a JavaScript runtime and Playwright can supply its own executor with `init_cef_with_executor`; see the [executor](../packages/executor/README.md).

## Targeting webviews

`windows` lists every page label, native child webviews included. Each entry has `window_label`, the native host label, and on macOS `native_id`, its OS window number. A parent and a child can share a native ID and still have different labels.

```sh
tauri-hasgard windows
tauri-hasgard --window guest snapshot
tauri-hasgard --window guest fill '#search' 'query'
tauri-hasgard --window guest screenshot-native --output /tmp/guest.png
```

A request to a closed label fails. Recreating a view under the same label starts a fresh session.

## What works

| Operation                                  | Behavior on CEF                                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| snapshot, query, text, html, attrs, `eval` | Run in an isolated world: same DOM, none of the page's JavaScript globals or Tauri objects.                                  |
| click, hover, fill, type, check, select    | Real browser input through Playwright with actionability checks. A covered element fails where Wry's DOM event would pass.   |
| press                                      | Native keyboard input to the selected webview. `TAURI_HASGARD_PRESS=window` is rejected.                                     |
| navigate                                   | Supported. An evaluation already submitted is never redirected into the new document.                                        |
| `ipc`                                      | Calls the page's own Tauri bridge in its main world. Capability checks apply; a page without the bridge fails.               |
| logs                                       | Main-world console, including output from before the first request. Objects are one level deep.                             |
| network                                    | Completed `fetch` and `XMLHttpRequest` exchanges, from the first request to that webview onward.                             |
| route                                      | `fetch` and `XMLHttpRequest` only, with the Wry rule semantics. Tauri IPC is never routed.                                   |
| screenshot                                 | Compositor pixels through `Page.captureScreenshot`.                                                                          |
| screenshot-native                          | macOS only. See [Screenshots](#screenshots-and-occlusion).                                                                   |
| cookies, window, clipboard, wait for a URL | Supported. A cookie can be set only for the host of the page the webview is showing. |
| native-dialog (the dialog plugin's open, save, message) | Answered in the page's main world, as on Wry. The policy holds across navigation. |
| dialog (`alert`, `confirm`, `prompt`)      | Not implemented; returns an error. HTML dialogs are ordinary DOM and work.                                                   |
| heap-snapshot | V8's `.heapsnapshot` of the selected webview, through the DevTools protocol. |
| CEF-owned popups without a Tauri label     | Not routed.                                                                                                                  |

Selectors pierce open shadow roots, and frame selectors reach cross-origin documents. Snapshot refs keep the frame limits documented in the [protocol](protocol.md). The same method name does not imply the same input fidelity on Wry.

### Console

Same entry shape, levels (`log`, `info`, `warn`, `error`), filters and 500-entry bound as Wry. Nested values, and every object in output that predates the first request, are reported by description (for example `"Object"`). Entries survive navigation until cleared. Each webview has its own log.

### Network

Same entry shape, filters and 200-entry bound as Wry. A request whose response headers arrived keeps that status even if the body is then aborted; `status: 0` with an `error` means no response was received. `response_size` is `Content-Length`, or the transferred size when the header is absent. A Tauri page's own IPC calls are real requests to `ipc.localhost` and appear in its log.

### Routes

Anchored globs, optional method, `fulfill` or `abort`, `times`, first match wins. Interception is enabled only while a webview has rules; documents and assets load untouched. A fulfilled response carries `Access-Control-Allow-Origin: *`. A cross-origin request that needs a CORS preflight sends its `OPTIONS` request first; match it with its own rule or it reaches the network. Rules survive navigation.

## Screenshots and occlusion

On macOS, `screenshot-native` without `--window-id` captures the selected CEF viewport and reports `backend: "cef-cdp"`. Pass an OS window ID from `windows` to capture the whole native window, including an always-on-top or floating one.

A viewport screenshot is **not evidence of visibility on screen**. A host HTML modal can appear in its page screenshot while a native child covers it in the whole-window image. Use both captures for overlap tests.

Native screenshots of CEF are macOS only for now.

## Native test

From `examples/cef-fixture-app`, build with a Tauri 3 CLI:

```sh
tauri build --debug --bundles app
```

From the repository root:

```sh
TAURI_HASGARD_DISPLAY=secondary bun scripts/test-cef.mjs
```

The fixture explicitly uses `SecretStorage::Mock` with a fresh temporary profile,
containing only local test data, so it never requests the macOS "Chromium Safe
Storage" keychain item. `tauri build --debug` still enables `custom-protocol`;
CEF's `SecretStorage::Auto` uses `tauri::is_dev()`, not Rust's debug assertions,
and would request the system keychain in that build. Do not copy this mock
storage choice into production apps holding real cookies or passwords.

The macOS harness requires Python 3 with Pillow for pixel assertions. An optional first
argument selects the built executable; `HASGARD_CEF_OUTPUT` selects the artifact
directory. It starts its own local HTTP server for a remote guest with no Tauri
permissions and uses a fresh CEF profile for each run. It starts hidden windows
on the secondary display, waits for the host before creating the child, tests routing,
unequal document heights, real IPC and permission rejection, DOM operations, native keys, navigation and child
recreation, then compares host/guest/whole-window screenshots. It stops its process
group and removes its own temporary socket and profile directory on completion. CI may
explicitly select display `0`; local runs must not silently use the primary.

When validating a custom SDK, `HASGARD_CEF_API_VERSION` explicitly selects its
matching API version in the fixture. Leave it unset for the standard bindings.
The native suite also requires a graceful exit with code 0; forced process cleanup
is only a failure-path safeguard.
