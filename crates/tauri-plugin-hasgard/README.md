# tauri-plugin-hasgard

Tauri 3 Wry and optional CEF plugin for runtime UI testing and automation via JSON-RPC over Unix sockets or Windows named pipes.

This crate is the in-process debug bridge used by the complete
[Tauri Hasgard](https://github.com/nyssance/tauri-hasgard) automation toolchain.
It is not the whole product and is inert in release builds.

Initialize Tauri 3 with `.runtime(tauri_runtime_wry::Wry::default())`.
The `init()` entry point requires Wry and rejects other runtimes during debug setup.

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
Console/network observation, routing and JavaScript dialog interception are not
implemented and return explicit errors. See [CEF setup and limits](../../docs/cef.md).
