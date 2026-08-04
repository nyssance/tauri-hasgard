# tauri-plugin-hasgard

Tauri v2 plugin for runtime UI testing and automation via Unix socket JSON-RPC.

This crate is the in-process debug bridge used by the complete
[Tauri Hasgard](https://github.com/nyssance/tauri-hasgard) automation toolchain.
It is not the whole product and is inert in release builds.

Register the plugin and grant `hasgard:default` in the Tauri capability covering every webview under test:

```json
{
  "windows": ["*"],
  "permissions": ["hasgard:default"]
}
```

This permission enables the internal eval-result callbacks. Without it, Hasgard can connect to the native server but cannot return WebView evaluation results.
