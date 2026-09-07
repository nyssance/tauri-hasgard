import { type ChildProcess, fork, spawn } from "node:child_process"
import { lstat } from "node:fs/promises"
import { createConnection } from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { stopProcessGroup } from "./process-group.js"
import type { HasgardLaunchConfig } from "./types.js"

export class HasgardProcess {
  private child: ChildProcess | undefined
  private stdout = ""
  private stderr = ""
  private starting: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private applicationPid: number | undefined
  private applicationExit: { code: number | null; signal: string | null } | undefined

  /** Bounded log tails and the supervisor's actual child-close result. */
  async diagnostics(waitForExitMs = 0) {
    if (!Number.isFinite(waitForExitMs) || waitForExitMs < 0) throw new RangeError("Invalid diagnostics wait")
    const deadline = Date.now() + waitForExitMs
    while (this.child && !this.applicationExit && Date.now() < deadline)
      await delay(Math.min(25, deadline - Date.now()))
    return { pid: this.applicationPid, exit: this.applicationExit, stdout: this.stdout, stderr: this.stderr }
  }

  async start(config: HasgardLaunchConfig, socketPath: string): Promise<void> {
    if (this.child || this.stopping || this.starting) throw new Error("Hasgard app process is already running")
    this.starting = this.launch(config, socketPath)
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }

  private async launch(config: HasgardLaunchConfig, socketPath: string): Promise<void> {
    this.stdout = ""
    this.stderr = ""
    this.applicationPid = undefined
    this.applicationExit = undefined
    if (process.platform !== "win32" && (await endpointAcceptsConnections(socketPath))) {
      throw new Error(`Hasgard endpoint is already in use: ${socketPath}`)
    }
    if (process.platform !== "win32") {
      await this.launchSupervised(config, socketPath)
      return
    }
    const child = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: { ...process.env, ...config.env, TAURI_HASGARD_SOCKET: socketPath },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    })
    this.child = child
    child.stdout?.on("data", (data: Buffer) => {
      this.stdout = appendOutput(this.stdout, data.toString())
    })
    child.stderr?.on("data", (data: Buffer) => {
      this.stderr = appendOutput(this.stderr, data.toString())
    })
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve)
        child.once("error", reject)
      })
      await this.waitForSocket(socketPath, config.timeoutMs)
    } catch (error) {
      try {
        await this.stopChild()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Hasgard launch failed and process cleanup failed")
      }
      throw error
    }
  }

  private async launchSupervised(config: HasgardLaunchConfig, socketPath: string): Promise<void> {
    const child = fork(new URL("./process-supervisor.js", import.meta.url), [], {
      detached: true,
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    })
    this.child = child
    child.stderr?.on("data", data => {
      this.stderr = appendOutput(this.stderr, String(data))
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Hasgard process supervisor did not start")), config.timeoutMs)
        const failed = (error: Error) => {
          clearTimeout(timer)
          reject(error)
        }
        child.once("error", failed)
        child.once("exit", () => failed(new Error("Hasgard process supervisor exited")))
        child.on(
          "message",
          (message: {
            type: string
            pid: number
            data: string
            message: string
            code: number | null
            signal: string | null
          }) => {
            if (message.type === "stdout") this.stdout = appendOutput(this.stdout, message.data)
            else if (message.type === "stderr") this.stderr = appendOutput(this.stderr, message.data)
            else if (message.type === "exit") this.applicationExit = { code: message.code, signal: message.signal }
            else if (message.type === "error") failed(Object.assign(new Error(message.message), { code: message.code }))
            else if (message.type === "started") {
              if (!Number.isSafeInteger(message.pid) || message.pid <= 1) {
                failed(new Error("Invalid supervised application PID"))
                return
              }
              this.applicationPid = message.pid
              clearTimeout(timer)
              resolve()
            }
          }
        )
        child.send({ ...config, env: { ...process.env, ...config.env, TAURI_HASGARD_SOCKET: socketPath } }, error => {
          if (error) failed(error)
        })
      })
      await this.waitForSocket(socketPath, config.timeoutMs)
      await this.confirmEndpointOwnership(child, socketPath, config.timeoutMs)
    } catch (error) {
      try {
        await this.stopChild()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Hasgard launch failed and process cleanup failed")
      }
      throw error
    }
  }

  async waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() <= deadline) {
      const child = this.child
      if (this.applicationExit) {
        const { code, signal } = this.applicationExit
        throw new Error(
          `Tauri process exited with ${signal ? `signal ${signal}` : `code ${code}`}\nstdout:\n${this.stdout}\nstderr:\n${this.stderr}`
        )
      }
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(
          `Tauri process exited with ${child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`}\nstdout:\n${this.stdout}\nstderr:\n${this.stderr}`
        )
      }
      if (await endpointAcceptsConnections(socketPath)) return
      await delay(50)
    }
    throw new Error(`Hasgard socket did not appear within ${timeoutMs}ms: ${socketPath}`)
  }

  private async confirmEndpointOwnership(child: ChildProcess, path: string, timeoutMs: number): Promise<void> {
    const stat = await lstat(path)
    if (!stat.isSocket()) throw new Error(`Hasgard endpoint is not a socket: ${path}`)
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer)
        child.off("message", message)
        child.off("exit", exited)
        if (error) reject(error)
        else resolve()
      }
      const message = (value: { type?: string; message?: string }) => {
        if (value.type === "endpoint-owned") done()
        else if (value.type === "error") done(new Error(value.message))
      }
      const exited = () => done(new Error("Hasgard supervisor exited before acknowledging endpoint ownership"))
      const timer = setTimeout(
        () => done(new Error("Hasgard supervisor did not acknowledge endpoint ownership")),
        timeoutMs
      )
      child.on("message", message)
      child.once("exit", exited)
      child.send({ type: "endpoint", identity: { dev: stat.dev, ino: stat.ino } }, error => {
        if (error) done(error)
      })
    })
  }

  async stop(): Promise<void> {
    // A stop requested during startup must not return before a child is spawned.
    // Launch errors already perform cleanup and remain visible to both callers.
    if (this.starting) await this.starting
    if (this.stopping) return this.stopping
    this.stopping = this.stopChild()
    try {
      await this.stopping
    } finally {
      this.stopping = undefined
    }
  }

  private async stopChild(): Promise<void> {
    const child = this.child
    if (!child) return
    if (process.platform !== "win32") {
      // A launcher can exit before its application. Own the entire detached
      // process group until it is gone, even after the leader has exited.
      if (this.applicationPid !== undefined) {
        await stopProcessGroup(this.applicationPid)
      }
      const exited =
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>(resolve => child.once("exit", () => resolve()))
      if (child.connected) child.disconnect()
      const abort = new AbortController()
      try {
        if ((await Promise.race([exited, delay(11_000, "timeout", { signal: abort.signal })])) === "timeout") {
          throw new Error(`Hasgard process supervisor ${child.pid} did not finish cleanup`)
        }
      } finally {
        abort.abort()
      }
      this.child = undefined
      this.applicationPid = undefined
      if (child.exitCode !== 0 || child.signalCode !== null) {
        throw new Error(`Hasgard supervisor cleanup failed (${child.signalCode ?? child.exitCode}):\n${this.stderr}`)
      }
      return
    }
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      this.child = undefined
      return
    }
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()))
    if (process.platform === "win32" && child.pid !== undefined) {
      await terminateWindowsProcessTree(child.pid)
    } else if (child.pid !== undefined) {
      process.kill(-child.pid, "SIGTERM")
    }
    const abort = new AbortController()
    const timeout = delay(5_000, "timeout", { signal: abort.signal })
    try {
      if ((await Promise.race([exited, timeout])) === "timeout") {
        if (process.platform === "win32" && child.pid !== undefined) await terminateWindowsProcessTree(child.pid)
        else if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
        await exited
      }
    } finally {
      abort.abort()
    }
    this.child = undefined
  }
}

function appendOutput(previous: string, chunk: string): string {
  const output = previous + chunk
  return output.length > 65_536 ? `[earlier output truncated]\n${output.slice(-65_536)}` : output
}

async function endpointAcceptsConnections(path: string): Promise<boolean> {
  if (process.platform !== "win32") {
    try {
      if (!(await lstat(path)).isSocket()) throw new Error(`Hasgard endpoint exists but is not a socket: ${path}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  }
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ path })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", error => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ECONNREFUSED" || code === "EBUSY") {
        resolve(false)
        return
      }
      reject(error)
    })
  })
}

async function terminateWindowsProcessTree(pid: number): Promise<void> {
  const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" })
  await new Promise<void>((resolve, reject) => {
    taskkill.once("exit", () => resolve())
    taskkill.once("error", reject)
  })
}
