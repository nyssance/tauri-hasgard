# @nyssance/tauri-hasgard

Playwright Test fixtures for real Tauri 3 Wry applications. Playwright handles scheduling, retries, assertions, and reports; Hasgard controls native webviews through the plugin.

## 1. Prepare your app

[Register the Rust plugin and grant `hasgard:default`](https://github.com/nyssance/tauri-hasgard#register-the-plugin). Use Node.js 24 or newer and install:

```sh
bun add --dev @nyssance/tauri-hasgard @playwright/test
```

Set a readiness marker in your frontend **after initialization finishes**:

```ts
document.documentElement.dataset.appReady = "true"
```

Hasgard waits for this marker before tests start. No Playwright browser download is needed.

## 2. Configure the fixture

Create `e2e/fixtures.ts`:

```ts
import { join } from "node:path"

import { createHasgardTest, hasgardEndpointPath } from "@nyssance/tauri-hasgard"
import { expect as playwrightExpect, test as playwrightTest } from "@playwright/test"

export const { test, expect } = createHasgardTest({
  test: playwrightTest,
  expect: playwrightExpect,
  socketPath: (workerIndex) => hasgardEndpointPath(`my-app-${process.pid}-${workerIndex}`),
  windowLabel: "main",
  readySelector: 'html[data-app-ready="true"]',
  launch: {
    command: "bun",
    args: ["run", "tauri", "dev"],
    cwd: join(import.meta.dirname, ".."),
    timeoutMs: 120_000
  }
})
```

Use your app's actual window label and launch command. `hasgardEndpointPath` creates a Unix socket path or Windows named-pipe name. The fixture passes it to the app as `TAURI_HASGARD_SOCKET`.

Create `playwright.config.ts` in the app root:

```ts
import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 }
})
```

Start with one worker: development servers share ports, and native keyboard input shares desktop focus. For parallel non-keyboard tests, build a debug executable once and launch that binary per worker instead of starting several dev servers. Give each instance separate application data if your app persists state.

## 3. Write and run a test

Create `e2e/settings.spec.ts`. Adapt the button, window label, and heading to your UI:

```ts
import { expect, test } from "./fixtures"

test("opens settings", async ({ hasgard, window }) => {
  await window.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = await hasgard.waitForWindow("settings", 5_000)
  await expect(settings.getByRole("heading", { name: "Settings", exact: true })).toBeVisible()
})
```

```sh
bunx playwright test
```

`hasgard` is a worker-scoped `HasgardApplication`; `window` selects the configured primary `HasgardWindow`. Tests in the same worker share application state. Reset data and close secondary windows in your test setup or teardown as needed.

For a complete runnable example, see the repository's [fixture app](https://github.com/nyssance/tauri-hasgard/tree/main/examples/fixture-app) and [development instructions](https://github.com/nyssance/tauri-hasgard/blob/main/CONTRIBUTING.md).

## Common operations

```ts
await window.getByRole("textbox", { name: "Display name", exact: true }).fill("Nyssance")
await window.locator('[data-testid="save"]').click()
await expect(window.getByRole("status")).toHaveText("Saved")
await window.press("Tab", {
  waitFor: "document.activeElement.id === 'save'",
  timeoutMs: 1_000
})
```

- Use `fill` for exact text. `press` sends native input through the active input method.
- For shortcuts that close or navigate a document, use `press(key, { completion: "native" })`; it confirms posting only. Do not blindly retry a key that may already have been injected.
- CSS locators use the live selector. Role locators take a fresh accessibility snapshot and require exactly one match for an action.
- To attach to an existing app, omit `launch` and set `socketPath` to its endpoint. Teardown leaves that app running.

## Lifecycle and limits

Managed launches are cleaned up at worker teardown and on startup failure. On macOS/Linux, a supervisor also cleans up the app's process group if the worker is killed. Children that create a separate process group, or killing the supervisor itself, are outside this guarantee.

Failed tests using the `window` fixture attach process diagnostics and a screenshot when available. Logs retain a bounded tail. Live endpoints are rejected rather than overwritten.

There is no `page` fixture or mocked browser mode. Use `HasgardApplication → HasgardWindow → HasgardLocator`; full Playwright `Page` APIs are not supported.

[Protocol and keyboard semantics](https://github.com/nyssance/tauri-hasgard/blob/main/docs/protocol.md) · [Troubleshooting](https://github.com/nyssance/tauri-hasgard/blob/main/docs/troubleshooting.md)
