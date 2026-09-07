import { createConnection, type Socket } from "node:net"
import { createInterface, type Interface } from "node:readline"
import { parseRpcResponse, type RpcResponse } from "./protocol.js"
import { MAX_REQUEST_BYTES } from "./protocol-limits.js"
import type { JsonValue } from "./types.js"

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

    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout)
          socket.off("connect", connected)
          socket.off("error", failed)
          socket.off("close", closed)
        }
        const connected = () => {
          cleanup()
          resolve()
        }
        const failed = (error: Error) => {
          cleanup()
          reject(error)
        }
        const closed = () => failed(new Error("Hasgard socket closed while connecting"))
        const timeout = setTimeout(() => {
          failed(new Error(`Hasgard socket connection timed out after ${timeoutMs}ms: ${this.socketPath}`))
          socket.destroy()
        }, timeoutMs)
        socket.once("connect", connected)
        socket.once("error", failed)
        socket.once("close", closed)
      })
    } catch (error) {
      if (this.socket === socket) this.socket = undefined
      socket.destroy()
      throw error
    }

    this.lines = createInterface({ input: socket })
    this.lines.on("line", line => this.handleLine(line))
    socket.on("close", () => {
      if (this.socket !== socket) return
      this.rejectPending(new Error("Hasgard socket closed"))
      this.disconnect()
    })
    socket.on("error", error => {
      if (this.socket === socket) this.rejectPending(error)
    })
  }

  async call<T>(method: string, params?: Record<string, JsonValue>): Promise<T> {
    const socket = this.socket
    if (!socket || socket.destroyed || !socket.writable) throw new Error("Hasgard RPC client is not connected")

    const id = this.nextId
    this.nextId += 1
    const request = params ? { jsonrpc: "2.0", id, method, params } : { jsonrpc: "2.0", id, method }
    const line = `${JSON.stringify(request)}\n`
    const bytes = Buffer.byteLength(line, "utf8")
    if (bytes > MAX_REQUEST_BYTES) {
      throw new Error(`Hasgard request is ${bytes} bytes; maximum is ${MAX_REQUEST_BYTES} bytes including newline`)
    }

    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject
      })
    })

    socket.write(line, error => {
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
    let response: RpcResponse
    try {
      response = parseRpcResponse(line)
    } catch (error) {
      this.rejectPending(error instanceof Error ? error : new Error(String(error)))
      return
    }

    if ("error" in response && response.id === null) {
      this.rejectPending(new HasgardRpcError(response.error.code, response.error.message, response.error.data))
      return
    }

    const pending = response.id === null ? undefined : this.pending.get(response.id)
    if (!pending) {
      this.rejectPending(new Error(`Unexpected Hasgard JSON-RPC response id: ${response.id}`))
      return
    }
    this.pending.delete(response.id as number)

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
