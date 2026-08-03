# @nyssance/tauri-hasgard

Playwright Test fixtures for real Tauri 2 webviews. The package uses Playwright for test scheduling, assertions, retries, reporters, and artifacts; native application control goes through Hasgard's JSON-RPC bridge.

It deliberately does not expose a fake Playwright `Page`. WKWebView and WebKitGTK do not implement Chromium's CDP contract.

The fixture object model is `HasgardApplication → HasgardWindow → HasgardLocator`. `hasgard` is the worker-scoped application fixture; `window` is the test-scoped configured primary window.

## Setup

```ts
import { createHasgardTest } from "@nyssance/tauri-hasgard";
import {
  expect as playwrightExpect,
  test as playwrightTest,
} from "@playwright/test";

export const { test, expect } = createHasgardTest({
  test: playwrightTest,
  expect: playwrightExpect,
  socketPath: (workerIndex) => `/tmp/my-app-e2e-${workerIndex}.sock`,
  windowLabel: "main",
  readySelector: '[data-app-ready="true"]',
  launch: {
    command: "bun",
    args: ["run", "tauri", "dev"],
    cwd: import.meta.dirname,
    timeoutMs: 120_000,
  },
});
```

The fixture passes the selected socket to the application as `TAURI_HASGARD_SOCKET`, so each Playwright worker receives an isolated connection.

## Test

```ts
test("saves settings in a secondary window", async ({ hasgard }) => {
  const settings = hasgard.window("settings");
  await settings
    .getByRole("textbox", { name: "Display name" })
    .fill("Nyssance");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings.getByRole("status")).toHaveText("Saved");
});
```

Use `window` for the configured primary window:

```ts
test("opens preferences", async ({ window }) => {
  await window.getByRole("button", { name: "Settings", exact: true }).click();
});
```

## Targets

- `window.locator(css)` sends a CSS selector directly.
- `window.getByRole(role, query)` takes a fresh accessibility snapshot, demands exactly one match for actions, then sends its snapshot ref.
- `byPoint(x, y)` and `byRef(ref)` are available for low-level calls.

Ambiguous semantic locators throw. Missing required configuration throws. There is no browser-mode fallback and no silent switch to a different window.
