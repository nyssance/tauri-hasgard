# @nyssance/tauri-hasgard

Playwright Test fixtures for real Tauri 2 webviews. The package uses Playwright for test scheduling, assertions, retries, reporters, and artifacts; native application control goes through Hasgard's JSON-RPC bridge.

It deliberately does not expose a fake Playwright `Page`. WKWebView and WebKitGTK do not implement Chromium's CDP contract.

The fixture object model is `HasgardApplication → HasgardWindow → HasgardLocator`. `hasgard` is the worker-scoped application fixture; `window` is the test-scoped configured primary window.

## Setup

```ts
import { createHasgardTest } from "@nyssance/tauri-hasgard"
import { expect as playwrightExpect, test as playwrightTest } from "@playwright/test"

export const { test, expect } = createHasgardTest({
  test: playwrightTest,
  expect: playwrightExpect,
  socketPath: workerIndex => `/tmp/my-app-e2e-${workerIndex}.sock`,
  windowLabel: "main",
  readySelector: '[data-app-ready="true"]',
  launch: {
    command: "bun",
    args: ["run", "tauri", "dev"],
    cwd: import.meta.dirname,
    timeoutMs: 120_000
  }
})
```

The fixture passes the selected socket to the application as `TAURI_HASGARD_SOCKET`, so each Playwright worker receives an isolated connection.

On macOS, a managed launch owns a detached process group. Teardown
waits for that group to exit, including children left behind by a launcher,
and escalates from SIGTERM to SIGKILL after five seconds. Startup failures also
clean up, and concurrent `stop()` calls share the same cleanup. A live endpoint
is rejected rather than unlinked; readiness requires a successful connection.
If cleanup fails, ownership is retained so `stop()` can be retried; another
launch is blocked until that cleanup succeeds.
Diagnostics retain the last 64 Ki characters per output stream with a truncation
marker. `await process.diagnostics()` exposes those tails and the actual exit
code or signal. Failed tests attach them; a failed screenshot does not replace
the original test error. Teardown removes the owned stale socket after its
process group exits, checking its identity and preserving live or replaced paths.

An independent supervisor owns the application and watches the worker's IPC
connection. If the worker is killed with SIGKILL, the supervisor still terminates
the application group and exits. Killing the supervisor itself or children that
deliberately create a new session or process group are outside this guarantee.
Attach-only fixtures do not terminate an application they did not launch.

`window.press(key)` uses native OS input and, by default, waits for a trusted
WebView keyup before the next press may switch windows. For OS shortcuts and
keys that navigate or close the document, explicitly use
`window.press(key, { completion: "native" })`; that mode confirms posting only.
Bare modifiers also use native posting completion. The active input method
remains in effect: use `fill` for exact text, and `Shift+m` for a shifted key.

To keep keyboard ownership until an application state is observable:

```ts
await window.press("Tab", {
  waitFor: "document.activeElement.id === 'save'",
  timeoutMs: 1_000
})
```

The postcondition timeout is capped at ten seconds. Failures retain their
`HasgardRpcError.data.phase` and `injected` status; never blindly retry an
already-injected or uncertain press. See [the wire contract](../../docs/protocol.md#native-keyboard-completion).

Requests are limited to 1,048,576 UTF-8 bytes including the trailing newline,
matching the plugin. Oversized requests fail before transmission. An explicit
null result is supported; malformed responses are rejected instead of returning
an invented value.

## Test

```ts
test("saves settings in a secondary window", async ({ hasgard }) => {
  const settings = hasgard.window("settings")
  await settings.getByRole("textbox", { name: "Display name" }).fill("Nyssance")
  await settings.getByRole("button", { name: "Save", exact: true }).click()
  await expect(settings.getByRole("status")).toHaveText("Saved")
})
```

Use `window` for the configured primary window:

```ts
test("opens preferences", async ({ window }) => {
  await window.getByRole("button", { name: "Settings", exact: true }).click()
})
```

## Targets

- `window.locator(css)` sends a CSS selector directly.
- `window.getByRole(role, query)` takes a fresh accessibility snapshot, demands exactly one match for actions, then sends its snapshot ref.
- `byPoint(x, y)` and `byRef(ref)` are available for low-level calls.

Ambiguous semantic locators throw. Missing required configuration throws. There is no browser-mode fallback and no silent switch to a different window.
