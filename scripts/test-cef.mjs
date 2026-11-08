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
    socket.on("close", () => clearTimeout(timer))
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
  if (!["guest.html", "guest-next.html"].includes(name)) {
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
  await assert.rejects(rpc("console.getLogs", {}, "guest"), /not implemented/)
  await assert.rejects(rpc("ipc", { command: "close_guest" }, "guest"), /not implemented/)
  pass("unimplemented main-world operations fail explicitly")
  await rpc("fill", { selector: "#guest-input", value: "guest text" }, "guest")
  await rpc("click", { selector: "#increment" }, "guest")
  assert.equal(await evaluate("guest", 'document.querySelector("#count").textContent'), "1")
  await rpc("fill", { selector: "#second-input", value: "second text" }, "second")
  assert.equal(await evaluate("guest", 'document.querySelector("#guest-input").value'), "guest text")
  pass("DOM click and fill are isolated between windows")
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
        `from PIL import Image
import json,sys
out=[]
for path in sys.argv[1:]:
 im=Image.open(path).convert('RGB')
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
  writeFileSync(
    join(artifacts, "report.json"),
    JSON.stringify({ checks, windows, host, guest, whole, colors }, null, 2)
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
