# 0.8.4

Fixes from eight review passes over 0.8.3. Nothing new to learn; several things that used to pass or fail silently now do what they say.

- **Recording and replay.** Recorded dialog policies, native dialog policies and routes are replayed; they used to be skipped. `replay` fails when a step fails (CLI exit 1, MCP error, the failing steps in the result) and keeps each entry's recorded window unless one is named. `replay --export sh` needs no running application, and exported commands are ones the CLI reads back.
- **Native dialogs.** The answering policy survives `storage.clear` and an application that clears its own session storage, so a real system dialog no longer appears on the next page.
- **Waits that answered with old results.** `downloads.wait`, Playwright `waitForDownload` and `waitForEvent`, and the MCP `downloads` tool give each result once.
- **Scenarios.** A step that times out no longer breaks every later step; `assert-exists` fails for a selector that matches nothing; `check` is accepted; a field an action does not read is rejected.
- **Frames.** `watch`, `forms`, an expression `wait`, MCP `clear` and Playwright `dragTo` act in the frame they name. Commands that have no document to scope reject `frame`.
- **Native key presses.** A press right after a lone modifier no longer times out.
- **MCP.** An in-process server can use the `event`, `downloads` and `clipboard` tools. `run_scenario` and `replay` refuse `eval`, `ipc` and `drop` while dangerous tools are disabled.

## Upgrading

- Recording format: a parameter named `action` or `timestamp` is stored under `arguments`. Dialog and route entries recorded by earlier versions lost their method name and cannot be replayed.
- Exported commands write options as `--name=value`.
- The Playwright client 0.8.4 needs plugin 0.8.4.
- Rejected instead of ignored: a `timeout`, `depth`, `amount`, `poll` or `stable` of the wrong type; `frame` where it has no meaning; scenario fields an action does not read; `event.emit` to a window that does not exist.

The native suites pass for Wry and CEF on macOS and Windows. The full list is in `CHANGELOG.md`.
