// Assemble the npm packages for the CLI from the release archives:
// one package per platform holding the binary, and a launcher that depends on them.
import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const [tag, dist, out] = process.argv.slice(2)
if (!tag || !dist || !out) throw new Error("usage: build-cli-npm.mjs <tag> <archive-dir> <output-dir>")
if (!/^v\d+\.\d+\.\d+(?:-alpha\.[1-9]\d*)?$/.test(tag)) throw new Error(`invalid release tag: ${tag}`)
const version = tag.slice(1)
const root = resolve(import.meta.dirname, "..")
const scope = "@nyssance/tauri-hasgard-cli"
const targets = [
  { triple: "aarch64-apple-darwin", os: "darwin", cpu: "arm64", archive: "tar.gz", binary: "tauri-hasgard" },
  { triple: "x86_64-unknown-linux-gnu", os: "linux", cpu: "x64", archive: "tar.gz", binary: "tauri-hasgard" },
  { triple: "x86_64-pc-windows-msvc", os: "win32", cpu: "x64", archive: "zip", binary: "tauri-hasgard.exe" }
]
const shared = {
  version,
  license: "Apache-2.0",
  repository: { type: "git", url: "git+https://github.com/nyssance/tauri-hasgard.git" },
  homepage: "https://github.com/nyssance/tauri-hasgard#readme"
}
function write(directory, manifest, readme) {
  writeFileSync(join(directory, "package.json"), `${JSON.stringify({ ...manifest, ...shared }, null, 2)}\n`)
  writeFileSync(join(directory, "README.md"), readme)
  for (const notice of ["LICENSE", "NOTICE.md"]) copyFileSync(join(root, notice), join(directory, notice))
}

rmSync(out, { recursive: true, force: true })
const scratch = mkdtempSync(join(tmpdir(), "hasgard-cli-npm-"))
const optionalDependencies = {}
try {
  for (const target of targets) {
    const stem = `tauri-hasgard-${version}-${target.triple}`
    const archive = resolve(dist, `${stem}.${target.archive}`)
    if (!existsSync(archive)) throw new Error(`missing release archive: ${archive}`)
    const extract =
      target.archive === "zip"
        ? spawnSync("unzip", ["-q", archive, "-d", scratch], { stdio: "inherit" })
        : spawnSync("tar", ["-xzf", archive, "-C", scratch], { stdio: "inherit" })
    if (extract.error) throw extract.error
    if (extract.status !== 0) throw new Error(`cannot extract ${archive}`)
    const name = `${scope}-${target.os}-${target.cpu}`
    const directory = join(out, `${target.os}-${target.cpu}`)
    mkdirSync(join(directory, "bin"), { recursive: true })
    cpSync(join(scratch, stem, target.binary), join(directory, "bin", target.binary))
    chmodSync(join(directory, "bin", target.binary), 0o755)
    write(
      directory,
      {
        name,
        description: `tauri-hasgard binary for ${target.os} ${target.cpu}`,
        os: [target.os],
        cpu: [target.cpu],
        files: ["bin", "LICENSE", "NOTICE.md"]
      },
      `# ${name}\n\nThe \`tauri-hasgard\` binary for ${target.os} ${target.cpu}. Install [\`${scope}\`](https://www.npmjs.com/package/${scope}) instead; it selects this package.\n`
    )
    optionalDependencies[name] = version
  }
  const directory = join(out, "cli")
  mkdirSync(join(directory, "bin"), { recursive: true })
  copyFileSync(join(root, "npm/cli/tauri-hasgard.mjs"), join(directory, "bin/tauri-hasgard.mjs"))
  chmodSync(join(directory, "bin/tauri-hasgard.mjs"), 0o755)
  write(
    directory,
    {
      name: scope,
      description: "CLI and MCP server for Tauri Hasgard automation",
      keywords: ["tauri", "mcp", "cli", "testing", "automation"],
      type: "module",
      bin: { "tauri-hasgard": "bin/tauri-hasgard.mjs" },
      files: ["bin", "LICENSE", "NOTICE.md"],
      engines: { node: ">=20" },
      optionalDependencies
    },
    `# ${scope}\n\nThe [\`tauri-hasgard\`](https://github.com/nyssance/tauri-hasgard) CLI and MCP server as a prebuilt binary for macOS Apple Silicon, Windows x64 and Linux x64.\n\n\`\`\`sh\nclaude mcp add tauri-hasgard -- npx -y ${scope} mcp   # Claude Code\ncodex mcp add tauri-hasgard -- npx -y ${scope} mcp    # Codex\nnpx -y ${scope} windows                               # any CLI command\n\`\`\`\n\nThe application must register [\`tauri-plugin-hasgard\`](https://crates.io/crates/tauri-plugin-hasgard). Other platforms: \`cargo install tauri-hasgard-cli\`.\n`
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
// Platform packages first: the launcher's optional dependencies must already exist.
console.log([...targets.map((target) => `${target.os}-${target.cpu}`), "cli"].join("\n"))
