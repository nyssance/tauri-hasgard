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
  // Written while the page loaded. If that was before the first automation request reached
  // this webview, CDP replays the message without object previews and the object is its
  // description; if the request won the race, the object arrives with its preview.
  const loaded = await rpc("console.getLogs", {}, "guest")
  assert.equal(loaded.length, 1, JSON.stringify(loaded))
  assert.equal(loaded[0].level, "warn")
  assert.equal(loaded[0].args[0], "guest loaded")
  assert.ok(
    loaded[0].args[1] === "Object" || JSON.stringify(loaded[0].args[1]) === '{"remote":true}',
    JSON.stringify(loaded[0].args)
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
  // Operations the page cannot perform go through the runtime, here CEF's.
  const located = await rpc("wait", { url: "**/guest.html", load: "load", timeout: 5000 }, "guest")
  assert.equal(located.readyState, "complete")
  await assert.rejects(rpc("wait", { url: "**/absent.html", timeout: 300 }, "guest"), /Timeout waiting/)
  const frame = await rpc("window.state", {}, "second")
  assert.equal(frame.label, "second")
  assert.ok(frame.width > 100 && frame.height > 100 && frame.scaleFactor >= 1)
  // A child webview has no window of its own; its label names the window that holds it.
  assert.equal((await rpc("window.state", {}, "guest")).width, (await rpc("window.state", {}, "main")).width)
  await rpc("window.resize", { width: frame.width - 40, height: frame.height - 20 }, "second")
  await until(
    async () => Math.abs((await rpc("window.state", {}, "second")).width - (frame.width - 40)) < 1,
    "Resized window"
  )
  await rpc("window.resize", { width: frame.width, height: frame.height }, "second")
  // CEF sets a cookie against the document's own URL, so it must belong to this page's host.
  await rpc("cookies.clear", { name: "session" }, "guest")
  await rpc("cookies.set", { name: "session", value: "s3cret", url: guestUrl, httpOnly: true }, "guest")
  const cookies = await rpc("cookies.get", { url: guestUrl, name: "session" }, "guest")
  assert.deepEqual(
    cookies.map(({ name, value, httpOnly, secure }) => ({ name, value, httpOnly, secure })),
    [{ name: "session", value: "s3cret", httpOnly: true, secure: false }]
  )
  assert.equal(await evaluate("guest", 'document.cookie.includes("s3cret")'), false)
  await assert.rejects(
    rpc("cookies.set", { name: "foreign", value: "x", url: "https://elsewhere.example.test/" }, "guest"),
    /did not accept the cookie/
  )
  assert.deepEqual(await rpc("cookies.clear", { name: "session" }, "guest"), { removed: 1 })
  assert.deepEqual(await rpc("cookies.get", { url: guestUrl, name: "session" }, "guest"), [])
  pass("location wait, native window state, and the cookie store through the CEF runtime")
  // The dialog plugin's commands are answered where CEF pauses the application's IPC requests.
  const native = () => evaluate("main", "document.body.dataset.native")
  assert.deepEqual((await rpc("nativeDialog.list", {}, "main")).policy, { action: "manual", paths: [], button: null })
  await rpc("nativeDialog.handle", { action: "accept", paths: ["/tmp/hasgard-cef.csv"] }, "main")
  // Each answer is awaited as whatever the application received, so a wrong one is shown, not timed out.
  const answerTo = async (button, expected) => {
    await evaluate("main", "delete document.body.dataset.native")
    await rpc("click", { selector: button }, "main")
    assert.equal(await until(native, `Answer to ${button}`, 5000), expected)
  }
  // Proven first with a request that could not open a real dialog even if it went
  // unanswered: it carries no invoke key, so Tauri itself would refuse it.
  await answerTo("#native-probe", 'probe:ok:"/tmp/hasgard-cef.csv"')
  await answerTo("#native-save", 'save:"/tmp/hasgard-cef.csv"')
  await answerTo("#native-ask", 'message:"Yes"')
  await rpc("nativeDialog.handle", { action: "dismiss" }, "main")
  await answerTo("#native-save", "save:null")
  // Every other command still reaches the application while dialogs are being answered.
  assert.equal(await rpc("ipc", { command: "ipc_echo", args: { value: "real" } }, "main"), "main:real")
  const answered = (await rpc("nativeDialog.list", {}, "main")).dialogs
  assert.deepEqual(
    answered.map(({ kind, accepted, title, result }) => ({ kind, accepted, title, result })),
    [
      // The probe's request named no title.
      { kind: "save", accepted: true, title: undefined, result: "/tmp/hasgard-cef.csv" },
      { kind: "save", accepted: true, title: "Export report", result: "/tmp/hasgard-cef.csv" },
      { kind: "message", accepted: true, title: "Draft", result: "Yes" },
      { kind: "save", accepted: false, title: "Export report", result: null }
    ]
  )
  assert.deepEqual(answered[2].buttons, ["Yes", "No"])
  assert.equal((await rpc("nativeDialog.handle", { action: "manual" }, "main")).action, "manual")
  await rpc("nativeDialog.clear", {}, "main")
  pass("native dialogs answered at the IPC boundary, recorded, and nothing else intercepted")
  // Tauri events cross the same boundary on this runtime: one sent in is heard by the page,
  // and one the page emits is recorded.
  await rpc("event.clear")
  assert.deepEqual((await rpc("event.listen", { event: "fixture-saved" })).listening, ["fixture-saved"])
  // The page subscribes here rather than while it loads, so the subscription cannot race
  // the runtime's own startup.
  await rpc("click", { selector: "#subscribe" }, "main")
  assert.equal(await until(() => evaluate("main", "document.body.dataset.listening"), "Page subscribed"), "yes")
  const heardBy = async (send) => {
    await evaluate("main", "delete document.body.dataset.event, null")
    await send()
    return until(() => evaluate("main", "document.body.dataset.event"), "Event", 5000).catch(() => null)
  }
  // The application's own emit is the reference: Hasgard's must be heard exactly where it is.
  const emit = { event: "fixture-ping", payload: 7 }
  assert.deepEqual(
    {
      fromApp: await heardBy(() => rpc("ipc", { command: "app_emit", args: emit }, "main")),
      broadcast: await heardBy(() => rpc("event.emit", emit)),
      targeted: await heardBy(() => rpc("event.emit", emit, "main"))
    },
    { fromApp: "7", broadcast: "7", targeted: "7" }
  )
  await rpc("fill", { selector: "#host-input", value: "saved" }, "main")
  await evaluate("main", 'document.querySelector("#host-input").dispatchEvent(new Event("change")), null')
  const heard = await until(async () => {
    const { events } = await rpc("event.list", { event: "fixture-saved" })
    return events.length > 0 && events
  }, "Event emitted by the page")
  assert.deepEqual(heard.at(-1).payload, { value: "saved" })
  await assert.rejects(rpc("event.list", { sinceId: "1" }), /'sinceId' must be/)
  await rpc("event.unlisten", { event: "fixture-saved" })
  await rpc("event.clear")
  pass("Tauri events delivered to the page and recorded from it")
  // The child webview was built with Hasgard's download observer.
  const downloadDir = join(artifacts, "downloads")
  rmSync(downloadDir, { recursive: true, force: true })
  mkdirSync(downloadDir, { recursive: true })
  await rpc("downloads.clear")
  await rpc("downloads.setDirectory", { path: downloadDir })
  const finished = rpc("downloads.wait", { timeout: 20000 }, "guest")
  await evaluate(
    "guest",
    `(() => {
      const link = document.createElement("a")
      link.href = URL.createObjectURL(new Blob(["hello cef"], { type: "text/plain" }))
      link.download = "hasgard-cef.txt"
      document.body.append(link)
      link.click()
      link.remove()
      return null
    })()`
  )
  const download = await finished
  assert.equal(download.state, "finished", JSON.stringify(download))
  assert.equal(download.window, "guest")
  assert.equal(readFileSync(download.path, "utf8"), "hello cef")
  assert.ok(download.path.startsWith(downloadDir), download.path)
  assert.deepEqual(
    (await rpc("downloads.list", {}, "guest")).downloads.map(({ id }) => id),
    [download.id]
  )
  assert.deepEqual((await rpc("downloads.list", {}, "main")).downloads, [])
  await rpc("downloads.setDirectory", { path: null })
  pass("a download from the child webview is reported with the file it saved")
  // A same-origin frame is captured and diffed as a document of its own.
  const pngSize = async (params) => {
    const url = await rpc("screenshot", params, "second")
    assert.ok(url.startsWith("data:image/png;base64,"), "frame screenshot is not a PNG data URL")
    const png = Buffer.from(url.slice("data:image/png;base64,".length), "base64")
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
  }
  const pane = await pngSize({ frame: ["#pane"] })
  assert.ok(Math.abs(pane.width / pane.height - 300 / 120) < 0.05, `frame capture is ${JSON.stringify(pane)}`)
  const pay = await pngSize({ frame: ["#pane"], selector: "#pay" })
  assert.ok(Math.abs(pay.width / pay.height - 120 / 40) < 0.1, `element capture is ${JSON.stringify(pay)}`)
  assert.ok(pay.width < pane.width)
  await rpc("snapshot", { frame: ["#pane"] }, "second")
  await rpc("snapshot", {}, "second")
  assert.deepEqual(await rpc("diff", { frame: ["#pane"] }, "second"), { added: [], removed: [], changed: [] })
  await evaluate(
    "second",
    'document.querySelector("#pane").contentDocument.querySelector("#pay").textContent = "Pay now", null'
  )
  const changed = await rpc("diff", { frame: ["#pane"] }, "second")
  assert.ok(changed.added.length + changed.removed.length + changed.changed.length > 0, JSON.stringify(changed))
  await assert.rejects(rpc("screenshot", { frame: ["#absent"] }, "second"), /No frame matches/)
  pass("a frame has its own screenshot and its own diff baseline")
  const heapPath = join(artifacts, "guest.heapsnapshot")
  rmSync(heapPath, { force: true })
  const heap = await rpc("heap.snapshot", { output_path: heapPath }, "guest")
  assert.equal(heap.format, "v8")
  const written = readFileSync(heapPath, "utf8")
  assert.equal(heap.byte_size, Buffer.byteLength(written))
  // V8's snapshot is one JSON document that opens with its own metadata.
  assert.ok(written.startsWith('{"snapshot":'), written.slice(0, 40))
  assert.ok(JSON.parse(written).nodes.length > 0)
  await assert.rejects(rpc("heap.snapshot", { output_path: "relative.heapsnapshot" }, "guest"), /must be absolute/)
  pass("heap snapshot of the selected webview in V8's format")
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
  // On Windows, tauri-runtime-cef 3.0.0-alpha.7 sometimes dies with an access violation while
  // it shuts down. scripts/probe-cef-exit.mjs measured it in one of eight launches with this
  // plugin not loaded at all, and more often while a child webview is alive. This child
  // process API reports 0xC0000005 as 5. It is the runtime's own exit, so it is reported
  // here rather than failed; any other code, and anything on macOS, still fails.
  const runtimeCrash = !mac && exited.code === 5
  if (runtimeCrash) console.log("::warning::The CEF runtime crashed while exiting (0xC0000005); see docs/cef.md")
  else assert.equal(exited.code, 0, `Unexpected shutdown: ${exited.signal}: ${shutdownResponse}`)
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
  pass(
    runtimeCrash
      ? "IPC shutdown reaps Playwright executors (the runtime crashed while exiting)"
      : "graceful IPC shutdown exits 0 and reaps Playwright executors"
  )
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
