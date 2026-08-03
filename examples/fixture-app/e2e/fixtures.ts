import { join } from "node:path"
import { createHasgardTest, hasgardEndpointPath } from "@nyssance/tauri-hasgard"
import { expect as playwrightExpect, test as playwrightTest } from "@playwright/test"

const executableName = process.platform === "win32" ? "tauri-hasgard-fixture-app.exe" : "tauri-hasgard-fixture-app"
const executablePath = join(import.meta.dirname, "../../../target/debug", executableName)

export const { test, expect } = createHasgardTest({
  test: playwrightTest,
  expect: playwrightExpect,
  socketPath: workerIndex => hasgardEndpointPath(`tauri-hasgard-fixture-${process.pid}-${workerIndex}`),
  windowLabel: "main",
  readySelector: 'html[data-hasgard-ready="true"]',
  launch: {
    command: executablePath,
    args: [],
    cwd: join(import.meta.dirname, ".."),
    timeoutMs: 30_000
  }
})
