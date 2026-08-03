import type { TestInfo } from "@playwright/test"
import { createHasgardExpect } from "./expect.js"
import { HasgardProcess } from "./process-manager.js"
import { HasgardRpcClient } from "./rpc-client.js"
import type { HasgardFixtures, HasgardTestConfig, HasgardWorkerFixtures } from "./types.js"
import { HasgardApplication } from "./window.js"

export function createHasgardTest(config: HasgardTestConfig) {
  const base = config.test
  const expect = createHasgardExpect(config.expect)
  const readinessTimeoutMs = config.launch ? config.launch.timeoutMs : 30_000
  const fixtureTimeoutMs = config.launch ? config.launch.timeoutMs + 30_000 : 30_000
  const test = base.extend<HasgardFixtures, HasgardWorkerFixtures>({
    hasgard: [
      async ({}, use, workerInfo) => {
        const socketPath =
          typeof config.socketPath === "function" ? config.socketPath(workerInfo.workerIndex) : config.socketPath
        const process = new HasgardProcess()
        const rpc = new HasgardRpcClient(socketPath)
        try {
          if (config.launch) await process.start(config.launch, socketPath)
          else await process.waitForSocket(socketPath, workerInfo.project.timeout)

          await rpc.connect(workerInfo.project.timeout)
          const hasgard = new HasgardApplication(rpc)
          const ping = await hasgard.ping()
          if (ping.status !== "ok") throw new Error(`Unexpected Hasgard ping status: ${ping.status}`)
          await hasgard.waitForWindowReady(config.windowLabel, config.readySelector, readinessTimeoutMs)
          await use(hasgard)
        } finally {
          rpc.disconnect()
          await process.stop()
        }
      },
      { scope: "worker", timeout: fixtureTimeoutMs }
    ],

    window: async ({ hasgard }, use, testInfo: TestInfo) => {
      await use(hasgard.window(config.windowLabel))
      if (testInfo.status !== testInfo.expectedStatus) {
        const screenshot = await hasgard.window(config.windowLabel).screenshot()
        await testInfo.attach("hasgard-screenshot", {
          body: screenshot,
          contentType: "image/png"
        })
      }
    }
  })

  return { test, expect }
}
