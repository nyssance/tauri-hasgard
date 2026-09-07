import { fork, spawn } from "node:child_process"
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createConnection, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { HasgardProcess } from "./process-manager.js"

// These are real OS processes and sockets, testing lifecycle management only.
// Native webview behavior is covered by the fixture application's E2E suite.
describe.skipIf(process.platform === "win32")("Unix process lifecycle", () => {
  let directory: string
  let endpoint: string
  let manager: HasgardProcess
  const pids = new Set<number>()

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "hg-process-"))
    endpoint = join(directory, "app.sock")
    manager = new HasgardProcess()
  })

  afterEach(async () => {
    try {
      await manager.stop()
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        }
      }
      pids.clear()
      await rm(directory, { recursive: true, force: true })
    }
  })

  async function launch(source: string, timeoutMs = 2_000) {
    const script = join(directory, "app.cjs")
    await writeFile(script, source)
    return manager.start({ command: process.execPath, args: [script], cwd: directory, timeoutMs }, endpoint)
  }

  async function pidFrom(name = "pid"): Promise<number> {
    const pid = Number(await readFile(join(directory, name), "utf8"))
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
    pids.add(pid)
    return pid
  }

  const serving = `
    require("node:fs").writeFileSync("pid", String(process.pid));
    require("node:fs").rmSync(process.env.TAURI_HASGARD_SOCKET, { force: true });
    require("node:net").createServer(socket => socket.end()).listen(process.env.TAURI_HASGARD_SOCKET);
  `

  for (const target of ["worker", "supervisor"]) {
    test(`reaps a SIGTERM-resistant descendant after ${target} termination`, async () => {
      const stubborn = join(directory, "stubborn.cjs")
      const launcher = join(directory, "launcher.cjs")
      const worker = join(directory, "worker.cjs")
      await writeFile(stubborn, `process.on("SIGTERM", () => {}); ${serving}`)
      await writeFile(
        launcher,
        `require("node:child_process").spawn(process.execPath, [${JSON.stringify(stubborn)}], { stdio: "ignore" });`
      )
      const supervisor = fileURLToPath(new URL("./process-supervisor.js", import.meta.url))
      await writeFile(
        worker,
        `
      const child = require("node:child_process").fork(${JSON.stringify(supervisor)}, [], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      require("node:fs").writeFileSync("supervisor-pid", String(child.pid));
      child.send({command: process.execPath, args: [${JSON.stringify(launcher)}], cwd: process.cwd(), env: {...process.env, TAURI_HASGARD_SOCKET: ${JSON.stringify(endpoint)}}});
    `
      )
      const owner = spawn(process.execPath, [worker], { cwd: directory, stdio: "ignore" })
      if (owner.pid === undefined) throw new Error("worker failed to spawn")
      pids.add(owner.pid)
      await new HasgardProcess().waitForSocket(endpoint, 3_000)
      const appPid = await pidFrom()
      const supervisorPid = await pidFrom("supervisor-pid")
      process.kill(target === "worker" ? owner.pid : supervisorPid, target === "worker" ? "SIGKILL" : "SIGTERM")
      if (target === "supervisor") {
        await delay(100)
        process.kill(supervisorPid, "SIGTERM")
        process.kill(supervisorPid, "SIGINT")
      }
      await expect.poll(() => alive(appPid), { timeout: 8_000 }).toBe(false)
      await expect.poll(() => alive(supervisorPid), { timeout: 3_000 }).toBe(false)
      await expect.poll(() => alive(owner.pid as number)).toBe(false)
      await expect(lstat(endpoint)).rejects.toMatchObject({ code: "ENOENT" })
    }, 15_000)
  }

  test("stops, tolerates concurrent cleanup, and can launch again", async () => {
    await launch(serving)
    const firstPid = await pidFrom()
    await Promise.all([manager.stop(), manager.stop()])
    expect(alive(firstPid)).toBe(false)
    await expect(lstat(endpoint)).rejects.toMatchObject({ code: "ENOENT" })
    await launch(serving)
    const nextPid = await pidFrom()
    expect(nextPid).not.toBe(firstPid)
    await manager.stop()
    expect(alive(nextPid)).toBe(false)
  })

  test("endpoint permission loss during startup cannot prevent orphan termination", async () => {
    const socketDirectory = join(directory, "endpoint")
    await mkdir(socketDirectory)
    const app = join(directory, "permission-loss.cjs")
    await writeFile(
      app,
      `
      require("node:fs").writeFileSync("pid", String(process.pid));
      require("node:fs").chmodSync(${JSON.stringify(socketDirectory)}, 0);
      setInterval(() => {}, 1000);
    `
    )
    const supervisor = fork(fileURLToPath(new URL("./process-supervisor.js", import.meta.url)), [], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    })
    if (supervisor.pid === undefined) throw new Error("supervisor failed to spawn")
    pids.add(supervisor.pid)
    supervisor.send({
      command: process.execPath,
      args: [app],
      cwd: directory,
      env: { ...process.env, TAURI_HASGARD_SOCKET: join(socketDirectory, "app.sock") }
    })
    try {
      await expect.poll(() => readFile(join(directory, "pid"), "utf8")).toMatch(/^\d+$/)
      const pid = await pidFrom()
      // The supervisor's real lstat fails with EACCES. It must still stop the
      // application, even while endpoint metadata cannot be inspected.
      await expect.poll(() => alive(pid), { timeout: 3_000 }).toBe(false)
      // Even permanent endpoint permission loss must not leave the guardian alive.
      await expect.poll(() => alive(supervisor.pid as number), { timeout: 5_000 }).toBe(false)
      expect(supervisor.exitCode).toBe(1)
    } finally {
      await chmod(socketDirectory, 0o700)
      if (supervisor.connected) supervisor.disconnect()
    }
    await expect.poll(() => alive(supervisor.pid as number), { timeout: 3_000 }).toBe(false)
  }, 10_000)

  test("stop reports permanent endpoint cleanup failure after reaping the application", async () => {
    const socketDirectory = join(directory, "endpoint")
    await mkdir(socketDirectory)
    endpoint = join(socketDirectory, "app.sock")
    await launch(serving)
    const pid = await pidFrom()
    await chmod(socketDirectory, 0)
    try {
      await expect(manager.stop()).rejects.toThrow(/supervisor cleanup failed/)
      expect(alive(pid)).toBe(false)
    } finally {
      await chmod(socketDirectory, 0o700)
    }
    await manager.stop()
  })

  test("a spawn error does not poison the next launch", async () => {
    await expect(
      manager.start({ command: join(directory, "missing"), args: [], cwd: directory, timeoutMs: 500 }, endpoint)
    ).rejects.toThrow(/ENOENT/)
    await launch(serving)
    await pidFrom()
  })

  test("cleanup preserves a replacement file and another application's socket", async () => {
    await launch(serving)
    await rm(endpoint)
    await writeFile(endpoint, "belongs to another owner")
    await manager.stop()
    expect(await readFile(endpoint, "utf8")).toBe("belongs to another owner")
    await rm(endpoint)
    await launch(serving)
    await rm(endpoint)
    const replacement = createServer(socket => socket.end())
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject)
      replacement.listen(endpoint, resolve)
    })
    try {
      await manager.stop()
      await new Promise<void>((resolve, reject) => {
        const client = createConnection(endpoint)
        client.once("error", reject)
        client.once("connect", () => {
          client.destroy()
          resolve()
        })
      })
    } finally {
      await new Promise<void>((resolve, reject) => replacement.close(error => (error ? reject(error) : resolve())))
    }
  })

  test("retains the actual crash signal and stderr after readiness", async () => {
    await launch(
      `${serving}\nprocess.on("SIGUSR1", () => { process.stderr.write("application crash marker\\n", () => process.kill(process.pid, "SIGTRAP")); });`
    )
    const pid = await pidFrom()
    process.kill(pid, "SIGUSR1")
    const diagnostics = await manager.diagnostics(2_000)
    expect(diagnostics.exit).toEqual({ code: null, signal: "SIGTRAP" })
    expect(diagnostics.stderr).toContain("application crash marker")
  })

  test("rejects a concurrent launch and honors stop requested during startup", async () => {
    const script = join(directory, "app.cjs")
    await writeFile(script, serving)
    const config = { command: process.execPath, args: [script], cwd: directory, timeoutMs: 2_000 }
    const started = manager.start(config, endpoint)
    await expect(manager.start(config, endpoint)).rejects.toThrow(/already running/)
    const stopped = manager.stop()
    await started
    const pid = await pidFrom()
    await stopped
    expect(alive(pid)).toBe(false)
  })

  test("refuses to unlink the endpoint of a running application", async () => {
    await launch(serving)
    const pid = await pidFrom()
    const other = new HasgardProcess()
    await expect(
      other.start({ command: process.execPath, args: [], cwd: directory, timeoutMs: 500 }, endpoint)
    ).rejects.toThrow(/already in use/)
    expect(alive(pid)).toBe(true)
    await manager.waitForSocket(endpoint, 500)
  })

  test("bounds startup diagnostics and resets them between launches", async () => {
    await expect(launch('process.stderr.write("x".repeat(200000) + "LOG-END", () => process.exit(1))')).rejects.toThrow(
      /earlier output truncated[\s\S]*LOG-END/
    )
    await expect(launch("process.exit(2)")).rejects.toThrow("Tauri process exited with code 2\nstdout:\n\nstderr:\n")
  })

  test("retains ownership after a cleanup error so stop can be retried", async () => {
    await launch(serving)
    const pid = await pidFrom()
    const kill = process.kill.bind(process)
    const signal = vi.spyOn(process, "kill").mockImplementation((target, kind) => {
      if (target === -pid && kind === "SIGTERM") throw Object.assign(new Error("signal denied"), { code: "EPERM" })
      return kill(target, kind)
    })
    try {
      await expect(manager.stop()).rejects.toMatchObject({ code: "EPERM" })
      expect(alive(pid)).toBe(true)
      await expect(launch(serving)).rejects.toThrow(/already running/)
    } finally {
      signal.mockRestore()
    }
    await manager.stop()
    expect(alive(pid)).toBe(false)
    await launch(serving)
    await pidFrom()
  })

  test("startup timeout terminates the launched process", async () => {
    await expect(
      launch('require("node:fs").writeFileSync("pid", String(process.pid)); setInterval(() => {}, 1000)', 3_000)
    ).rejects.toThrow(/socket did not appear/)
    expect(alive(await pidFrom())).toBe(false)
  }, 10_000)

  test("reports a startup signal immediately and permits another launch", async () => {
    await expect(launch('process.kill(process.pid, "SIGTERM")')).rejects.toThrow(/signal SIGTERM/)
    await launch(serving)
    await pidFrom()
  })

  test("does not treat a regular file as a ready socket", async () => {
    await expect(
      launch(
        'require("node:fs").writeFileSync(process.env.TAURI_HASGARD_SOCKET, "not a socket"); setInterval(() => {}, 1000)',
        3_000
      )
    ).rejects.toThrow(/exists but is not a socket/)
  })

  test("cleans descendants after their launcher has already exited", async () => {
    const childScript = join(directory, "child.cjs")
    await writeFile(childScript, serving)
    await launch(`
      process.on("SIGTERM", () => process.exit(0));
      require("node:fs").writeFileSync("launcher-pid", String(process.pid));
      const child = require("node:child_process").spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "ignore" });
      child.unref();
      setInterval(() => {}, 1000);
    `)
    const childPid = await pidFrom()
    const launcherPid = await pidFrom("launcher-pid")
    process.kill(launcherPid, "SIGTERM")
    await expect.poll(() => alive(launcherPid)).toBe(false)
    expect(alive(childPid)).toBe(true)
    await manager.stop()
    expect(alive(childPid)).toBe(false)
    await launch(serving)
    await pidFrom()
  })

  test("escalates when a descendant ignores SIGTERM after the launcher exits", async () => {
    const childScript = join(directory, "stubborn.cjs")
    await writeFile(childScript, `process.on("SIGTERM", () => {}); ${serving}`)
    await launch(`
      require("node:child_process").spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "ignore" });
    `)
    const pid = await pidFrom()
    const stopped = manager.stop()
    await delay(100)
    expect(alive(pid)).toBe(true)
    await stopped
    expect(alive(pid)).toBe(false)
  }, 15_000)
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}
