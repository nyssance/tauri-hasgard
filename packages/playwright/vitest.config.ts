import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Vitest 5.1.1 starts fork workers with child.channel.unref(), which Bun does not provide.
    pool: "threads",
    restoreMocks: true
  }
})
