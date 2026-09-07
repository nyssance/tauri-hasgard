import { spawn } from "node:child_process"
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HasgardProcess, HasgardRpcClient } from "@nyssance/tauri-hasgard"
import { expect, test } from "@playwright/test"

test.describe("native application lifecycle", () => {
  test.skip(process.platform === "win32", "This suite verifies Unix process-group ownership")

  for (const mode of ["success", "failure", "worker SIGKILL", "application SIGTRAP"]) {
    test(`fixture reaps its real multi-window Tauri application after ${mode}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "hg-native-"))
      const endpoint = join(directory, "app.sock")
      const pidFile = join(directory, "pid")
      let pid: number | undefined
      try {
        const result = await runWorker({
          HASGARD_LIFECYCLE_ENDPOINT: endpoint,
          HASGARD_LIFECYCLE_PID_FILE: pidFile,
          HASGARD_LIFECYCLE_OUTPUT_DIR: join(directory, "results"),
          HASGARD_LIFECYCLE_FAILURE:
            mode === "worker SIGKILL"
              ? "kill"
              : mode === "failure"
                ? "1"
                : mode === "application SIGTRAP"
                  ? "crash"
                  : "0"
        })
        expect(result.code, result.output).toBe(mode === "success" ? 0 : 1)
        if (mode === "failure") expect(result.output).toContain("Intentional lifecycle test failure")
        if (mode === "worker SIGKILL") expect(result.output).toContain("SIGKILL")
        if (mode === "application SIGTRAP") {
          expect(result.output).toContain("Hasgard application exited:")
          expect(result.output).toContain('"signal":"SIGTRAP"')
        }
        pid = await readPid(pidFile)
        await expect.poll(() => isAlive(pid as number), { timeout: 12_000 }).toBe(false)
        const rpc = new HasgardRpcClient(endpoint)
        try {
          await expect(rpc.connect(500)).rejects.toThrow()
        } finally {
          rpc.disconnect()
        }
        // Readiness must reject a leftover filesystem entry after the app exits.
        await expect(new HasgardProcess().waitForSocket(endpoint, 100)).rejects.toThrow(/socket did not appear/)
        await expect
          .poll(async () => {
            try {
              await lstat(endpoint)
              return false
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
              throw error
            }
          })
          .toBe(true)
      } finally {
        // Recover the PID even when an earlier assertion failed. The native
        // fixture records it before plugin setup and webview readiness.
        if (pid === undefined) {
          try {
            pid = await readPid(pidFile)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          }
        }
        if (pid !== undefined) {
          try {
            process.kill(-pid, "SIGKILL")
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
          }
        }
        await rm(directory, { recursive: true, force: true })
      }
    })
  }
})

async function runWorker(env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  const child = spawn(
    process.execPath,
    [
      join(import.meta.dirname, "../../node_modules/@playwright/test/cli.js"),
      "test",
      "--config",
      join(import.meta.dirname, "../lifecycle/teardown.config.ts")
    ],
    { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], timeout: 75_000, killSignal: "SIGKILL" }
  )
  let output = ""
  child.stdout.on("data", chunk => {
    output += String(chunk)
  })
  child.stderr.on("data", chunk => {
    output += String(chunk)
  })
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", code => resolve({ code, output }))
  })
}

async function readPid(path: string): Promise<number> {
  const pid = Number(await readFile(path, "utf8"))
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Invalid lifecycle PID: ${pid}`)
  return pid
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}
