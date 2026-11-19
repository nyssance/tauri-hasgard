// Native CEF E2E. Build examples/cef-fixture-app with `tauri build --debug --bundles app` first.
// Local runs use the secondary display; CI may explicitly select 0.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const executable =
  process.argv[2] ??
  join(root, "target/debug/bundle/macos/Hasgard CEF Fixture.app/Contents/MacOS/tauri-hasgard-cef-fixture")
const artifacts = resolve(process.env.HASGARD_CEF_OUTPUT ?? join(root, "test-results/cef"))
mkdirSync(artifacts, { recursive: true })
rmSync(join(artifacts, "report.json"), { force: true })
const temp = mkdtempSync(join(tmpdir(), "hg-cef-"))
const socketPath = join(temp, "app.sock")
let sequence = 0
function rpc(method, params = {}, window) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ""
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`${method} RPC timed out`))
    }, 20000)
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: ++sequence,
          method,
          params: { ...params, ...(window ? { window } : {}) }
        }) + "\n"
      )
    )
    socket.on("error", reject)
    socket.on("close", () => {
      clearTimeout(timer)
      if (!buffer.includes("\n")) reject(new Error("RPC connection closed before reply"))
    })
    socket.on("data", (chunk) => {
      buffer += chunk
      if (!buffer.includes("\n")) return
      socket.end()
      const response = JSON.parse(buffer.slice(0, buffer.indexOf("\n")))
      if (response.error) reject(new Error(JSON.stringify(response.error)))
      else resolve(response.result)
    })
  })
}
const evaluate = (window, script) => rpc("eval", { script }, window)
async function until(check, label, ms = 20000) {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    try {
      const result = await check()
      if (result) return result
    } catch (e) {
      last = e
    }
    await sleep(100)
  }
  throw new Error(`${label}: ${last ?? "condition not met"}`)
}
const server = createServer((req, res) => {
  const name = req.url?.split("?")[0]?.slice(1)
  if (!["guest.html", "guest-next.html", "guest-frame.html"].includes(name)) {
    res.writeHead(404).end()
    return
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.end(readFileSync(join(root, "examples/cef-fixture-app/ui", name)))
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const guestUrl = `http://127.0.0.1:${server.address().port}/guest.html`
const app = spawn(executable, [], {
  env: {
    ...process.env,
    TAURI_HASGARD_DISPLAY: process.env.TAURI_HASGARD_DISPLAY ?? "secondary",
    TAURI_HASGARD_SOCKET: socketPath,
    HASGARD_CEF_GUEST_URL: guestUrl,
    HASGARD_CEF_PROFILE: join(temp, "cef-profile")
  },
  detached: true,
  stdio: ["ignore", "pipe", "pipe"]
})
let log = ""
app.stdout.on("data", (value) => {
  log += value
})
app.stderr.on("data", (value) => {
  log += value
})
app.on("error", (error) => {
  log += error.stack
})
const checks = []
const executorPids = new Set()
function collectExecutors() {
  const processes = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).trim().split("\n")
  for (const line of processes) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (match && Number(match[2]) === app.pid && match[3].includes("hasgard-playwright"))
      executorPids.add(Number(match[1]))
  }
}
const pass = (text) => {
  checks.push(text)
  console.log(`PASS ${text}`)
}
try {
  await until(async () => {
    if (app.exitCode !== null) throw new Error(`App exited ${app.exitCode}: ${log}`)
    return (await evaluate("main", "document.readyState")) === "complete"
  }, "Host readiness")
  await rpc("click", { selector: "#recreate" }, "main")
  await until(async () => (await evaluate("guest", "document.title")) === "CEF Guest", "Guest readiness")
  const windows = (await rpc("windows.list")).windows
  assert.deepEqual(windows.map((w) => w.label).sort(), ["guest", "main", "second"])
  assert.equal(windows.find((w) => w.label === "guest").window_label, "main")
  assert.equal(windows.find((w) => w.label === "guest").native_id, windows.find((w) => w.label === "main").native_id)
  pass("window and child-webview routing")
  assert.equal(await evaluate("guest", "typeof window.__TAURI_INTERNALS__"), "undefined")
  assert.equal(await evaluate("guest", "document.body.scrollHeight > 1500"), true)
  assert.equal(await evaluate("second", "document.body.scrollHeight < 1500"), true)
  pass("remote guest requires no Tauri IPC; unequal document heights")
  // Written while the page loaded, before any automation request reached this webview.
  // CDP replays such messages without object previews, so the object is its description.
  const loaded = await rpc("console.getLogs", {}, "guest")
  assert.deepEqual(
    loaded.map(({ level, args }) => ({ level, args })),
    [{ level: "warn", args: ["guest loaded", "Object"] }]
  )
  assert.match(loaded[0].source, /guest\.html:\d+:\d+$/)
  assert.deepEqual(await rpc("console.getLogs", {}, "second"), [])
  await assert.rejects(rpc("network.getRequests", {}, "guest"), /not implemented/)
  await assert.rejects(rpc("ipc", { command: "close_guest" }, "guest"), /unavailable|not allowed|denied/i)
  const escaped = '";throw new Error("injected");//\n中文'
  assert.equal(await rpc("ipc", { command: "ipc_echo", args: { value: escaped } }, "main"), `main:${escaped}`)
  assert.equal(await rpc("ipc", { command: "ipc_echo", args: { value: "second" } }, "second"), "second:second")
  await assert.rejects(rpc("ipc", { command: "ipc_echo", args: { value: "reject" } }, "main"), /fixture rejection/)
  await assert.rejects(rpc("ipc", { command: "not_a_command" }, "main"), /not found/i)
  await assert.rejects(
    rpc("ipc", { command: "plugin:window|set_title", args: { label: "second", title: "forbidden" } }, "main"),
    /not allowed|denied/i
  )
  pass("CEF IPC: real command results, window routing, escaped arguments, rejection and capability enforcement")
  await rpc("ipc", { command: "set_floating", args: { enabled: true } }, "second")
  const floating = await rpc(
    "screenshot_native",
    { window_id: windows.find((w) => w.label === "second").native_id, output_path: join(artifacts, "floating.png") },
    "second"
  )
  assert.ok(floating.width > 0 && floating.height > 0)
  await rpc("ipc", { command: "set_floating", args: { enabled: false } }, "second")
  pass("explicit native screenshot captures an always-on-top window")
  pass("unimplemented main-world operations fail explicitly")
  await rpc("fill", { selector: "#guest-input", value: "guest text" }, "guest")
  await rpc("click", { selector: "#increment" }, "guest")
  assert.equal(await evaluate("guest", 'document.querySelector("#count").textContent'), "1")
  await rpc("fill", { selector: "#second-input", value: "second text" }, "second")
  assert.equal(await evaluate("guest", 'document.querySelector("#guest-input").value'), "guest text")
  pass("DOM click and fill are isolated between windows")
  collectExecutors()
  assert.ok(executorPids.size >= 3, "Each exercised native view must use its packaged Playwright executor")
  await rpc("click", { selector: "#trusted" }, "guest")
  // The click reply and this read travel on separate CDP clients; the handler may not have run yet.
  await until(
    async () => (await evaluate("guest", 'document.querySelector("#trusted-result").textContent')) === "true",
    "Trusted click on #trusted"
  )
  // Attaching the Playwright executor re-enables the Runtime domain, which replays old messages.
  const clicked = await rpc("console.getLogs", {}, "guest")
  assert.deepEqual(
    clicked.map(({ id, level, args }) => ({ id, level, args })),
    [
      { id: 1, level: "warn", args: ["guest loaded", "Object"] },
      { id: 2, level: "log", args: ["trusted click", { trusted: true }] }
    ]
  )
  assert.deepEqual(
    (await rpc("console.getLogs", { level: "log" }, "guest")).map(({ id }) => id),
    [2]
  )
  assert.deepEqual(
    (await rpc("console.getLogs", { sinceId: 1 }, "guest")).map(({ id }) => id),
    [2]
  )
  assert.deepEqual(await rpc("console.clear", {}, "guest"), { cleared: true })
  assert.deepEqual(await rpc("console.getLogs", {}, "guest"), [])
  await rpc("click", { selector: "#trusted" }, "guest")
  await until(async () => (await rpc("console.getLogs", {}, "guest")).length === 1, "Console after clear")
  assert.deepEqual((await rpc("console.getLogs", {}, "guest"))[0].args, ["trusted click", { trusted: true }])
  pass("CEF console: load-time output, live object previews, replay without duplicates, filters, clear and isolation")
  await rpc("fill", { selector: "#editor", value: "Replacement draft" }, "guest")
  assert.equal(await evaluate("guest", 'document.querySelector("#editor").textContent'), "Replacement draft")
  await rpc("check", { selector: "#checked", checked: true }, "guest")
  await rpc("check", { selector: "#checked", checked: true }, "guest")
  assert.equal(await evaluate("guest", 'document.querySelector("#checked").checked'), true)
  await rpc("select", { selector: "#choice", value: "Beta" }, "guest")
  assert.equal(await evaluate("guest", 'document.querySelector("#choice").value'), "b")
  await assert.rejects(
    rpc("click", { selector: "#covered", timeout: 300 }, "guest"),
    /intercepts pointer events|Timeout/
  )
  assert.notEqual(await evaluate("guest", 'document.body.dataset.coveredClicked === "true"'), true)
  await evaluate("guest", 'setTimeout(()=>document.querySelector("#delayed").disabled=false,350);null')
  await rpc("click", { selector: "#delayed" }, "guest")
  // The click reply and this read travel on separate CDP clients; the handler may not have run yet.
  await until(
    async () => (await evaluate("guest", 'document.querySelector("#delayed-result").textContent')) === "true",
    "Trusted click on #delayed"
  )
  const referenced = await rpc("query", { by: "selector", value: "#trusted" }, "guest")
  await rpc("click", { ref: referenced.elements[0].ref }, "guest")
  assert.equal(await evaluate("guest", 'document.querySelectorAll("[data-hasgard-action]").length'), 0)
  pass("Playwright trusted input, rich text replacement, idempotent check, select label, actionability and references")
  await rpc("click", { selector: "#shadow-button" }, "guest")
  assert.equal(await evaluate("guest", "document.body.dataset.shadowTrusted"), "true")
  await rpc("fill", { frame: "#foreign-frame", selector: "#frame-input", value: "Cross-origin draft" }, "guest")
  await rpc("click", { frame: "#foreign-frame", selector: "#frame-save" }, "guest")
  await until(
    async () => (await evaluate("guest", "document.body.dataset.frameValue")) === "Cross-origin draft",
    "Frame save"
  )
  assert.equal(await evaluate("guest", "document.body.dataset.frameTrusted"), "true")
  await rpc("click", { frame: "#foreign-frame", x: 30, y: 25, modifiers: ["Shift"] }, "guest")
  await until(
    async () => (await evaluate("guest", "document.body.dataset.frameShift")) === "true",
    "Frame-relative modified click"
  )
  pass("Playwright open shadow root and cross-origin frame input")
  await rpc("focus", { selector: "#guest-input" }, "guest")
  await rpc("press", { key: "End" }, "guest")
  await rpc("press", { key: "x" }, "guest")
  assert.match(await evaluate("guest", 'document.querySelector("#guest-input").value'), /x/)
  assert.equal(await evaluate("second", 'document.querySelector("#second-input").value'), "second text")
  pass("native keyboard reaches the selected child only")
  await rpc("navigate", { url: guestUrl.replace("guest.html", "guest-next.html") }, "guest")
  await until(async () => (await evaluate("guest", "document.title")) === "CEF Guest Next", "navigation")
  await rpc("fill", { selector: "#next-input", value: "after navigation" }, "guest")
  assert.equal(await evaluate("guest", 'document.querySelector("#next-input").value'), "after navigation")
  pass("new document reconnects after navigation")
  await rpc("click", { selector: "#close" }, "main")
  await until(async () => !(await rpc("windows.list")).windows.some((w) => w.label === "guest"), "child close")
  await assert.rejects(evaluate("guest", "document.title"), /not found/)
  await rpc("click", { selector: "#recreate" }, "main")
  await until(async () => (await evaluate("guest", "document.title")) === "CEF Guest", "same-label recreation")
  assert.equal(await evaluate("guest", 'document.querySelector("#count").textContent'), "0")
  pass("closed child errors explicitly and same-label recreation uses a fresh browser")
  // Bring main to the front without opening its overlay yet.
  await rpc("focus", { selector: "#host-input" }, "main")
  await rpc("click", { selector: "#modal" }, "main")
  assert.equal(await evaluate("main", 'document.querySelector("#dialog").open'), true)
  await rpc("snapshot", {}, "main")
  const host = await rpc("screenshot_native", { output_path: join(artifacts, "host-page.png") }, "main")
  const guest = await rpc("screenshot_native", { output_path: join(artifacts, "guest-page.png") }, "guest")
  const whole = await rpc("screenshot_native", {
    output_path: join(artifacts, "whole-window.png"),
    window_id: windows.find((w) => w.label === "main").native_id
  })
  assert.equal(host.backend, "cef-cdp")
  assert.equal(guest.backend, "cef-cdp")
  // Screen pixels, not DOM existence, establish the native occlusion result.
  const colors = JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        `from PIL import Image,ImageCms
from io import BytesIO
import json,sys
out=[]
for path in sys.argv[1:]:
 im=Image.open(path)
 profile=im.info.get('icc_profile')
 im=ImageCms.profileToProfile(im,ImageCms.ImageCmsProfile(BytesIO(profile)),ImageCms.createProfile('sRGB'),outputMode='RGB') if profile else im.convert('RGB')
 colors=list(im.getdata())
 out.append({'pink':sum(r>230 and 40<g<100 and b>170 for r,g,b in colors),'green':sum(r<50 and g>140 and 60<b<150 for r,g,b in colors)})
print(json.dumps(out))`,
        join(artifacts, "host-page.png"),
        join(artifacts, "whole-window.png")
      ],
      { encoding: "utf8" }
    )
  )
  assert.ok(colors[0].pink > 1000, `Host page should contain modal: ${JSON.stringify(colors)}`)
  assert.ok(
    colors[1].green > 1000 && colors[1].pink < 100,
    `Whole window must show native child occluding modal: ${JSON.stringify(colors)}`
  )
  pass("single-page vs whole-window screenshots reproduce native modal occlusion")
  await rpc("click", { selector: "#dismiss" }, "main")
  // Exiting can destroy the initiating document before its IPC response arrives.
  // The process result, rather than transport delivery, establishes clean shutdown.
  let shutdownResponse = null
  await rpc("ipc", { command: "quit_fixture" }, "main").catch((error) => {
    shutdownResponse = String(error)
  })
  await until(() => app.exitCode !== null || app.signalCode !== null, "Graceful exit", 10000)
  assert.equal(app.exitCode, 0, `Unexpected shutdown: ${app.signalCode}: ${shutdownResponse}`)
  assert.equal(app.signalCode, null)
  await until(
    () =>
      [...executorPids].every((pid) => {
        try {
          process.kill(pid, 0)
          return false
        } catch (error) {
          if (error.code === "ESRCH") return true
          throw error
        }
      }),
    "Executor process cleanup",
    5000
  )
  assert.doesNotMatch(log, /FATAL:|panicked at/)
  pass("graceful IPC shutdown exits 0 and reaps Playwright executors")
  writeFileSync(
    join(artifacts, "report.json"),
    JSON.stringify({ checks, windows, host, guest, whole, colors, exitCode: app.exitCode, shutdownResponse }, null, 2)
  )
} catch (error) {
  writeFileSync(
    join(artifacts, "report.json"),
    JSON.stringify({ status: "failed", checks, error: String(error) }, null, 2)
  )
  for (const label of ["second", "guest"]) {
    try {
      console.error(label, await evaluate(label, "({url:location.href,title:document.title})"))
    } catch (diagnostic) {
      console.error(label, String(diagnostic))
    }
  }
  throw error
} finally {
  if (app.exitCode === null && app.signalCode === null) process.kill(-app.pid, "SIGTERM")
  if (app.exitCode === null && app.signalCode === null)
    await Promise.race([new Promise((resolve) => app.once("exit", resolve)), sleep(5000)])
  if (app.exitCode === null && app.signalCode === null) {
    process.kill(-app.pid, "SIGKILL")
    await sleep(300)
  }
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  writeFileSync(join(artifacts, "app.log"), log)
  rmSync(temp, { recursive: true, force: true })
}
assert.ok(app.exitCode !== null || app.signalCode !== null, "fixture process must exit")
rmSync(temp, { recursive: true, force: true })
assert.equal(existsSync(socketPath), false)
pass("process and socket cleanup")

const finalReport = JSON.parse(readFileSync(join(artifacts, "report.json"), "utf8"))
writeFileSync(
  join(artifacts, "report.json"),
  JSON.stringify(
    { ...finalReport, status: "passed", checks, exitCode: app.exitCode, signalCode: app.signalCode },
    null,
    2
  )
)
