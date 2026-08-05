import { resolve } from "node:path"
import { defineConfig } from "vite"

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        settings: resolve(import.meta.dirname, "settings.html"),
        embedded: resolve(import.meta.dirname, "embedded.html"),
        nested: resolve(import.meta.dirname, "nested.html")
      }
    }
  },
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true
  }
})
