# tauri-plugin-hasgard

Tauri 3 Wry plugin for runtime UI testing and automation via JSON-RPC over Unix sockets or Windows named pipes.

This crate is the in-process debug bridge used by the complete
[Tauri Hasgard](https://github.com/nyssance/tauri-hasgard) automation toolchain.
It is not the whole product and is inert in release builds.

Initialize Tauri 3 with `.runtime(tauri_runtime_wry::Wry::default())`.
The plugin requires Wry and rejects other runtimes during debug setup.

Register the plugin with `.plugin(tauri_plugin_hasgard::init())` and add `hasgard:default` in the Tauri capability covering every webview under test. Preserve the capability’s other permissions:

```json
{
  "windows": ["*"],
  "permissions": ["hasgard:default"]
}
```

This permission enables the internal eval-result callbacks. Without it, Hasgard can connect to the native server but cannot return WebView evaluation results.
