import { rm } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { afterEach, describe, expect, test } from "vitest"
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
