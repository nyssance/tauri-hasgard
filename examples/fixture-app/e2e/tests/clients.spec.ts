import { spawn } from "node:child_process"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { expect, fixtureEndpoint, test } from "../fixtures.js"

const cli = join(import.meta.dirname, "../../../../target/debug/tauri-hasgard")

async function command(endpoint: string, args: string[]) {
  const child = spawn(cli, ["--socket", endpoint, "--window", "main", "--json", ...args])
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", data => {
    stdout += data
  })
  child.stderr.on("data", data => {
    stderr += data
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

test("CLI preserves native press completion and structured failure data", async ({ window }, testInfo) => {
  test.skip(process.platform !== "darwin", "Native keyboard integration")
  const endpoint = fixtureEndpoint(testInfo.workerIndex)
  await window.evaluate('document.querySelector("#key-probe").type = "password"')
  try {
    await window.locator("#key-probe").fill("")
    const success = await command(endpoint, [
      "press",
      "m",
      "--wait-for",
      'document.querySelector("#key-probe").value === "m"',
      "--timeout",
      "1000"
    ])
    expect(success.code, success.stderr).toBe(0)
    expect(JSON.parse(success.stdout)).toEqual({ ok: true })
    await expect(window.locator("#key-probe").inputValue()).resolves.toBe("m")

    const failure = await command(endpoint, ["press", "s", "--wait-for", "false", "--timeout", "0"])
    expect(failure.code).toBe(1)
    expect(JSON.parse(failure.stdout).error.data).toEqual({ phase: "postcondition", injected: true })
    expect(failure.stderr).toContain("postcondition")
    // Failure is acknowledgement failure, not absence of the side effect.
    await expect(window.locator("#key-probe").inputValue()).resolves.toBe("ms")
    const invalid = await command(endpoint, ["press", "Ctrl+Control+a"])
    expect(invalid.code).toBe(1)
    expect(JSON.parse(invalid.stdout).error.code).toBe(-32602)
    await expect(window.locator("#key-probe").inputValue()).resolves.toBe("ms")
  } finally {
    await window.evaluate('document.querySelector("#key-probe").type = "text"')
  }
})

test("MCP stdio drives the same native app and preserves RPC error details", async ({ window }, testInfo) => {
  test.skip(process.platform !== "darwin", "Native keyboard integration")
  const child = spawn(cli, ["--socket", fixtureEndpoint(testInfo.workerIndex), "--window", "main", "mcp"])
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()))
  const lines = createInterface({ input: child.stdout })
  let stderr = ""
  child.stderr.on("data", data => {
    stderr += data
  })
  let id = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  const failAll = (error: Error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  child.on("error", failAll)
  child.on("close", () => failAll(new Error(`MCP exited: ${stderr}`)))
  lines.on("line", line => {
    try {
      const response = JSON.parse(line)
      const request = pending.get(response.id)
      if (request) {
        pending.delete(response.id)
        if (response.error) request.reject(new Error(JSON.stringify(response.error)))
        else request.resolve(response.result)
      }
    } catch (error) {
      failAll(error as Error)
    }
  })
  async function call(method: string, params: object) {
    const requestId = ++id
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<any>((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        timer = setTimeout(() => reject(new Error(`MCP ${method} timed out: ${stderr}`)), 15_000)
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`)
      })
    } finally {
      clearTimeout(timer)
      pending.delete(requestId)
    }
  }
  try {
    await call("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "native-fixture", version: "1" }
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
    const listing = await call("tools/list", {})
    const press = listing.tools.find((tool: { name: string }) => tool.name === "hasgard.press")
    expect(press).toBeDefined()
    expect(press.inputSchema.properties.completion.enum).toEqual(["webview", "native"])
    await window.evaluate('document.querySelector("#key-probe").type = "password"')
    await window.locator("#key-probe").fill("")
    const result = await call("tools/call", {
      name: press.name,
      arguments: { key: "m", wait_for: 'document.querySelector("#key-probe").value === "m"', timeout: 1000 }
    })
    expect(result.isError).toBe(false)
    expect(result.structuredContent.result).toEqual({ ok: true })
    const failure = await call("tools/call", {
      name: press.name,
      arguments: { key: "s", wait_for: "false", timeout: 0 }
    })
    expect(failure.isError).toBe(true)
    expect(failure.structuredContent.rpcError.data).toEqual({ phase: "postcondition", injected: true })
    await expect(window.locator("#key-probe").inputValue()).resolves.toBe("ms")
    const rejected = await call("tools/call", { name: press.name, arguments: { key: "m", window: "absent-window" } })
    expect(rejected.isError).toBe(true)
    expect(rejected.structuredContent.rpcError.data).toEqual({ phase: "focus", injected: false })
    await expect(window.locator("#key-probe").inputValue()).resolves.toBe("ms")
    const native = await call("tools/call", { name: press.name, arguments: { key: "Shift", completion: "native" } })
    expect(native.isError).toBe(false)
  } finally {
    child.stdin.end()
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000)
    await closed
    clearTimeout(killTimer)
    lines.close()
    await window.evaluate('document.querySelector("#key-probe").type = "text"')
  }
})
