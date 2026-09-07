import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import os from "node:os"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { setTimeout as delay } from "node:timers/promises"
import { parseArgs } from "node:util"

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { rounds: { type: "string", default: "3" }, "latency-only": { type: "boolean", default: false } }
})
const [workArgument, outputArgument] = positionals
if (!workArgument || !outputArgument || positionals.length !== 2)
  throw new Error("Usage: node benchmarks/macos/run.mjs WORK_DIR OUTPUT_JSON [--rounds N] [--latency-only]")
const rounds = Number(values.rounds)
assert.ok(Number.isSafeInteger(rounds) && rounds > 0 && rounds % 3 === 0, "rounds must be a positive multiple of three")
if (process.platform !== "darwin") throw new Error("This benchmark requires a real macOS desktop session")
const work = resolve(workArgument)
const output = resolve(outputArgument)
const setup = JSON.parse(await readFile(join(work, "setup.json"), "utf8"))
const tools = ["hasgard", "pilot", "playwright"]
const result = {
  date: new Date().toISOString(),
  environment: {
    os: os.type(),
    release: os.release(),
    arch: os.arch(),
    cpu: os.cpus()[0].model,
    runtime: process.version,
    bun: process.versions.bun
  },
  revisions: setup.versions,
  cargoLockSha256: setup.cargoLockSha256,
  harnessSha256: Object.fromEntries(
    await Promise.all(
      ["setup.mjs", "run.mjs", "report.mjs"].map(async file => [
        file,
        createHash("sha256")
          .update(await readFile(new URL(file, import.meta.url)))
          .digest("hex")
      ])
    )
  ),
  binaries: Object.fromEntries(
    await Promise.all(
      tools.map(async name => [
        name,
        createHash("sha256")
          .update(await readFile(setup.binaries[name]))
          .digest("hex")
      ])
    )
  ),
  method: {
    rounds,
    latencyOnly: values["latency-only"],
    warmups: 5,
    samplesPerRound: 30,
    transport: "same sequential persistent Unix-socket harness for all tools; documented native plugin commands",
    includes: "request encoding, socket round-trip, plugin operation and result validation",
    excludes: "build, process launch, readiness, CLI process startup and high-level fixture overhead",
    ordering: "Latin-square rotation: hasgard/pilot/playwright, pilot/playwright/hasgard, playwright/hasgard/pilot"
  },
  samples: [],
  startups: [],
  capabilities: [],
  cleanup: []
}
await mkdir(dirname(output), { recursive: true })
await mkdir(join(work, "captures"), { recursive: true })

for (let round = 0; round < rounds; round++) {
  for (let offset = 0; offset < tools.length; offset++) {
    const tool = tools[(round + offset) % tools.length]
    const runtimeDir = await mkdtemp("/private/tmp/hgb-")
    const socketPath =
      tool === "pilot"
        ? join(runtimeDir, "tauri-pilot-dev.nyssance.hasgard-comparison.sock")
        : join(runtimeDir, `${tool}.sock`)
    assert.ok(Buffer.byteLength(socketPath) < 104, "macOS socket path exceeds sun_path capacity")
    let logs = ""
    const start = performance.now()
    const child = spawn(setup.binaries[tool], [], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: runtimeDir,
        BENCH_SOCKET: socketPath,
        TAURI_HASGARD_SOCKET: socketPath,
        TAURI_PILOT_SOCKET: socketPath
      }
    })
    const applicationPid = child.pid
    if (!Number.isSafeInteger(applicationPid) || applicationPid <= 1) throw new Error("Application failed to spawn")
    child.stdout.on("data", chunk => {
      logs = (logs + chunk).slice(-16_384)
    })
    child.stderr.on("data", chunk => {
      logs = (logs + chunk).slice(-16_384)
    })
    let client
    try {
      client = await connectReady(socketPath, child)
      const adapter = makeAdapter(tool, client)
      await webviewReady(adapter, "main", client)
      await webviewReady(adapter, "settings", client)
      result.startups.push({ round, tool, ms: performance.now() - start })
      await until(() => adapter.eval('window.__TAURI_INTERNALS__.invoke("benchmark_focus")'), 5_000)
      // Equal compositor settling time, outside the measured scenarios.
      // Stage Manager can otherwise expose an animating thumbnail to capture.
      await delay(1_000)
      const scenarios = {
        round_trip: async () => assert.equal(await adapter.eval("40 + 2"), 42),
        fill_click_read: async () => {
          await adapter.fill("#display-name", "Benchmark 界")
          await adapter.click("#save")
          assert.equal(await adapter.eval('document.querySelector("#status").value'), "Saved Benchmark 界")
        },
        html_dialog: async () => {
          await adapter.click("#open-dialog")
          assert.equal(await adapter.eval('document.querySelector("#confirm-dialog").open'), true)
          await adapter.click("#close-dialog")
          assert.equal(await adapter.eval('document.querySelector("#confirm-dialog").open'), false)
        },
        window_isolation: async () => {
          await adapter.eval('window.__bench = "main"')
          await adapter.eval('window.__bench = "settings"', "settings")
          assert.equal(await adapter.eval("window.__bench"), "main")
          assert.equal(await adapter.eval("window.__bench", "settings"), "settings")
        },
        unequal_content: async () => {
          const sizes = await adapter.eval(
            'Array.from(document.querySelectorAll("#turns article"), e => e.getBoundingClientRect().height)'
          )
          assert.equal(sizes.length, 80)
          assert.ok(Math.max(...sizes) > Math.min(...sizes))
        },
        error_diagnostic: async () => {
          await assert.rejects(adapter.eval('(() => { throw new Error("benchmark-probe") })()'), /benchmark-probe/)
        }
      }
      for (const [scenario, operation] of Object.entries(scenarios)) {
        for (let index = -5; index < 30; index++) {
          const began = performance.now()
          try {
            await operation()
            if (index >= 0)
              result.samples.push({ round, tool, scenario, index, ms: performance.now() - began, ok: true })
          } catch (error) {
            if (index >= 0)
              result.samples.push({
                round,
                tool,
                scenario,
                index,
                ms: performance.now() - began,
                ok: false,
                error: error.message
              })
            if (client.broken) throw error
          }
        }
      }
      if (values["latency-only"]) {
        result.capabilities.push({ round, tool, probe: "capability_probes", skipped: "latency-only replication" })
        console.log(`round ${round + 1}: ${tool} latency completed`)
        continue
      }
      // These APIs use different capture backends and image delivery contracts.
      // Record correctness and dimensions separately from common latency results.
      const expectedPixelWidth = await adapter.eval("window.innerWidth * window.devicePixelRatio")
      const path = join(work, "captures", `${tool}-${round}.png`)
      if (tool === "playwright") {
        const image = await client.call({ type: "native_screenshot", window: "main" }, tool, 30_000)
        await writeFile(path, Buffer.from(image.base64, "base64"))
      } else {
        const shot = await client.call({ method: "screenshot", params: { window: "main" } }, tool, 30_000)
        const value = shot
        assert.equal(typeof value, "string", "screenshot must return image data")
        assert.ok(value.startsWith("data:image/png;base64,"))
        await writeFile(path, Buffer.from(value.replace(/^data:image\/png;base64,/, ""), "base64"))
      }
      const image = await readFile(path)
      assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a")
      const width = image.readUInt32BE(16),
        height = image.readUInt32BE(20)
      assert.ok(width > 1 && height > 1)
      if (tool === "playwright")
        assert.ok(width >= expectedPixelWidth, "native capture is smaller than the expected window")
      result.capabilities.push({
        round,
        tool,
        probe: "screenshot",
        width,
        height,
        bytes: image.length,
        capture: tool === "playwright" ? "native window" : "DOM rasterization in native webview",
        path
      })
      if (tool !== "playwright") {
        try {
          const id =
            tool === "hasgard"
              ? (await client.call({ method: "windows.list" }, tool)).windows.find(window => window.label === "main")
                  .native_id
              : await adapter.eval('window.__TAURI_INTERNALS__.invoke("benchmark_window_id")')
          assert.ok(Number.isSafeInteger(id) && id > 0, "native window ID must be available")
          const nativePath = join(work, "captures", `${tool}-native-${round}.png`)
          const metadata = await client.call(
            { method: "screenshot_native", params: { window_id: id, output_path: nativePath } },
            tool,
            30_000
          )
          const png = await readFile(nativePath)
          assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a")
          assert.equal(png.readUInt32BE(16), metadata.width)
          assert.equal(png.readUInt32BE(20), metadata.height)
          assert.ok(
            metadata.width >= expectedPixelWidth && metadata.height > 1,
            "native capture is smaller than the expected window"
          )
          result.capabilities.push({
            round,
            tool,
            probe: "screenshot_native",
            discovery: tool === "hasgard" ? "plugin windows.list native_id" : "external fixture native-window helper",
            ...metadata
          })
        } catch (error) {
          result.capabilities.push({ round, tool, probe: "screenshot_native", error: error.message, data: error.data })
        }
      }
      // Native keyboard semantics are a capability probe, not a latency race:
      // playwright's press dispatches a synthetic DOM event (see upstream source).
      for (const key of ["Tab", "a"]) {
        if (tool === "pilot" && key === "a") {
          // Confirmed repeatedly on this macOS host: Enigo's layout lookup
          // runs on a Tokio worker and traps in HIToolbox. Preserve the prior
          // failure evidence without generating another crash-report dialog.
          result.capabilities.push({
            round,
            tool,
            probe: `keyboard_${key}`,
            skipped: "Known SIGTRAP: tauri-plugin-pilot calls Enigo keyboard-layout lookup off the main thread"
          })
          continue
        }
        try {
          await adapter.eval(
            '(() => { window.__keys=[]; document.addEventListener("keydown", e=>window.__keys.push({key:e.key,trusted:e.isTrusted}), {once:true}); document.querySelector("#display-name").type="password"; document.querySelector("#display-name").value=""; document.querySelector("#display-name").focus(); return true })()'
          )
          if (tool === "playwright")
            await client.call({ type: "press", window: "main", selector: "#display-name", key, timeout_ms: 1000 }, tool)
          else await client.call({ method: "press", params: { window: "main", key } }, tool)
          await until(async () => (await adapter.eval("window.__keys.length")) > 0, 2_000)
          result.capabilities.push({
            round,
            tool,
            probe: `keyboard_${key}`,
            events: await adapter.eval("window.__keys"),
            focusedElement: await adapter.eval("document.activeElement.id"),
            inputValue: await adapter.eval('document.querySelector("#display-name").value')
          })
        } catch (error) {
          result.capabilities.push({ round, tool, probe: `keyboard_${key}`, error: error.message })
        }
      }
      console.log(`round ${round + 1}: ${tool} completed`)
    } catch (error) {
      result.capabilities.push({ round, tool, probe: "run_error", error: error.message, logs })
      console.log(`round ${round + 1}: ${tool}: ${error.message}`)
    } finally {
      client?.close()
      try {
        if (applicationPid !== undefined) {
          // A closed transport may be a native crash. Capture its actual exit
          // signal before the harness sends its own termination signal.
          if (client?.broken)
            await until(() => child.exitCode !== null || child.signalCode !== null, 5_000).catch(error => {
              result.capabilities.push({ round, tool, probe: "exit_after_transport_loss", error: error.message })
            })
          result.capabilities.push({
            round,
            tool,
            probe: "application_exit_before_cleanup",
            code: child.exitCode,
            signal: child.signalCode
          })
          signal(applicationPid, "SIGTERM")
          await until(() => !alive(applicationPid), 5_000).catch(async () => {
            signal(applicationPid, "SIGKILL")
            await until(() => !alive(applicationPid), 5_000)
          })
          result.cleanup.push({
            round,
            tool,
            applicationExited: !alive(applicationPid),
            owner: "benchmark harness, not competitor fixture"
          })
        }
        await rm(runtimeDir, { recursive: true })
      } finally {
        await writeFile(output, JSON.stringify(result, null, 2))
      }
    }
  }
}

function makeAdapter(tool, client) {
  return {
    eval: (script, window = "main") =>
      client.call(
        tool === "playwright" ? { type: "eval", script, window } : { method: "eval", params: { window, script } },
        tool
      ),
    fill: (selector, text) =>
      client.call(
        tool === "playwright"
          ? { type: "fill", selector, text, window: "main", timeout_ms: 1000 }
          : { method: "fill", params: { selector, value: text, window: "main" } },
        tool
      ),
    click: selector =>
      client.call(
        tool === "playwright"
          ? { type: "click", selector, window: "main", timeout_ms: 1000 }
          : { method: "click", params: { selector, window: "main" } },
        tool
      )
  }
}

async function connectReady(path, child) {
  let socket
  await until(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("application exited during startup")
    socket = createConnection({ path })
    return new Promise((resolve, reject) => {
      socket.once("connect", () => resolve(true))
      socket.once("error", error => {
        socket.destroy()
        if (["ENOENT", "ECONNREFUSED"].includes(error.code)) resolve(false)
        else reject(error)
      })
    })
  }, 15_000)
  let pending
  let broken
  const fail = error => {
    broken = error
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      pending = undefined
    }
    socket.destroy()
  }
  socket.on("error", fail)
  socket.on("close", () => fail(new Error("RPC connection closed")))
  let id = 0
  const lines = createInterface({ input: socket })
  lines.on("line", line => {
    if (!pending) return
    const { resolve, reject, timer, tool, requestId } = pending
    clearTimeout(timer)
    pending = undefined
    try {
      const response = JSON.parse(line)
      if (tool === "playwright") {
        if (!response.ok) throw new Error(response.error)
        resolve(response.data)
      } else {
        if (response.error) throw Object.assign(new Error(response.error.message), { data: response.error.data })
        assert.equal(response.id, requestId)
        assert.equal(response.jsonrpc, "2.0")
        resolve(response.result)
      }
    } catch (error) {
      reject(error)
    }
  })
  return {
    get broken() {
      return broken !== undefined
    },
    call(request, tool, timeoutMs = 5_000) {
      if (broken) return Promise.reject(broken)
      assert.equal(pending, undefined, "sequential harness permits one in-flight request")
      const requestId = ++id
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error(`RPC response exceeded ${timeoutMs} ms`)), timeoutMs)
        pending = { resolve, reject, timer, tool, requestId }
        socket.write(
          JSON.stringify(tool === "playwright" ? request : { jsonrpc: "2.0", id: requestId, ...request }) + "\n"
        )
      })
    },
    close() {
      if (pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error("closed"))
        pending = undefined
      }
      lines.close()
      socket.destroy()
    }
  }
}

async function until(predicate, timeout) {
  const deadline = performance.now() + timeout
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error(`Condition not reached within ${timeout} ms`)
    await delay(20)
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === "ESRCH") return false
    throw error
  }
}

function signal(pid, value) {
  try {
    process.kill(-pid, value)
  } catch (error) {
    if (error.code !== "ESRCH") throw error
  }
}

async function webviewReady(adapter, window, client) {
  let lastError
  try {
    await until(async () => {
      try {
        return await adapter.eval('document.documentElement.dataset.hasgardReady === "true"', window)
      } catch (error) {
        if (client.broken) throw error
        lastError = error
        return false
      }
    }, 15_000)
  } catch (error) {
    throw new Error(`Webview ${window} did not become ready: ${lastError?.message ?? error.message}`, { cause: error })
  }
}
