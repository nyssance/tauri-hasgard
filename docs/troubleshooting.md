# Troubleshooting

Start with `tauri-hasgard ping`, then `tauri-hasgard windows`. If both succeed, check the target window and its capability permissions.

| Symptom                                       | Check or fix                                                                                                                                                                |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cannot connect / no app found                 | Start the app with the plugin in a **debug** build. Release builds do not start Hasgard.                                                                                    |
| Several apps found / wrong app                | Pass `--socket <endpoint>` before the command, or set `TAURI_HASGARD_SOCKET` for both the app and client.                                                                   |
| `hasgard.__callback not allowed`              | Add `hasgard:default` to the existing capability permissions for the target window, then restart the app.                                                                   |
| Window not found                              | Run `windows` and use the exact label with `--window`. A window title is not its label.                                                                                     |
| Fixture readiness timeout                     | Check launch output, `windowLabel`, and `readySelector`. Set the marker only after initialization completes. Increase `launch.timeoutMs` if the initial build takes longer. |
| Endpoint already in use                       | Stop the app that owns it, or use a unique endpoint. Do not delete a live app's socket.                                                                                     |
| Role locator matches several elements         | Add `exact: true`, use a more specific accessible name, or use a unique CSS selector.                                                                                       |
| Typed text differs from expected              | Use `fill` for exact text. Native `press` follows the current input method and keyboard focus.                                                                              |
| Shortcut closes the window and then times out | Use `completion: "native"` for keys that navigate or close the document; this confirms posting, not an application result.                                                  |
| Tests affect each other                       | The app is shared within a worker. Reset state and close secondary windows; keep native keyboard tests on one worker.                                                       |
| Native capture / video fails                  | Check the platform requirements in the protocol. macOS video needs ffmpeg and Screen Recording permission.                                                                  |

For failed Playwright tests, inspect the `hasgard-process`, `hasgard-screenshot`, or `hasgard-screenshot-error` attachments when the test uses the `window` fixture. For launch failures, inspect the fixture diagnostics printed to the terminal.

When reporting a bug, include the OS/architecture, Hasgard and Tauri versions, command or minimal test, window label, and full error. Remove secrets from logs and screenshots.

[CLI tutorial](getting-started.md) · [Playwright tutorial](../packages/playwright/README.md) · [Protocol](protocol.md)
