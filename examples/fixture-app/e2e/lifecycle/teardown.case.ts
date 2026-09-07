import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createHasgardTest } from "@nyssance/tauri-hasgard"
import { expect as baseExpect, test as baseTest } from "@playwright/test"
import { executablePath } from "../fixtures.js"

const endpoint = process.env.HASGARD_LIFECYCLE_ENDPOINT
const pidFile = process.env.HASGARD_LIFECYCLE_PID_FILE
if (!endpoint || !pidFile) throw new Error("Lifecycle endpoint and PID file are required")

const { test, expect } = createHasgardTest({
  test: baseTest,
  expect: baseExpect,
  socketPath: endpoint,
  windowLabel: "main",
  readySelector: 'html[data-hasgard-ready="true"]',
  launch: { command: executablePath, args: [], cwd: join(import.meta.dirname, "../.."), timeoutMs: 30_000 }
})

test("managed teardown", async ({ hasgard, window }) => {
  const pid = await window.invoke<number>("fixture_process_id", {})
  await writeFile(pidFile, String(pid))
  expect((await hasgard.windows()).map(item => item.label)).toEqual(expect.arrayContaining(["main", "settings"]))
  await expect(window.getByRole("button", { name: "Open dialog", exact: true })).toBeVisible()
  if (process.env.HASGARD_LIFECYCLE_FAILURE === "kill") process.kill(process.pid, "SIGKILL")
  if (process.env.HASGARD_LIFECYCLE_FAILURE === "crash") {
    process.kill(pid, "SIGTRAP")
    await window.title()
    throw new Error("Application unexpectedly served a request after SIGTRAP")
  }
  if (process.env.HASGARD_LIFECYCLE_FAILURE === "1") throw new Error("Intentional lifecycle test failure")
})
