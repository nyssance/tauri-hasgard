import { readFile, rm } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { afterEach, describe, expect, test } from "vitest"
import { MAX_REQUEST_BYTES } from "./protocol-limits.js"
import { HasgardRpcClient, HasgardRpcError } from "./rpc-client.js"

const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\tauri-hasgard-test-${process.pid}`
    : join(tmpdir(), `tauri-hasgard-test-${process.pid}.sock`)

let server: Server | undefined

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) return resolve()
    server.close(error => (error ? reject(error) : resolve()))
  })
  server = undefined
  if (process.platform !== "win32") await rm(socketPath, { force: true })
})

async function listen(respond: (request: { id: number; method: string }) => unknown | Promise<unknown>): Promise<void> {
  if (process.platform !== "win32") await rm(socketPath, { force: true })
  server = createServer(socket => {
    const lines = createInterface({ input: socket })
    lines.on("line", async line => {
      const request = JSON.parse(line) as { id: number; method: string }
      const response = await respond(request)
      socket.write(`${JSON.stringify(response)}\n`)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject)
    server?.listen(socketPath, resolve)
  })
}

describe("HasgardRpcClient", () => {
  test("can reconnect after a failed connection attempt", async () => {
    const client = new HasgardRpcClient(socketPath)
    await expect(client.connect(500)).rejects.toThrow()
    await listen(request => ({ jsonrpc: "2.0", id: request.id, result: true }))
    try {
      await client.connect(1_000)
      await expect(client.call("ping")).resolves.toBe(true)
    } finally {
      client.disconnect()
    }
  })

  test("an old socket closing cannot reject calls on a new connection", async () => {
    await listen(request => ({ jsonrpc: "2.0", id: request.id, result: true }))
    const client = new HasgardRpcClient(socketPath)
    try {
      await client.connect(1_000)
      client.disconnect()
      await client.connect(1_000)
      await expect(client.call("ping")).resolves.toBe(true)
    } finally {
      client.disconnect()
    }
  })

  test("accepts a request exactly at the byte limit including its newline", async () => {
    await listen(request => ({ jsonrpc: "2.0", id: request.id, result: true }))
    const client = new HasgardRpcClient(socketPath)
    await client.connect(1_000)
    try {
      const empty = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { padding: "" } })}\n`
      await expect(
        client.call("ping", { padding: "x".repeat(MAX_REQUEST_BYTES - Buffer.byteLength(empty)) })
      ).resolves.toBe(true)
    } finally {
      client.disconnect()
    }
  })

  test("rejects oversized UTF-8 requests before sending and keeps the connection usable", async () => {
    const received: string[] = []
    await listen(request => {
      received.push(request.method)
      return { jsonrpc: "2.0", id: request.id, result: true }
    })
    const client = new HasgardRpcClient(socketPath)
    await client.connect(1_000)
    try {
      await expect(client.call("eval", { script: "界".repeat(MAX_REQUEST_BYTES / 2) })).rejects.toThrow(
        /maximum is 1048576/
      )
      await expect(client.call("ping")).resolves.toBe(true)
      expect(received).toEqual(["ping"])
    } finally {
      client.disconnect()
    }
  })

  test("rejects malformed envelopes over the transport without throwing from the line handler", async () => {
    const cases: { valid: boolean; response: unknown }[] = JSON.parse(
      await readFile(new URL("../../../protocol/responses.json", import.meta.url), "utf8")
    )
    const invalid = cases.filter(item => !item.valid)
    let index = 0
    await listen(() => invalid[index++]?.response)
    const client = new HasgardRpcClient(socketPath)
    await client.connect(1_000)
    try {
      for (const item of invalid) {
        await expect(client.call("ping"), JSON.stringify(item.response)).rejects.toThrow(/Invalid Hasgard/)
      }
    } finally {
      client.disconnect()
    }
  })

  test("keeps an explicit null result and rejects uncorrelated server errors", async () => {
    await listen(request =>
      request.method === "eval"
        ? { jsonrpc: "2.0", id: request.id, result: null }
        : { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }
    )
    const client = new HasgardRpcClient(socketPath)
    await client.connect(1_000)
    try {
      await expect(client.call("eval")).resolves.toBeNull()
      await expect(client.call("ping")).rejects.toEqual(new HasgardRpcError(-32700, "Parse error", undefined))
    } finally {
      client.disconnect()
    }
  })

  test("matches concurrent out-of-order JSON-RPC responses by id", async () => {
    await listen(async request => {
      if (request.method === "slow") await new Promise(resolve => setTimeout(resolve, 20))
      return { jsonrpc: "2.0", id: request.id, result: request.method }
    })
    const client = new HasgardRpcClient(socketPath)
    await client.connect(1_000)

    const [slow, fast] = await Promise.all([client.call<string>("slow"), client.call<string>("fast")])

    expect(slow).toBe("slow")
    expect(fast).toBe("fast")
    client.disconnect()
  })

  test("surfaces protocol errors with code and data", async () => {
    await listen(request => ({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32602, message: "bad target", data: { field: "ref" } }
    }))
    const client = new HasgardRpcClient(socketPath)
    await client.connect(1_000)

    await expect(client.call("click")).rejects.toEqual(new HasgardRpcError(-32602, "bad target", { field: "ref" }))
    client.disconnect()
  })
})
