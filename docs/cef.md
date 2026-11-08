# CEF backend

CEF support is opt-in. It uses the same CLI, MCP and Playwright JSON-RPC protocol
as Wry. `init()` remains the Wry entry point; use `init_cef()` for an app using
Tauri's default `DynRuntime` and CEF.

```toml
[dependencies]
tauri = { version = "3.0.0-alpha.6", features = ["unstable"] }
tauri-runtime-cef = { version = "3.0.0-alpha.7", features = ["unstable"] }
tauri-plugin-hasgard = { version = "0.6.6", features = ["cef"] }
```

```rust
let builder = tauri::Builder::default()
    .runtime(tauri_runtime_cef::Cef::default())
    .plugin(tauri_plugin_hasgard::init_cef());
```

Keep the application's usual CEF entry point and bundling setup. Do not enable a
remote debugging port for Hasgard. CEF uses an in-process CDP observer; external
pages need neither `hasgard:default` nor permission to invoke Tauri commands.
The plugin stays inert in release builds.

## Routing and results

`windows` lists page routing labels, including native child webviews. Each entry
has `window_label`, the native host label, and on macOS `native_id`, its OS window
number. A parent and child may share a native ID but have different routing labels.

```sh
tauri-hasgard windows
tauri-hasgard --window guest snapshot
tauri-hasgard --window guest fill '#search' 'query'
tauri-hasgard --window guest screenshot-native --output /tmp/guest.png
```

DOM reads, selectors, click/fill/type, navigation and native keyboard input use the
selected webview. The DOM bridge runs in a CDP isolated world: `eval` shares the
DOM but does not expose the application's main-world JavaScript globals or Tauri
IPC objects. It is not a complete Playwright `Page`. Requests use CEF's shared
message-ID allocator and a unique execution-context ID; navigation cannot redirect
an already submitted evaluation into another renderer context. A new request can
attach to the next document. Recreating a view with the same label creates a fresh
CDP session. A request to a closed label fails explicitly.

This initial backend explicitly rejects `ipc`, heap snapshots, console/network
observation, network routing and JavaScript dialog interception. Those operations
need additional main-world/CDP integration; returning isolated-world empty logs
would be misleading. HTML dialogs are ordinary DOM and can be inspected.
CEF-owned popups without Tauri webview labels are not currently routed.

## Screenshots and occlusion

On macOS, `screenshot-native` without `--window-id` captures the selected CEF
viewport via `Page.captureScreenshot` and reports `backend: "cef-cdp"`. Supply
an OS window ID from `windows` to capture the entire native window instead.

A viewport screenshot is **not evidence of visibility on screen**. A host HTML
modal can appear in its page screenshot while a native child covers it in the
whole-window image. Use both captures for overlap tests. SurfaceEmbed is not
implemented by this backend and is not needed for CDP automation.

The existing native screenshot platform restriction remains: this first
implementation captures viewport and whole-window images on macOS. Windows native
CEF validation is still required; no Linux native E2E is added.

## Native test

From `examples/cef-fixture-app`, build with a Tauri 3 CLI:

```sh
tauri build --debug --bundles app
```

From the repository root:

```sh
TAURI_HASGARD_DISPLAY=secondary node scripts/test-cef.mjs
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
unequal document heights, DOM operations, native keys, navigation and child
recreation, then compares host/guest/whole-window screenshots. It stops its process
group and removes its own temporary socket and profile directory on completion. CI may
explicitly select display `0`; local runs must not silently use the primary.
