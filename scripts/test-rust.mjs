import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { delimiter, dirname, join, resolve } from "node:path"

if (!["darwin", "win32"].includes(process.platform)) throw new Error("Native Rust validation requires macOS or Windows")
const env = { ...process.env, CEF_PATH: resolve(process.env.CEF_PATH ?? "target/cef-cache") }
function run(args) {
  const child = spawnSync("cargo", args, { env, stdio: "inherit" })
  if (child.error) throw child.error
  if (child.status !== 0) process.exit(child.status ?? 1)
}
// The CEF fixture bundles the Playwright executor as an external binary; its build script
// fails when target/hasgard-playwright-<triple> is absent.
const executor = spawnSync(process.execPath, ["run", "--cwd", "packages/executor", "build"], { stdio: "inherit" })
if (executor.error) throw executor.error
if (executor.status !== 0) process.exit(executor.status ?? 1)
run([
  "test",
  "-p",
  "tauri-hasgard-mcp",
  "-p",
  "tauri-plugin-hasgard",
  "-p",
  "tauri-hasgard-cli",
  "--all-features",
  "--locked",
  "--no-run"
])
if (process.platform === "darwin") {
  const frameworks = []
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const child = join(path, entry.name)
      if (entry.name === "Chromium Embedded Framework.framework") frameworks.push(child)
      else visit(child)
    }
  }
  visit(env.CEF_PATH)
  const cefVersion = readFileSync("Cargo.lock", "utf8").match(/name = "cef"\nversion = "[^"+]+\+([^"]+)"/)?.[1]
  if (!cefVersion) throw new Error("Cargo.lock has no CEF distribution version")
  const matching = frameworks.filter((path) =>
    JSON.parse(readFileSync(join(dirname(path), "archive.json"), "utf8")).name.startsWith(`cef_binary_${cefVersion}+`)
  )
  if (matching.length !== 1)
    throw new Error(`Expected one CEF framework in ${env.CEF_PATH}, found ${matching.length} matching ${cefVersion}`)
  env.DYLD_FRAMEWORK_PATH = dirname(matching[0])
} else {
  // cef-dll-sys copies runtime DLLs beside target/debug, not test executables in deps.
  env.PATH = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug") + delimiter + process.env.PATH
}
run([
  "test",
  "-p",
  "tauri-hasgard-mcp",
  "-p",
  "tauri-plugin-hasgard",
  "-p",
  "tauri-hasgard-cli",
  "--all-features",
  "--locked"
])
