#!/usr/bin/env node
// Runs the prebuilt tauri-hasgard binary that npm installed for this platform.
import { spawn } from "node:child_process"
import { createRequire } from "node:module"

const packages = {
  "darwin-arm64": "@nyssance/tauri-hasgard-cli-darwin-arm64",
  "linux-x64": "@nyssance/tauri-hasgard-cli-linux-x64",
  "win32-x64": "@nyssance/tauri-hasgard-cli-win32-x64"
}
const platform = `${process.platform}-${process.arch}`
const name = packages[platform]
if (!name) {
  console.error(`tauri-hasgard: no prebuilt binary for ${platform}. Build it with: cargo install tauri-hasgard-cli`)
  process.exit(1)
}
let binary
try {
  binary = createRequire(import.meta.url).resolve(
    `${name}/bin/tauri-hasgard${process.platform === "win32" ? ".exe" : ""}`
  )
} catch {
  console.error(`tauri-hasgard: ${name} is not installed. Reinstall without --no-optional or --omit=optional.`)
  process.exit(1)
}
const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" })
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal))
child.on("error", (error) => {
  console.error(`tauri-hasgard: cannot start ${binary}: ${error.message}`)
  process.exit(1)
})
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
