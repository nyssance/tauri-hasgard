# 0.8.2

Downloads, Tauri events, native dialogs on CEF, and state that survives navigation.

- **Downloads.** `downloads.wait` resolves when a download finishes, with the path it was saved to; `downloads.setDirectory` sends later ones to a directory a test owns. The application passes `tauri_plugin_hasgard::downloads::observer()` to `on_download`, or wraps its own handler with `downloads::observe`. CLI `downloads`, the MCP `downloads` tool, Playwright `hasgard.waitForDownload` and `hasgard.downloads`.
- **Tauri events.** `event.emit` delivers an event to the application as its backend would; `event.listen` and `event.list` record what the application emits. CLI `event`, the MCP `event` tool, Playwright `hasgard.emit`, `hasgard.events` and `hasgard.waitForEvent`.
- **Native dialogs on CEF.** The answers that 0.8.1 added for Wry work on CEF too.
- **State across navigation on Wry.** Routes, the dialog policies, and console and network logs follow a flow to the next document of the same origin, as they already did on CEF.
- **Frames.** `screenshot` and `diff` take `frame`, and a frame keeps a diff baseline apart from its page. The frame scope also reaches `scroll`, `wheel`, `html`, `drag` and the MCP read and assert tools.
- **Reading and selecting.** `visible`, `checked` and `count` answer where the `assert_*` forms fail. `select` takes several values, `scroll` takes a target, and Playwright `locator.waitFor` accepts `visible` and `hidden`.
- **Scenarios and recording.** TOML scenarios gain `hover`, `dblclick`, `focus`, `blur`, `drag`, `set-input-files`, `wheel`, `dialog`, `native-dialog`, `route` and `ipc`; recording and replay cover the same ground.
- A `timeout` or `sinceId` of the wrong type is rejected instead of being replaced by the default.

On Windows, `tauri-runtime-cef` 3.0.0-alpha.7 sometimes crashes while an application exits; it does so without this plugin loaded. See `docs/cef.md`.

The native suites pass for Wry and CEF on macOS and Windows. `CHANGELOG.md` has the full list.
