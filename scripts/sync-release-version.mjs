import { readFileSync, writeFileSync } from "node:fs"

const [version] = process.argv.slice(2)
if (!version || !/^\d+\.\d+\.\d+(?:-alpha\.[1-9]\d*)?$/.test(version)) {
  throw new Error(`invalid release version: ${version ?? ""}`)
}

const root = new URL("../", import.meta.url)
const packageUrl = new URL("packages/playwright/package.json", root)
const serverUrl = new URL("server.json", root)
const packageJson = JSON.parse(readFileSync(packageUrl, "utf8"))
packageJson.version = version
writeFileSync(packageUrl, `${JSON.stringify(packageJson, null, 2)}\n`)
const server = JSON.parse(readFileSync(serverUrl, "utf8"))
server.version = version
server.packages[0].version = version
writeFileSync(serverUrl, `${JSON.stringify(server, null, 2)}\n`)
