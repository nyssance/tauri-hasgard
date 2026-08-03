import { spawn, type ChildProcess } from "node:child_process"
import { access, rm } from "node:fs/promises"
import type { HasgardLaunchConfig } from "./types.js"

export class HasgardProcess {
  private child: ChildProcess | undefined
  private stdout = ""
  private stderr = ""

  async start(config: HasgardLaunchConfig, socketPath: string): Promise<void> {
    if (this.child) throw new Error("Hasgard app process is already running")
    if (process.platform !== "win32") await rm(socketPath, { force: true })
    const child = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: { ...process.env, ...config.env, TAURI_HASGARD_SOCKET: socketPath },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    })
    this.child = child
    child.stdout?.on("data", (data: Buffer) => {
      this.stdout += data.toString()
    })
    child.stderr?.on("data", (data: Buffer) => {
      this.stderr += data.toString()
    })
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve)
      child.once("error", reject)
    })
    try {
      await this.waitForSocket(socketPath, config.timeoutMs)
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() <= deadline) {
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) {
        throw new Error(
          `Tauri process exited with code ${this.child.exitCode}\nstdout:\n${this.stdout}\nstderr:\n${this.stderr}`
        )
      }
      try {
        await access(socketPath)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "ENOENT") throw error
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Hasgard socket did not appear within ${timeoutMs}ms: ${socketPath}`)
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null) return
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()))
    if (process.platform === "win32") {
      child.kill("SIGTERM")
    } else if (child.pid !== undefined) {
      process.kill(-child.pid, "SIGTERM")
    }
    const timeout = new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 5_000))
    if ((await Promise.race([exited, timeout])) === "timeout") {
      if (process.platform === "win32") child.kill("SIGKILL")
      else if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
      await exited
    }
    this.child = undefined
  }
}
