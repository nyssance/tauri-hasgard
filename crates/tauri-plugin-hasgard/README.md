# tauri-plugin-hasgard

Tauri 3 Wry and optional CEF plugin for runtime UI testing and automation via JSON-RPC over Unix sockets or Windows named pipes.

This crate is the in-process bridge used by the complete
[Tauri Hasgard](https://github.com/nyssance/tauri-hasgard) automation toolchain.
Registering `init()` or `init_cef()` enables automation in both debug and release builds.

Initialize Tauri 3 with `.runtime(tauri_runtime_wry::Wry::default())`.
The `init()` entry point requires Wry and rejects other runtimes during setup.

Register the plugin with `.plugin(tauri_plugin_hasgard::init())` and add `hasgard:default` in the Tauri capability covering every webview under test. Preserve the capability’s other permissions:

```json
{
  "windows": ["*"],
  "permissions": ["hasgard:default"]
}
```

This permission enables the internal eval-result callbacks. Without it, Hasgard can connect to the native server but cannot return WebView evaluation results.

For CEF, enable the `cef` Cargo feature and register
`.plugin(tauri_plugin_hasgard::init_cef())` on a `DynRuntime` builder using
`tauri_runtime_cef::Cef`. This backend uses in-process CDP in an isolated world;
remote pages do not need `hasgard:default` or Tauri IPC access. It supports DOM
operations, navigation, native keyboard input, and macOS viewport screenshots.
Bundle the `hasgard-playwright` executor beside the application executable for
CEF click, double-click, hover, fill, type, check and select operations. These use
Playwright actionability and browser input instead of synthetic DOM events.
`ipc` uses the selected page's real Tauri bridge in its main world and preserves
application capability checks; remote pages gain no IPC permissions.
Console output is read from CDP console events. Network observation, routing and
JavaScript dialog interception are not implemented and return explicit errors. See [CEF setup and limits](../../docs/cef.md).

## Application integration

Use the same initialization in development and shipping applications. Registration
is the opt-in; no extra Cargo feature or application settings are required.
Native keyboard input is included; `cef` is the only optional backend feature.
The plugin does not reposition application windows.

The host selects integration in code. `init_with_options(Options {
listen: false })` registers the Wry executor without opening the local transport.
The managed `Automation` handle accepts explicit webview labels through
`call`; hosts can route their own tools to it. Local clients use the existing
Hasgard CLI, Playwright fixture or JSON-RPC protocol unchanged.

A CEF host that already packages a JavaScript runtime and Playwright can use
`init_cef_with_executor(options, factory)`. The factory returns an
`ExecutorCommand` before transport startup. `playwright::worker_source()` supplies
the small host worker; pass the packaged Playwright module URL as its argument.
The host owns resource staging. No second model, browser or user profile is created.
