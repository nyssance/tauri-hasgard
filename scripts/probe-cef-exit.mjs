// Diagnostic, Windows only: how often does the CEF fixture fail to exit cleanly when
// nothing but the quit command is sent? Run through cmd so the full 32-bit exit code is
// visible; a child process API may report only its low byte.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { hasgardEndpointPath, HasgardProcess, HasgardRpcClient } from "../packages/playwright/src/index.ts"

if (process.platform !== "win32") throw new Error("This probe is for Windows")
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const executable = join(root, "target/debug/tauri-hasgard-cef-fixture.exe")
const rounds = Number(process.argv[2] ?? 8)
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
if (/\s/.test(executable)) throw new Error(`The probe needs a path without spaces: ${executable}`)
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH")

const codes = []
for (let round = 0; round < rounds; round++) {
  const temp = mkdtempSync(join(tmpdir(), "hg-cef-probe-"))
  const endpoint = hasgardEndpointPath(`hg-cef-probe-${process.pid}-${round}`)
  const app = new HasgardProcess()
  const client = new HasgardRpcClient(endpoint)
  try {
    await app.start(
      {
        // cmd reports the code it saw in full, after the application has gone. Delayed
        // expansion reads it then, not when the line is parsed; the path has no spaces to quote.
        command: "cmd.exe",
        args: ["/d", "/v:on", "/c", `start /wait ${executable} & echo EXITCODE=!errorlevel!`],
        cwd: root,
        timeoutMs: 60_000,
        env: {
          [pathKey]: `${found[0]};${process.env[pathKey]}`,
          TAURI_HASGARD_DISPLAY: process.env.TAURI_HASGARD_DISPLAY ?? "secondary",
          HASGARD_CEF_GUEST_URL: "about:blank",
          HASGARD_CEF_PROFILE: join(temp, "cef-profile")
        }
      },
      endpoint
    )
    await client.connect(20_000)
    // The quit command travels through the page, so the page has to be there first.
    const deadline = Date.now() + 30_000
    for (;;) {
      const ready = await client.call("eval", { script: "document.readyState", window: "main" }).then(
        (state) => state === "complete",
        () => false
      )
      if (ready) break
      if (Date.now() > deadline) throw new Error("the main window did not become ready")
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    // Quitting can end the document before its reply arrives; the exit code is what is measured.
    const quit = await client.call("ipc", { command: "quit_fixture", window: "main" }).then(
      () => "replied",
      (error) => `no reply (${String(error).slice(0, 80)})`
    )
    const { stdout, stderr } = await app.diagnostics(20_000)
    const code = stdout.match(/EXITCODE=(-?\d+)/)?.[1]
    codes.push(code ?? `no code reported, quit ${quit}: ${JSON.stringify((stdout + stderr).slice(-200))}`)
  } catch (error) {
    codes.push(`probe failed: ${String(error).slice(0, 200)}`)
  } finally {
    client.disconnect()
    await app.stop().catch(() => {})
    try {
      execFileSync("taskkill", ["/IM", "tauri-hasgard-cef-fixture.exe", "/T", "/F"], { stdio: "ignore" })
    } catch {
      // Nothing left to stop.
    }
    rmSync(temp, { recursive: true, force: true })
  }
}
console.log(`CEF fixture exit codes over ${rounds} quit-only launches: ${codes.join(", ")}`)
