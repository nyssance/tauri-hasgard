// Diagnostic, Windows only: which kind of activity makes the CEF fixture exit uncleanly?
// Each scenario adds one kind to the one before and is run several times, then the
// fixture is told to quit and its full 32-bit exit code is read through cmd, since a
// child process API may report only the low byte of a crash code.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { hasgardEndpointPath, HasgardProcess, HasgardRpcClient } from "../packages/playwright/src/index.ts"

if (process.platform !== "win32") throw new Error("This probe is for Windows")
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const executable = join(root, "target/debug/tauri-hasgard-cef-fixture.exe")
if (/\s/.test(executable)) throw new Error(`The probe needs a path without spaces: ${executable}`)
const rounds = Number(process.argv[2] ?? 5)

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

// How this runtime's child process API reports a crash code such as 0xC0000005.
const crash = spawnSync("cmd.exe", ["/d", "/c", "exit -1073741819"])
console.log(`A child that exits 0xC0000005 is reported as ${crash.status}`)

const server = createServer((req, res) => {
  const name = req.url?.split("?")[0]?.slice(1)
  if (!["guest.html", "guest-next.html", "guest-frame.html"].includes(name)) {
    res.writeHead(404).end()
    return
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.end(readFileSync(join(root, "examples/cef-fixture-app/ui", name)))
})
await new Promise((done) => server.listen(0, "127.0.0.1", done))
const guestUrl = `http://127.0.0.1:${server.address().port}/guest.html`

const guest = async (call, until) => {
  await call("click", { selector: "#recreate", window: "main" })
  await until(() => call("eval", { script: "document.title", window: "guest" }).then((title) => title === "CEF Guest"))
}
const input = async (call, until) => {
  await guest(call, until)
  await call("fill", { selector: "#guest-input", value: "typed", window: "guest" })
  await call("click", { selector: "#increment", window: "guest" })
}
const scenarios = [
  ["quit only", async () => {}],
  ["child webview", guest],
  ["child webview, executor input", input],
  [
    "child webview, executor input, native key",
    async (call, until) => {
      await input(call, until)
      await call("press", { key: "End", window: "guest" })
    }
  ],
  [
    "child webview, executor input, runtime calls",
    async (call, until) => {
      await input(call, until)
      await call("window.state", { window: "second" })
      await call("cookies.get", { window: "guest" })
      await call("nativeDialog.handle", { action: "dismiss", window: "main" })
      await call("nativeDialog.handle", { action: "manual", window: "main" })
      await call("route.add", { pattern: "**/x", window: "guest" })
      await call("route.clear", { window: "guest" })
      await call("heap.snapshot", {
        output_path: join(tmpdir(), `hg-probe-${process.pid}.heapsnapshot`),
        window: "guest"
      })
    }
  ],
  [
    "child webview, executor input, child closed first",
    async (call, until) => {
      await input(call, until)
      await call("click", { selector: "#close", window: "main" })
      await until(() => call("windows.list").then((list) => !list.windows.some((entry) => entry.label === "guest")))
    }
  ]
]

let launch = 0
for (const [name, activity] of scenarios) {
  const codes = []
  for (let round = 0; round < rounds; round++) {
    const temp = mkdtempSync(join(tmpdir(), "hg-cef-probe-"))
    const endpoint = hasgardEndpointPath(`hg-cef-probe-${process.pid}-${launch++}`)
    const app = new HasgardProcess()
    const client = new HasgardRpcClient(endpoint)
    const call = (method, params) => client.call(method, params)
    const until = async (check) => {
      const deadline = Date.now() + 30_000
      for (;;) {
        if (await check().catch(() => false)) return
        if (Date.now() > deadline) throw new Error("condition not met")
        await new Promise((done) => setTimeout(done, 100))
      }
    }
    try {
      await app.start(
        {
          // cmd reports the code it saw in full, after the application has gone. Delayed
          // expansion reads it then, not when the line is parsed.
          command: "cmd.exe",
          args: ["/d", "/v:on", "/c", `start /wait ${executable} & echo EXITCODE=!errorlevel!`],
          cwd: root,
          timeoutMs: 60_000,
          env: {
            [pathKey]: `${found[0]};${process.env[pathKey]}`,
            TAURI_HASGARD_DISPLAY: process.env.TAURI_HASGARD_DISPLAY ?? "secondary",
            HASGARD_CEF_GUEST_URL: guestUrl,
            HASGARD_CEF_PROFILE: join(temp, "cef-profile")
          }
        },
        endpoint
      )
      await client.connect(20_000)
      await until(() => call("eval", { script: "document.readyState", window: "main" }).then((s) => s === "complete"))
      await activity(call, until)
      // Quitting can end the document before its reply arrives; the exit code is what is measured.
      await call("ipc", { command: "quit_fixture", window: "main" }).catch(() => {})
      const { stdout, stderr } = await app.diagnostics(20_000)
      const code = stdout.match(/EXITCODE=(-?\d+)/)?.[1]
      codes.push(code ?? `none: ${JSON.stringify((stdout + stderr).slice(-160))}`)
    } catch (error) {
      codes.push(`probe failed: ${String(error).slice(0, 160)}`)
    } finally {
      client.disconnect()
      await app.stop().catch(() => {})
      spawnSync("taskkill", ["/IM", "tauri-hasgard-cef-fixture.exe", "/T", "/F"], { stdio: "ignore" })
      rmSync(temp, { recursive: true, force: true })
    }
  }
  console.log(`CEF fixture exit codes after "${name}": ${codes.join(", ")}`)
}
server.closeAllConnections()
await new Promise((done) => server.close(done))
