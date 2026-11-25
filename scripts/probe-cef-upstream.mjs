// Runs the standalone CEF probe (examples/cef-upstream-probe) many times and reports,
// per variant, how each launch exited and which of the three emitted events the page heard.
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const mac = process.platform === "darwin"
if (!mac && process.platform !== "win32") throw new Error("The probe runs on macOS and Windows")
const executable = mac
  ? join(root, "target/debug/bundle/macos/CEF Upstream Probe.app/Contents/MacOS/cef-upstream-probe")
  : join(root, "target/debug/cef-upstream-probe.exe")
if (!existsSync(executable)) throw new Error(`Not built: ${executable}`)
const rounds = Number(process.argv[2] ?? 20)

const env = { ...process.env }
if (!mac) {
  if (/\s/.test(executable)) throw new Error(`The probe needs a path without spaces: ${executable}`)
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
  env[pathKey] = `${found[0]};${process.env[pathKey]}`
}

const variants = [
  ["listen while the page loads", { PROBE_PAGE: "early.html" }],
  ["listen one second after load", { PROBE_PAGE: "late.html" }],
  ["listen while the page loads, child webview alive at exit", { PROBE_PAGE: "early.html", PROBE_CHILD: "1" }],
  ["listen while the page loads, second window", { PROBE_PAGE: "early.html", PROBE_SECOND: "1" }]
]
for (const [name, extra] of variants) {
  const exits = {}
  const results = {}
  for (let round = 0; round < rounds; round++) {
    const temp = mkdtempSync(join(tmpdir(), "cef-probe-"))
    const resultPath = join(temp, "result.txt")
    const launchEnv = { ...env, ...extra, PROBE_RESULT: resultPath, PROBE_PROFILE: join(temp, "profile") }
    // On Windows cmd reports the full 32-bit code after the application has gone; a child
    // process API may report only part of a crash code.
    const run = mac
      ? spawnSync(executable, [], { env: launchEnv, encoding: "utf8", timeout: 90_000 })
      : spawnSync("cmd.exe", ["/d", "/v:on", "/c", `start /wait ${executable} & echo EXITCODE=!errorlevel!`], {
          env: launchEnv,
          encoding: "utf8",
          timeout: 90_000
        })
    const exit = mac
      ? run.signal
        ? `signal ${run.signal}`
        : run.error
          ? `error ${run.error.code}`
          : `exit ${run.status}`
      : (() => {
          const code = run.stdout?.match(/EXITCODE=(-?\d+)/)?.[1]
          return code === undefined
            ? `error ${run.error?.code ?? "no code"}`
            : `exit 0x${(Number(code) >>> 0).toString(16)}`
        })()
    const result = existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "no result written"
    exits[exit] = (exits[exit] ?? 0) + 1
    results[result] = (results[result] ?? 0) + 1
    if (!mac) spawnSync("taskkill", ["/IM", "cef-upstream-probe.exe", "/T", "/F"], { stdio: "ignore" })
    // A crashed launch can leave a helper process holding the profile for a moment.
    try {
      rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    } catch (error) {
      console.log(`  (left ${temp}: ${error.code})`)
    }
  }
  console.log(`\n${name} (${rounds} launches)`)
  for (const [key, count] of Object.entries(exits)) console.log(`  ${count} x ${key}`)
  for (const [key, count] of Object.entries(results)) console.log(`  ${count} x ${key}`)
}
