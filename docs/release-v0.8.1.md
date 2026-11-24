# 0.8.1

Tests can answer the dialog plugin's native dialogs.

Nothing can click an operating-system file panel reliably, so a test states the answer in advance and the application receives it where the dialog's result would arrive:

```ts
await window.nativeDialogs.accept({ paths: ["/tmp/report.csv"] })
await window.locator("#export").click()
```

- `nativeDialog.handle`, `nativeDialog.list` and `nativeDialog.clear` cover open (one path or several), save, and message dialogs, where `button` picks a label. `dismiss` answers as a cancelled dialog does.
- Only those three commands of the dialog plugin are answered. Every other command reaches the application's backend, and the default, `manual`, leaves the system dialog on screen.
- Each answered dialog is recorded with its kind, title, options and result, so a test can assert that the application asked.
- Available as CLI `native-dialog`, the MCP `native_dialog` tool, and Playwright `window.nativeDialogs`.

Wry only; CEF answers `-32601`. A real dialog also grants file access to the path it returns and an answered one does not, so the path must already be allowed by the application's permissions. The policy belongs to the document and resets on navigation.

The native suites pass for Wry and CEF on macOS and Windows. Everything else is unchanged from 0.8.0.
