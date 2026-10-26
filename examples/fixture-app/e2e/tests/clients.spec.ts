import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"

import { expect, fixtureEndpoint, test } from "../fixtures.js"

const cli = join(import.meta.dirname, "../../../../target/debug/tauri-hasgard")

interface RpcFailure {
  error: { code: number; data: unknown }
}

interface JsonRpcResponse {
  id?: number
  error?: unknown
  result?: unknown
}

interface ToolResult {
  isError: boolean
  structuredContent: { result?: Record<string, unknown>; rpcError?: { data: unknown } }
}

interface ToolListing {
  tools: Array<{ name: string; inputSchema: { properties: { completion: { enum: string[] } } } }>
}

async function command(endpoint: string, args: string[]) {
  const child = spawn(cli, ["--socket", endpoint, "--window", "main", "--json", ...args])
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (data) => {
    stdout += data
  })
  child.stderr.on("data", (data) => {
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
    expect((JSON.parse(failure.stdout) as RpcFailure).error.data).toEqual({ phase: "postcondition", injected: true })
    expect(failure.stderr).toContain("postcondition")
    // Failure is acknowledgement failure, not absence of the side effect.
    await expect(window.locator("#key-probe").inputValue()).resolves.toBe("ms")
    const invalid = await command(endpoint, ["press", "Ctrl+Control+a"])
    expect(invalid.code).toBe(1)
    expect((JSON.parse(invalid.stdout) as RpcFailure).error.code).toBe(-32602)
    await expect(window.locator("#key-probe").inputValue()).resolves.toBe("ms")
  } finally {
    await window.evaluate('document.querySelector("#key-probe").type = "text"')
  }
})

test("MCP stdio drives the same native app and preserves RPC error details", async ({ window }, testInfo) => {
  test.skip(process.platform !== "darwin", "Native keyboard integration")
  const child = spawn(cli, ["--socket", fixtureEndpoint(testInfo.workerIndex), "--window", "main", "mcp"])
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  const lines = createInterface({ input: child.stdout })
  let stderr = ""
  child.stderr.on("data", (data) => {
    stderr += data
  })
  let id = 0
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const failAll = (error: Error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  child.on("error", failAll)
  child.on("close", () => failAll(new Error(`MCP exited: ${stderr}`)))
  lines.on("line", (line) => {
    try {
      const response = JSON.parse(line) as JsonRpcResponse
      const request = typeof response.id === "number" ? pending.get(response.id) : undefined
      if (request && typeof response.id === "number") {
        pending.delete(response.id)
        if (response.error) request.reject(new Error(JSON.stringify(response.error)))
        else request.resolve(response.result)
      }
    } catch (error) {
      failAll(error as Error)
    }
  })
  async function call<T>(method: string, params: object): Promise<T> {
    const requestId = ++id
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return (await new Promise<unknown>((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        timer = setTimeout(() => reject(new Error(`MCP ${method} timed out: ${stderr}`)), 15_000)
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`)
      })) as T
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
    await window.evaluate('sessionStorage.setItem("hasgard-mcp-scenario", "ready")')
    const scenario = await call<ToolResult>("tools/call", {
      name: "hasgard.run_scenario",
      arguments: {
        toml: '[scenario]\nglobal_timeout_ms=5000\n[[step]]\naction="storage-get"\nkey="hasgard-mcp-scenario"\nsession=true\nexpected="ready"\n'
      }
    })
    expect(scenario.isError).toBe(false)
    expect(scenario.structuredContent.result?.passed).toBe(1)
    await window.evaluate('sessionStorage.removeItem("hasgard-mcp-scenario")')
    const listing = await call<ToolListing>("tools/list", {})
    const press = listing.tools.find((tool) => tool.name === "hasgard.press")
    if (!press) throw new Error("tools/list did not include hasgard.press")
    expect(press.inputSchema.properties.completion.enum).toEqual(["webview", "native"])
    await window.evaluate('document.querySelector("#key-probe").type = "password"')
    await window.locator("#key-probe").fill("")
    const result = await call<ToolResult>("tools/call", {
      name: press.name,
      arguments: { key: "m", wait_for: 'document.querySelector("#key-probe").value === "m"', timeout: 1000 }
    })
    expect(result.isError).toBe(false)
    expect(result.structuredContent.result).toEqual({ ok: true })
    const failure = await call<ToolResult>("tools/call", {
      name: press.name,
      arguments: { key: "s", wait_for: "false", timeout: 0 }
    })
    expect(failure.isError).toBe(true)
    expect(failure.structuredContent.rpcError?.data).toEqual({ phase: "postcondition", injected: true })
    await expect(window.locator("#key-probe").inputValue()).resolves.toBe("ms")
    const rejected = await call<ToolResult>("tools/call", {
      name: press.name,
      arguments: { key: "m", window: "absent-window" }
    })
    expect(rejected.isError).toBe(true)
    expect(rejected.structuredContent.rpcError?.data).toEqual({ phase: "focus", injected: false })
    await expect(window.locator("#key-probe").inputValue()).resolves.toBe("ms")
    const native = await call<ToolResult>("tools/call", {
      name: press.name,
      arguments: { key: "Shift", completion: "native" }
    })
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

test("CLI TOML storage assertions preserve empty values and reject missing keys", async ({ window }, testInfo) => {
  const path = testInfo.outputPath("storage.toml")
  await window.evaluate('localStorage.setItem("hasgard-scenario", "")')
  try {
    await writeFile(
      path,
      '[scenario]\nglobal_timeout_ms=5000\n[[step]]\naction="storage-get"\nkey="hasgard-scenario"\nexpected=""\n'
    )
    const passed = await command(fixtureEndpoint(testInfo.workerIndex), ["run", path])
    expect(passed.code, passed.stderr).toBe(0)
    await writeFile(
      path,
      '[scenario]\nglobal_timeout_ms=5000\n[[step]]\naction="storage-get"\nkey="hasgard-absent"\nexpected=""\n'
    )
    const failed = await command(fixtureEndpoint(testInfo.workerIndex), ["run", path])
    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain("storage key was not found")
  } finally {
    await window.evaluate('localStorage.removeItem("hasgard-scenario")')
  }
})
