import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  maxFailures: process.env.CI ? 3 : undefined,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]]
})
