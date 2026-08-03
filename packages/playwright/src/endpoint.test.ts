import { describe, expect, test } from "vitest"
import { endpointPathForPlatform } from "./endpoint.js"

describe("endpointPathForPlatform", () => {
  test("uses a Windows named pipe", () => {
    expect(endpointPathForPlatform("tauri-hasgard-fixture-7", "win32", "C:\\Temp")).toBe(
      "\\\\.\\pipe\\tauri-hasgard-fixture-7"
    )
  })

  test("uses a Unix domain socket", () => {
    expect(endpointPathForPlatform("tauri-hasgard-fixture-7", "linux", "/tmp")).toBe(
      "/tmp/tauri-hasgard-fixture-7.sock"
    )
  })
})
