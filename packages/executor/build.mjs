import { copyFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const target =
  process.platform === "darwin" && process.arch === "arm64"
    ? "aarch64-apple-darwin"
    : process.platform === "win32" && process.arch === "x64"
      ? "x86_64-pc-windows-msvc"
      : null
if (!target) throw Error("Executor builds support macOS ARM64 and Windows x64")
const root = fileURLToPath(new URL("../../", import.meta.url))
const suffix = process.platform === "win32" ? ".exe" : ""
const output = resolve(root, `target/hasgard-playwright${suffix}`)
mkdirSync(resolve(root, "target"), { recursive: true })
const bundled = Bun.spawn(
  [
    process.execPath,
    "build",
    fileURLToPath(new URL("src/host-worker.mjs", import.meta.url)),
    "--target",
    "bun",
    "--minify",
    "--outfile",
    resolve(root, "crates/tauri-plugin-hasgard/js/playwright-worker.mjs")
  ],
  { stdout: "inherit", stderr: "inherit" }
)
if ((await bundled.exited) !== 0) throw Error("Executor module build failed")
const child = Bun.spawn(
  [
    process.execPath,
    "build",
    fileURLToPath(new URL("src/worker.mjs", import.meta.url)),
    "--compile",
    "--outfile",
    output
  ],
  { stdout: "inherit", stderr: "inherit" }
)
if ((await child.exited) !== 0) throw Error("Executor build failed")
copyFileSync(output, resolve(root, `target/hasgard-playwright-${target}${suffix}`))
