import type { JsonValue } from "./types.js"

export type RpcResponse =
  | { jsonrpc: "2.0"; id: number; result: JsonValue }
  | { jsonrpc: "2.0"; id: number | null; error: { code: number; message: string; data?: JsonValue } }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Validate the shared Hasgard envelope without inventing missing results. */
export function parseRpcResponse(line: string): RpcResponse {
  const value: unknown = JSON.parse(line)
  const invalid = () => new Error(`Invalid Hasgard JSON-RPC envelope: ${line}`)
  if (!isObject(value) || value.jsonrpc !== "2.0" || !Object.hasOwn(value, "id")) throw invalid()
  if (value.id !== null && (!Number.isSafeInteger(value.id) || (value.id as number) < 0)) throw invalid()
  const hasResult = Object.hasOwn(value, "result")
  const hasError = Object.hasOwn(value, "error")
  if (hasResult === hasError) throw invalid()
  if (hasResult && value.id === null) throw invalid()
  if (hasError) {
    const error = value.error
    if (
      !isObject(error) ||
      !Number.isInteger(error.code) ||
      (error.code as number) < -2147483648 ||
      (error.code as number) > 2147483647 ||
      typeof error.message !== "string"
    )
      throw invalid()
  }
  return value as RpcResponse
}
