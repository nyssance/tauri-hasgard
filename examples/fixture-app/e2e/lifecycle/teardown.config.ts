import { defineConfig } from "@playwright/test"

const outputDir = process.env.HASGARD_LIFECYCLE_OUTPUT_DIR
if (!outputDir) throw new Error("Lifecycle output directory is required")

export default defineConfig({
  testDir: ".",
  testMatch: "teardown.case.ts",
  timeout: 60_000,
  workers: 1,
  retries: 0,
  outputDir,
  reporter: "line"
})
