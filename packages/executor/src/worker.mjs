import { chromium } from "playwright-core"

import { run } from "./runtime.mjs"

await run(chromium)
