import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHasgardTest } from "@nyssance/tauri-hasgard"
import { expect as playwrightExpect, test as playwrightTest } from "@playwright/test"

export const { test, expect } = createHasgardTest({
  test: playwrightTest,
  expect: playwrightExpect,
  socketPath: workerIndex => join(tmpdir(), `tauri-hasgard-fixture-${process.pid}-${workerIndex}.sock`),
  windowLabel: "main",
  readySelector: 'html[data-hasgard-ready="true"]',
  launch: {
    command: "bun",
    args: ["run", "tauri", "dev", "--features", "hasgard-testing"],
    cwd: join(import.meta.dirname, ".."),
    timeoutMs: 120_000
  }
})
