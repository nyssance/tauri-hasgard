import { readFileSync } from "node:fs"

const [tag] = process.argv.slice(2)
if (!tag) throw new Error("release tag is required")
if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`invalid release tag: ${tag}`)

const version = tag.slice(1)
const cargo = readFileSync(new URL("../Cargo.toml", import.meta.url), "utf8")
const npmPackage = JSON.parse(readFileSync(new URL("../packages/playwright/package.json", import.meta.url), "utf8"))
const workspaceVersion = cargo.match(/^version = "([^"]+)"$/m)?.[1]

if (workspaceVersion !== version) {
  throw new Error(`Cargo workspace version ${workspaceVersion} does not match tag ${tag}`)
}
if (npmPackage.version !== version) {
  throw new Error(`npm package version ${npmPackage.version} does not match tag ${tag}`)
}
