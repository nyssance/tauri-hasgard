# 0.6.7

Let macOS native runs share the machine with the person using it: `TAURI_HASGARD_PRESS=window` delivers `press` to the target window instead of the system input layer.

- `press` posts OS keyboard events by default, which only reach the frontmost application. Every press therefore activates the application first, and a run fails with `failed to focus target window` when another application takes the foreground.
- With `TAURI_HASGARD_PRESS=window` (macOS, Wry) the same key events are handed to the target window on the main thread, in `AppKit`'s own order: window key equivalents, the main menu, then the first responder. The application is never activated. The target window is made key among the application's own windows and its text input context made current, so typed text lands in the requested window.
- Menu shortcuts, trusted DOM key events, paired modifier events and `completion` keep working. Keys are looked up on the current keyboard layout.
- System-wide shortcuts are registered below `AppKit` and are not triggered in this mode. CEF rejects `window`. An unknown value fails the press. The default, `system`, is unchanged.

Validated locally on macOS with another application repeatedly taking the foreground during the run: the Wry fixture's 75 native tests pass in `window` mode, and a consuming application's 47-test native suite passed three times in `window` mode where the default mode failed one of two runs. The fixture also passes 75 tests in the default mode. Windows behavior is unchanged and not affected by the variable.
