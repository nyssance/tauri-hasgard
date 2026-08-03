import { createConnection, type Socket } from "node:net"
import { createInterface, type Interface } from "node:readline"
import type { JsonValue } from "./types.js"

interface RpcSuccess<T> {
  jsonrpc: "2.0"
  id: number
  result: T
}

interface RpcFailure {
  jsonrpc: "2.0"
  id: number
  error: {
    code: number
    message: string
    data?: JsonValue
  }
}

type RpcResponse<T> = RpcSuccess<T> | RpcFailure

export class HasgardRpcError extends Error {
  readonly code: number
  readonly data: JsonValue | undefined

  constructor(code: number, message: string, data: JsonValue | undefined) {
    super(`Hasgard RPC ${code}: ${message}`)
    this.name = "HasgardRpcError"
    this.code = code
    this.data = data
  }
}

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class HasgardRpcClient {
  readonly socketPath: string
  private socket: Socket | undefined
  private lines: Interface | undefined
  private nextId = 1
  private readonly pending = new Map<number, PendingCall>()

  constructor(socketPath: string) {
    this.socketPath = socketPath
  }

  async connect(timeoutMs: number): Promise<void> {
    if (this.socket) throw new Error("Hasgard RPC client is already connected")

    const socket = createConnection({ path: this.socketPath })
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy()
        reject(new Error(`Hasgard socket connection timed out after ${timeoutMs}ms: ${this.socketPath}`))
      }, timeoutMs)

      socket.once("connect", () => {
        clearTimeout(timeout)
        resolve()
      })
      socket.once("error", error => {
        clearTimeout(timeout)
        reject(error)
      })
    })

    this.lines = createInterface({ input: socket })
    this.lines.on("line", line => this.handleLine(line))
    socket.on("close", () => this.rejectPending(new Error("Hasgard socket closed")))
    socket.on("error", error => this.rejectPending(error))
  }

  async call<T>(method: string, params?: Record<string, JsonValue>): Promise<T> {
    const socket = this.socket
    if (!socket) throw new Error("Hasgard RPC client is not connected")

    const id = this.nextId
    this.nextId += 1
    const request = params ? { jsonrpc: "2.0", id, method, params } : { jsonrpc: "2.0", id, method }

    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject
      })
    })

    socket.write(`${JSON.stringify(request)}\n`, error => {
      if (!error) return
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      pending.reject(error)
    })
    return result
  }

  disconnect(): void {
    this.lines?.close()
    this.lines = undefined
    this.socket?.destroy()
    this.socket = undefined
    this.rejectPending(new Error("Hasgard RPC client disconnected"))
  }

  private handleLine(line: string): void {
    let response: RpcResponse<unknown>
    try {
      response = JSON.parse(line) as RpcResponse<unknown>
    } catch {
      this.rejectPending(new Error(`Invalid Hasgard JSON-RPC response: ${line}`))
      return
    }

    if (response.jsonrpc !== "2.0" || !Number.isInteger(response.id)) {
      this.rejectPending(new Error(`Invalid Hasgard JSON-RPC envelope: ${line}`))
      return
    }

    const pending = this.pending.get(response.id)
    if (!pending) {
      this.rejectPending(new Error(`Unexpected Hasgard JSON-RPC response id: ${response.id}`))
      return
    }
    this.pending.delete(response.id)

    if ("error" in response) {
      pending.reject(new HasgardRpcError(response.error.code, response.error.message, response.error.data))
      return
    }
    pending.resolve(response.result)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
