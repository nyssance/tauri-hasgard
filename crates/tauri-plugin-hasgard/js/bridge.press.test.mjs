import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { runInNewContext } from "node:vm"

const source = readFileSync(new URL("./bridge.js", import.meta.url), "utf8")
const observerSource = source.slice(
  source.indexOf("  const pendingPresses ="),
  source.indexOf("  window.__HASGARD__ =")
)

// Unit-level event observation only. Real trusted delivery is covered by the
// native multi-window E2E suite; this harness exercises ordering and cleanup.
function observer() {
  const listeners = new Map()
  const timers = new Set()
  const context = {
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
    removeEventListener(type) {
      listeners.delete(type)
    }
  }
  const api = runInNewContext(`${observerSource}; ({ preparePress, waitPress, cancelPress })`, {
    document: { querySelectorAll: () => [], defaultView: context },
    setTimeout(callback) {
      timers.add(callback)
      return callback
    },
    clearTimeout(callback) {
      timers.delete(callback)
    }
  })
  api.preparePress({ token: 1 })
  return {
    ...api,
    listeners,
    timers,
    emit(type, code, isTrusted = true) {
      listeners.get(type)?.({ code, isTrusted })
    }
  }
}

for (const order of [
  [
    ["keydown", "ShiftLeft"],
    ["keydown", "KeyK"],
    ["keyup", "KeyK"],
    ["keyup", "ShiftLeft"]
  ],
  [
    ["keydown", "ShiftLeft"],
    ["keyup", "ShiftLeft"],
    ["keyup", "KeyK"],
    ["keydown", "KeyK"]
  ]
]) {
  test(`native completion accepts paired events: ${order.map(([type, code]) => `${type}:${code}`).join(" ")}`, async () => {
    const probe = observer()
    for (const [type, code] of order) probe.emit(type, code)
    assert.equal((await probe.waitPress({ token: 1 })).ok, true)
    assert.equal(probe.listeners.size, 0)
    probe.cancelPress({ token: 1 })
    assert.equal(probe.timers.size, 0)
  })
}

for (const missing of ["main keydown", "modifier keyup", "trusted keyup", "matching keyup"]) {
  test(`native completion rejects missing ${missing}`, async () => {
    const probe = observer()
    probe.emit("keydown", "ShiftLeft")
    if (missing !== "main keydown") probe.emit("keydown", "KeyK")
    probe.emit("keyup", missing === "matching keyup" ? "KeyJ" : "KeyK", missing !== "trusted keyup")
    if (missing !== "modifier keyup") probe.emit("keyup", "ShiftLeft")
    const result = probe.waitPress({ token: 1 })
    assert.equal(probe.listeners.size, 2)
    for (const expire of probe.timers) expire()
    await assert.rejects(result, /timed out/)
    assert.equal(probe.listeners.size, 0)
  })
}
