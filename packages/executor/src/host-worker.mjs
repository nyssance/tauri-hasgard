import { run } from "./runtime.mjs"

const moduleUrl = process.argv[2]
if (!moduleUrl) throw Error("The host must supply its packaged Playwright module URL")
const { chromium } = await import(moduleUrl)
await run(chromium)
