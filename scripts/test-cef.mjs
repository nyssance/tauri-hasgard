// Native CEF E2E, run with Bun on macOS and Windows.
// Build examples/cef-fixture-app first: `tauri build --debug --bundles app` on macOS, `--no-bundle` on Windows.
// Local runs use the secondary display; CI may explicitly select 0.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

// Launch, endpoint and transport come from the Playwright package, which already
// handles Unix sockets and named pipes, process groups and Windows process trees.
import { hasgardEndpointPath, HasgardProcess, HasgardRpcClient } from "../packages/playwright/src/index.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const mac = process.platform === "darwin"
if (!mac && process.platform !== "win32") throw new Error("The CEF native test runs on macOS and Windows")
const executable =
  process.argv[2] ??
  (mac
    ? join(root, "target/debug/bundle/macos/Hasgard CEF Fixture.app/Contents/MacOS/tauri-hasgard-cef-fixture")
    : join(root, "target/debug/tauri-hasgard-cef-fixture.exe"))
const artifacts = resolve(process.env.HASGARD_CEF_OUTPUT ?? join(root, "test-results/cef"))
mkdirSync(artifacts, { recursive: true })
rmSync(join(artifacts, "report.json"), { force: true })
const temp = mkdtempSync(join(tmpdir(), "hg-cef-"))
const socketPath = hasgardEndpointPath(`hg-cef-${process.pid}`)
// An unbundled Windows build has no CEF beside it: `libcef.dll` and the resources it loads
// from its own directory stay in the CEF download. Put that directory on the search path.
const launchEnv = {}
if (!mac) {
  const cefRoot = resolve(process.env.CEF_PATH ?? join(root, "target/cef-cache"))
  const found = []
  const visit = (directory, depth) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === "libcef.dll") found.push(directory)
      else if (entry.isDirectory() && depth < 3) visit(join(directory, entry.name), depth + 1)
    }
  }
  visit(cefRoot, 0)
  if (found.length !== 1) throw new Error(`Expected one libcef.dll under ${cefRoot}, found ${found.length}`)
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH")
  if (!pathKey) throw new Error("The environment has no PATH")
  launchEnv[pathKey] = `${found[0]};${process.env[pathKey]}`
}
const app = new HasgardProcess()
const client = new HasgardRpcClient(socketPath)
const rpc = (method, params = {}, window) => client.call(method, { ...params, ...(window ? { window } : {}) })
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
  if (name === "echo") {
    res.setHeader("Content-Type", "text/plain")
    res.end("echoed")
    return
  }
  if (!["guest.html", "guest-next.html", "guest-frame.html"].includes(name)) {
    res.writeHead(404).end()
    return
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.end(readFileSync(join(root, "examples/cef-fixture-app/ui", name)))
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const guestUrl = `http://127.0.0.1:${server.address().port}/guest.html`
const exit = async (waitMs = 0) => (await app.diagnostics(waitMs)).exit
const appLog = async () => {
  const { stdout, stderr } = await app.diagnostics()
  return stdout + stderr
}
const checks = []
let exited
const executorPids = new Set()
async function collectExecutors() {
  const { pid } = await app.diagnostics()
  // One line per process: pid, parent pid, name.
  const processes = mac
    ? execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" })
    : execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'
        ],
        { encoding: "utf8" }
      )
  for (const line of processes.trim().split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (match && Number(match[2]) === pid && match[3].includes("hasgard-playwright")) executorPids.add(Number(match[1]))
  }
}
const pass = (text) => {
  checks.push(text)
  console.log(`PASS ${text}`)
}
try {
  await app.start(
    {
      command: executable,
      args: [],
      cwd: root,
      timeoutMs: 60_000,
      env: {
        ...launchEnv,
        TAURI_HASGARD_DISPLAY: process.env.TAURI_HASGARD_DISPLAY ?? "secondary",
        HASGARD_CEF_GUEST_URL: guestUrl,
        HASGARD_CEF_PROFILE: join(temp, "cef-profile"),
        HASGARD_CEF_LOG: join(artifacts, "cef.log")
      }
    },
    socketPath
  )
  await client.connect(20_000)
  await until(async () => {
    const exited = await exit()
    if (exited) throw new Error(`App exited ${exited.code ?? exited.signal}: ${await appLog()}`)
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
  await assert.rejects(rpc("dialog.list", {}, "guest"), /not implemented/)
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
  // Whole-window capture exists on macOS only.
  if (mac) {
    await rpc("ipc", { command: "set_floating", args: { enabled: true } }, "second")
    const floating = await rpc(
      "screenshot_native",
      { window_id: windows.find((w) => w.label === "second").native_id, output_path: join(artifacts, "floating.png") },
      "second"
    )
    assert.ok(floating.width > 0 && floating.height > 0)
    await rpc("ipc", { command: "set_floating", args: { enabled: false } }, "second")
    pass("explicit native screenshot captures an always-on-top window")
  } else {
    await assert.rejects(rpc("screenshot_native", { output_path: join(artifacts, "unsupported.png") }, "second"), {
      code: -32601
    })
    pass("native screenshot is reported as unsupported on this platform")
  }
  pass("unimplemented main-world operations fail explicitly")
  await rpc("fill", { selector: "#guest-input", value: "guest text" }, "guest")
  await rpc("click", { selector: "#increment" }, "guest")
  assert.equal(await evaluate("guest", 'document.querySelector("#count").textContent'), "1")
  await rpc("fill", { selector: "#second-input", value: "second text" }, "second")
  assert.equal(await evaluate("guest", 'document.querySelector("#guest-input").value'), "guest text")
  pass("DOM click and fill are isolated between windows")
  await collectExecutors()
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
  await rpc("network.clear", {}, "guest")
  await evaluate(
    "guest",
    `fetch("/echo",{method:"POST",body:"abcd"});fetch("/missing");fetch("http://127.0.0.1:1/refused").catch(()=>{});
     const x=new XMLHttpRequest();x.open("GET","/echo?xhr=1");x.send();null`
  )
  await until(async () => (await rpc("network.getRequests", {}, "guest")).length === 4, "CEF network requests")
  const requests = await rpc("network.getRequests", {}, "guest")
  const request = (part) => requests.find(({ url }) => url.includes(part))
  assert.deepEqual(
    (({ method, status, error, request_size, response_size }) => ({
      method,
      status,
      error,
      request_size,
      response_size
    }))(requests.find(({ method }) => method === "POST") ?? {}),
    { method: "POST", status: 200, error: null, request_size: 4, response_size: 6 }
  )
  assert.equal(request("/missing").status, 404)
  assert.equal(request("/refused").status, 0)
  assert.match(request("/refused").error, /ERR_/)
  assert.equal(request("xhr=1").method, "GET")
  assert.ok(requests.every(({ id, timestamp, duration_ms }) => id > 0 && timestamp > 1e12 && duration_ms >= 0))
  assert.deepEqual(
    (await rpc("network.getRequests", { failedOnly: true }, "guest")).map(({ url }) => new URL(url).pathname).sort(),
    ["/missing", "/refused"]
  )
  assert.equal((await rpc("network.getRequests", { filter: "xhr=1" }, "guest")).length, 1)
  // Each webview keeps its own log; this one holds only its own Tauri IPC fetches.
  assert.ok(
    (await rpc("network.getRequests", {}, "second")).every(({ url }) => url.startsWith("http://ipc.localhost/"))
  )
  assert.deepEqual(await rpc("network.clear", {}, "guest"), { cleared: true })
  assert.deepEqual(await rpc("network.getRequests", {}, "guest"), [])
  pass("CEF network: fetch and XHR outcomes, sizes, failures, filters, clear and isolation")
  assert.deepEqual(
    await rpc(
      "route.add",
      {
        pattern: "**/echo",
        method: "post",
        status: 201,
        body: '{"routed":true}',
        contentType: "application/json",
        times: 1
      },
      "guest"
    ),
    { id: 1, pattern: "**/echo", action: "fulfill" }
  )
  await rpc("route.add", { pattern: "**/blocked", action: "abort" }, "guest")
  const dataset = (name) => evaluate("guest", `document.body.dataset.${name}`)
  await evaluate(
    "guest",
    `fetch("/echo",{method:"POST"}).then(async r=>{document.body.dataset.routed=r.status+":"+r.headers.get("content-type")+":"+await r.text()});
     fetch("/blocked").catch(()=>{document.body.dataset.blocked="failed"});
     fetch("/echo?unrouted").then(r=>r.text()).then(t=>{document.body.dataset.passed=t});null`
  )
  await until(
    async () => (await dataset("routed")) && (await dataset("blocked")) && (await dataset("passed")),
    "CEF routes"
  )
  assert.equal(await dataset("routed"), '201:application/json:{"routed":true}')
  assert.equal(await dataset("blocked"), "failed")
  assert.equal(await dataset("passed"), "echoed")
  // The single-use rule is spent; the same request now reaches the server.
  await evaluate(
    "guest",
    `fetch("/echo",{method:"POST"}).then(r=>r.text()).then(t=>{document.body.dataset.spent=t});null`
  )
  await until(() => dataset("spent"), "Spent route")
  assert.equal(await dataset("spent"), "echoed")
  const routed = await rpc("route.list", {}, "guest")
  assert.deepEqual(
    routed.routes.map(({ id, method, action, status, times, used }) => ({ id, method, action, status, times, used })),
    [
      { id: 1, method: "POST", action: "fulfill", status: 201, times: 1, used: 1 },
      { id: 2, method: null, action: "abort", status: 200, times: null, used: 1 }
    ]
  )
  assert.deepEqual(
    routed.intercepted
      .map(({ route_id, action, status, url }) => ({ route_id, action, status, path: new URL(url).pathname }))
      .sort((a, b) => a.route_id - b.route_id),
    [
      { route_id: 1, action: "fulfill", status: 201, path: "/echo" },
      { route_id: 2, action: "abort", status: 0, path: "/blocked" }
    ]
  )
  // A catch-all on the Tauri page must not swallow the application's own commands.
  await rpc("route.add", { pattern: "**", action: "abort" }, "main")
  assert.equal(await rpc("ipc", { command: "ipc_echo", args: { value: "routed" } }, "main"), "main:routed")
  assert.deepEqual(await rpc("route.clear", {}, "main"), { removed: 1 })
  assert.deepEqual(await rpc("route.clear", {}, "guest"), { removed: 2 })
  assert.deepEqual(await rpc("route.list", {}, "guest"), { routes: [], intercepted: [] })
  await evaluate("guest", `fetch("/blocked").then(r=>{document.body.dataset.cleared=String(r.status)});null`)
  await until(() => dataset("cleared"), "Cleared route")
  assert.equal(await dataset("cleared"), "404")
  pass("CEF routes: fulfill, abort, method and times, pass-through, Tauri IPC exemption and clear")
  await rpc("network.clear", {}, "guest")
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
  let captures
  if (mac) {
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
    captures = { host, guest, whole, colors }
    pass("single-page vs whole-window screenshots reproduce native modal occlusion")
  } else {
    // No whole-window capture off macOS, so occlusion cannot be shown; the page captures still must be real PNGs.
    captures = {}
    for (const label of ["main", "guest"]) {
      const url = await rpc("screenshot", {}, label)
      assert.equal(typeof url, "string")
      assert.ok(url.startsWith("data:image/png;base64,"), `${label} screenshot is not a PNG data URL`)
      const png = Buffer.from(url.slice("data:image/png;base64,".length), "base64")
      assert.equal(png.subarray(1, 4).toString("latin1"), "PNG")
      const size = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
      assert.ok(size.width > 100 && size.height > 100, `${label} screenshot is ${JSON.stringify(size)}`)
      writeFileSync(join(artifacts, `${label}-page.png`), png)
      captures[label] = size
    }
    pass("page screenshots are composited PNGs of each webview")
  }
  await rpc("click", { selector: "#dismiss" }, "main")
  // Exiting can destroy the initiating document before its IPC response arrives.
  // The process result, rather than transport delivery, establishes clean shutdown.
  let shutdownResponse = null
  await rpc("ipc", { command: "quit_fixture" }, "main").catch((error) => {
    shutdownResponse = String(error)
  })
  exited = await exit(10_000)
  assert.ok(exited, "Graceful exit")
  assert.equal(exited.code, 0, `Unexpected shutdown: ${exited.signal}: ${shutdownResponse}`)
  assert.equal(exited.signal, null)
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
  assert.doesNotMatch(await appLog(), /FATAL:|panicked at/)
  pass("graceful IPC shutdown exits 0 and reaps Playwright executors")
  writeFileSync(
    join(artifacts, "report.json"),
    JSON.stringify({ checks, windows, ...captures, exitCode: exited.code, shutdownResponse }, null, 2)
  )
} catch (error) {
  writeFileSync(
    join(artifacts, "report.json"),
    JSON.stringify({ status: "failed", checks, error: String(error) }, null, 2)
  )
  // A process that dies before it listens leaves only Chromium's log to explain itself.
  const cefLog = join(artifacts, "cef.log")
  if (existsSync(cefLog)) console.error(`CEF log:\n${readFileSync(cefLog, "utf8").split("\n").slice(-80).join("\n")}`)
  else
    console.error(`No CEF log was written; files beside the executable: ${readdirSync(dirname(executable)).join(", ")}`)
  for (const label of ["second", "guest"]) {
    try {
      console.error(label, await evaluate(label, "({url:location.href,title:document.title})"))
    } catch (diagnostic) {
      console.error(label, String(diagnostic))
    }
  }
  throw error
} finally {
  client.disconnect()
  writeFileSync(join(artifacts, "app.log"), await appLog())
  // Stops the application and everything it started if the test did not end it.
  await app.stop()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  rmSync(temp, { recursive: true, force: true })
}
assert.ok(exited, "fixture process must exit")
// A named pipe has no file to leave behind.
if (mac) assert.equal(existsSync(socketPath), false)
pass("process and socket cleanup")

const finalReport = JSON.parse(readFileSync(join(artifacts, "report.json"), "utf8"))
writeFileSync(
  join(artifacts, "report.json"),
  JSON.stringify(
    { ...finalReport, status: "passed", checks, exitCode: exited.code, signalCode: exited.signal },
    null,
    2
  )
)
