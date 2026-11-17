# CEF backend

CEF support is opt-in. It uses the same CLI, MCP and Playwright JSON-RPC protocol
as Wry. `init()` remains the Wry entry point; use `init_cef()` for an app using
Tauri's default `DynRuntime` and CEF.

```toml
[dependencies]
tauri = { version = "3.0.0-alpha.6", features = ["unstable"] }
tauri-runtime-cef = { version = "3.0.0-alpha.7", features = ["unstable"] }
tauri-plugin-hasgard = { version = "0.6.8", features = ["cef"] }
```

```rust
let builder = tauri::Builder::default()
    .runtime(tauri_runtime_cef::Cef::default())
    .plugin(tauri_plugin_hasgard::init_cef());
```

Keep the application's usual CEF entry point and bundling setup. Do not enable a
remote debugging port for Hasgard. CEF uses an in-process CDP observer; external
pages need neither `hasgard:default` nor permission to invoke Tauri commands.
`init_cef()` works in both debug and release builds and does not move application windows.

CEF interactions require the packaged Playwright executor. Build it with
`bun run --cwd packages/executor build` and include the generated native binary
as a Tauri `externalBin`, as in `examples/cef-fixture-app`. The resulting app
contains `hasgard-playwright` beside its executable (`.exe` on Windows); users
do not install Node or Bun. For local development, `TAURI_HASGARD_PLAYWRIGHT`
may name an absolute executor path. Missing or failed executors return an error,
never a synthetic-click fallback.

The shared [executor](../packages/executor/README.md) can also be used by a
release application through `init_cef_with_executor`; its code selects
whether the local transport is enabled. It neither starts a second browser nor creates another login profile.

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

Click, double-click, hover, fill, type, check and select use Playwright over the
selected webview's CDP stream. They perform browser input with actionability
checks, including visibility, stability and hit testing. A covered target can
therefore fail where Wry's synthetic DOM interaction succeeds. CEF selectors can
pierce open shadow roots and frame selectors can reach cross-origin documents;
the existing snapshot/ref reader still has its documented frame limits. Do not
infer equivalent input fidelity or capabilities on WKWebView from the shared
method names. Native window focus, keyboard shortcuts and IPC remain native.

`ipc` executes in the selected webview's top-level main world and calls its
existing Tauri invoke bridge. It preserves command results, rejections and Tauri
capability enforcement. Pages without that bridge fail explicitly; Hasgard does
not grant remote guests native command access. IPC never installs the automation
bridge in the main world or falls back to another window after navigation.

This backend explicitly rejects heap snapshots, console/network
observation, network routing and JavaScript dialog interception. Those operations
need additional main-world/CDP integration; returning isolated-world empty logs
would be misleading. HTML dialogs are ordinary DOM and can be inspected.
CEF-owned popups without Tauri webview labels are not currently routed.

## Screenshots and occlusion

On macOS, `screenshot-native` without `--window-id` captures the selected CEF
viewport via `Page.captureScreenshot` and reports `backend: "cef-cdp"`. Supply
an OS window ID from `windows` to capture the entire native window instead,
including an always-on-top or floating window.

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
unequal document heights, real IPC and permission rejection, DOM operations, native keys, navigation and child
recreation, then compares host/guest/whole-window screenshots. It stops its process
group and removes its own temporary socket and profile directory on completion. CI may
explicitly select display `0`; local runs must not silently use the primary.

When validating a custom SDK, `HASGARD_CEF_API_VERSION` explicitly selects its
matching API version in the fixture. Leave it unset for the standard bindings.
The native suite also requires a graceful exit with code 0; forced process cleanup
is only a failure-path safeguard.
