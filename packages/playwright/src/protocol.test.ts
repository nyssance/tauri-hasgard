import { readFileSync } from "node:fs"

import { expect, test } from "vitest"

import { parseRpcResponse } from "./protocol.js"

const cases = JSON.parse(readFileSync(new URL("../../../protocol/responses.json", import.meta.url), "utf8")) as {
  name: string
  valid: boolean
  response: unknown
}[]

test.each(cases)("shared response contract: $name", ({ valid, response }) => {
  const line = JSON.stringify(response)
  if (valid) expect(parseRpcResponse(line)).toEqual(response)
  else expect(() => parseRpcResponse(line)).toThrow()
})
