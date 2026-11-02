import { join } from "node:path"

import { createHasgardTest, hasgardEndpointPath } from "@nyssance/tauri-hasgard"
import { expect as playwrightExpect, test as playwrightTest } from "@playwright/test"

const executableName = process.platform === "win32" ? "tauri-hasgard-fixture-app.exe" : "tauri-hasgard-fixture-app"
export const executablePath = join(import.meta.dirname, "../../../target/debug", executableName)

export const fixtureEndpoint = (workerIndex: number) =>
  hasgardEndpointPath(`tauri-hasgard-fixture-${process.pid}-${workerIndex}`)

export const { test, expect } = createHasgardTest({
  test: playwrightTest,
  expect: playwrightExpect,
  socketPath: fixtureEndpoint,
  windowLabel: "main",
  readySelector: 'html[data-hasgard-ready="true"]',
  launch: {
    command: executablePath,
    args: [],
    cwd: join(import.meta.dirname, ".."),
    // A fresh Windows runner image initialises WebView2 on the first launches: on image 20261030.294.1 the first two
    // launches each missed a 30 s window-load deadline and every later one loaded in under a second.
    timeoutMs: process.platform === "win32" ? 120_000 : 30_000
  }
})
