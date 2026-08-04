import { expect, test, vi } from "vitest"
import { HasgardRpcClient } from "./rpc-client.js"
import { HasgardApplication, HasgardWindow } from "./window.js"

test("waitForWindow does not return an about:blank or loading webview", async () => {
  const rpc = new HasgardRpcClient("/unused")
  const call = vi.spyOn(rpc, "call")
  let stateCall = 0
  call.mockImplementation(async method => {
    if (method === "windows.list") {
      return {
        windows: [
          {
            label: "settings",
            url: "tauri://localhost/settings.html",
            title: "Settings"
          }
        ]
      }
    }
    if (method === "state") {
      stateCall += 1
      return {
        url: stateCall === 1 ? "about:blank" : "tauri://localhost/settings.html",
        title: "Settings",
        readyState: stateCall < 3 ? "loading" : "complete",
        viewport: { width: 800, height: 600 },
        scroll: { x: 0, y: 0 },
        plugin_version: "0.1.0"
      }
    }
    throw new Error(`Unexpected method: ${method}`)
  })

  const window = await new HasgardApplication(rpc).waitForWindow("settings", 1_000)

  expect(window.label).toBe("settings")
  expect(stateCall).toBe(3)
})

test("waitForWindowReady polls the current document instead of installing one long wait", async () => {
  const rpc = new HasgardRpcClient("/unused")
  const call = vi.spyOn(rpc, "call")
  let countCall = 0
  call.mockImplementation(async method => {
    if (method === "windows.list") {
      return {
        windows: [
          {
            label: "settings",
            url: "tauri://localhost/settings.html",
            title: "Settings"
          }
        ]
      }
    }
    if (method === "state") {
      return {
        url: "tauri://localhost/settings.html",
        title: "Settings",
        readyState: "complete",
        viewport: { width: 800, height: 600 },
        scroll: { x: 0, y: 0 },
        plugin_version: "0.1.0"
      }
    }
    if (method === "count") {
      countCall += 1
      return { count: countCall === 1 ? 0 : 1 }
    }
    throw new Error(`Unexpected method: ${method}`)
  })

  const window = await new HasgardApplication(rpc).waitForWindowReady(
    "settings",
    'html[data-hasgard-ready="true"]',
    1_000
  )

  expect(window.label).toBe("settings")
  expect(countCall).toBe(2)
  expect(call).not.toHaveBeenCalledWith("wait", expect.anything())
})

test("role locator refreshes the snapshot and sends the resolved ref to the requested window", async () => {
  const rpc = new HasgardRpcClient("/unused")
  const call = vi.spyOn(rpc, "call")
  call.mockImplementation(async (method, params) => {
    if (method === "snapshot") {
      return {
        elements: [
          { ref: "e1", role: "button", depth: 1, name: "Cancel" },
          { ref: "e2", role: "button", depth: 1, name: "Save" }
        ]
      }
    }
    if (method === "click") return { ok: true }
    throw new Error(`Unexpected method: ${method}`)
  })

  const window = new HasgardWindow(rpc, "settings")
  await window.getByRole("button", { name: "Save", exact: true }).click()

  expect(call).toHaveBeenNthCalledWith(1, "snapshot", { window: "settings" })
  expect(call).toHaveBeenNthCalledWith(2, "click", {
    ref: "e2",
    window: "settings"
  })
})

test("role locator rejects ambiguous matches instead of choosing one", async () => {
  const rpc = new HasgardRpcClient("/unused")
  vi.spyOn(rpc, "call").mockResolvedValue({
    elements: [
      { ref: "e1", role: "button", depth: 1, name: "Save draft" },
      { ref: "e2", role: "button", depth: 1, name: "Save copy" }
    ]
  })

  const locator = new HasgardWindow(rpc, "main").getByRole("button", {
    name: "Save"
  })
  await expect(locator.click()).rejects.toThrow("resolved to 2 elements; expected exactly one")
})

test("selector count validates the bridge object shape", async () => {
  const rpc = new HasgardRpcClient("/unused")
  const call = vi.spyOn(rpc, "call").mockResolvedValue({ count: 80 })
  const window = new HasgardWindow(rpc, "main")

  await expect(window.locator("[data-turn]").count()).resolves.toBe(80)
  expect(call).toHaveBeenCalledWith("count", {
    selector: "[data-turn]",
    window: "main"
  })
})

test("storage.get reports a missing key as null instead of an empty string", async () => {
  const rpc = new HasgardRpcClient("/unused")
  const call = vi.spyOn(rpc, "call").mockResolvedValue({ found: false })
  const window = new HasgardWindow(rpc, "main")

  await expect(window.storage.get("token")).resolves.toBeNull()
  expect(call).toHaveBeenCalledWith("storage.get", {
    key: "token",
    window: "main"
  })
})

test("storage routes sessionStorage through the session flag", async () => {
  const rpc = new HasgardRpcClient("/unused")
  const call = vi.spyOn(rpc, "call").mockResolvedValue({ found: true, value: "abc" })
  const window = new HasgardWindow(rpc, "main")

  await expect(window.storage.get("token", { session: true })).resolves.toBe("abc")
  expect(call).toHaveBeenCalledWith("storage.get", {
    key: "token",
    session: true,
    window: "main"
  })
})

test("getAttribute distinguishes an absent attribute from an empty one", async () => {
  const rpc = new HasgardRpcClient("/unused")
  vi.spyOn(rpc, "call").mockResolvedValue({ disabled: "", id: "save" })
  const locator = new HasgardWindow(rpc, "main").locator("#save")

  await expect(locator.getAttribute("disabled")).resolves.toBe("")
  await expect(locator.getAttribute("hidden")).resolves.toBeNull()
})

test("dragTo resolves source and destination inside one window lock", async () => {
  const rpc = new HasgardRpcClient("/unused")
  const methods: string[] = []
  const call = vi.spyOn(rpc, "call")
  call.mockImplementation(async method => {
    methods.push(method)
    if (method === "snapshot") {
      return {
        elements: [
          { ref: "e1", role: "listitem", depth: 1, name: "Card" },
          { ref: "e2", role: "list", depth: 1, name: "Done" }
        ]
      }
    }
    if (method === "drag") return { ok: true }
    throw new Error(`Unexpected method: ${method}`)
  })
  const window = new HasgardWindow(rpc, "main")

  await window
    .getByRole("listitem", { name: "Card", exact: true })
    .dragTo(window.getByRole("list", { name: "Done", exact: true }))

  expect(methods).toEqual(["snapshot", "snapshot", "drag"])
  expect(call).toHaveBeenLastCalledWith("drag", {
    source: { ref: "e1" },
    target: { ref: "e2" },
    window: "main"
  })
})

test("dragTo refuses locators from two different windows", async () => {
  const rpc = new HasgardRpcClient("/unused")
  const source = new HasgardWindow(rpc, "main").locator("#card")
  const destination = new HasgardWindow(rpc, "settings").locator("#column")

  await expect(source.dragTo(destination)).rejects.toThrow("same window")
})

test("diff parses added, removed, and changed elements", async () => {
  const rpc = new HasgardRpcClient("/unused")
  vi.spyOn(rpc, "call").mockResolvedValue({
    added: [{ ref: "e3", role: "alert", depth: 2, name: "Saved" }],
    removed: [],
    changed: [
      {
        old: { ref: "e1", role: "button", depth: 1, name: "Save", disabled: true },
        new: { ref: "e1", role: "button", depth: 1, name: "Save", disabled: false },
        changes: ["disabled"]
      }
    ]
  })

  const diff = await new HasgardWindow(rpc, "main").diff()

  expect(diff.added[0]?.name).toBe("Saved")
  expect(diff.removed).toEqual([])
  expect(diff.changed[0]?.changes).toEqual(["disabled"])
  expect(diff.changed[0]?.old.disabled).toBe(true)
  expect(diff.changed[0]?.new.disabled).toBe(false)
})

test("consoleLogs rejects a malformed bridge entry instead of yielding a partial one", async () => {
  const rpc = new HasgardRpcClient("/unused")
  vi.spyOn(rpc, "call").mockResolvedValue([{ id: 1, timestamp: 2, level: "warn", args: [], source: null }, { id: 2 }])

  await expect(new HasgardWindow(rpc, "main").consoleLogs()).rejects.toThrow(
    "console.getLogs[1].timestamp must be a number"
  )
})

test("watch maps millisecond options onto the bridge parameter names", async () => {
  const rpc = new HasgardRpcClient("/unused")
  const call = vi.spyOn(rpc, "call").mockResolvedValue({
    added: [{ tag: "li", text: "New row" }],
    removed: [],
    modified: [],
    truncated: false
  })

  const changes = await new HasgardWindow(rpc, "main").watch({
    selector: "#list",
    timeoutMs: 4_000,
    stableMs: 200
  })

  expect(changes.added[0]?.tag).toBe("li")
  expect(call).toHaveBeenCalledWith("watch", {
    selector: "#list",
    timeout: 4_000,
    stable: 200,
    window: "main"
  })
})

test("screenshotNative sends the protocol's snake_case fields and is not window-routed", async () => {
  const rpc = new HasgardRpcClient("/unused")
  const call = vi.spyOn(rpc, "call").mockResolvedValue({
    output_path: "/tmp/shot.png",
    window_id: 42,
    width: 800,
    height: 600,
    scale_factor: 2,
    byte_size: 1024,
    backend: "cgwindow",
    tcc_denied: false
  })

  const shot = await new HasgardApplication(rpc).screenshotNative({
    outputPath: "/tmp/shot.png",
    windowId: 42
  })

  expect(shot.backend).toBe("cgwindow")
  expect(call).toHaveBeenCalledWith("screenshot_native", {
    window_id: 42,
    output_path: "/tmp/shot.png"
  })
})

test("recorder.stop returns the recorded actions with their extra params", async () => {
  const rpc = new HasgardRpcClient("/unused")
  vi.spyOn(rpc, "call").mockResolvedValue({
    entries: [{ action: "click", timestamp: 120, ref: "e3" }],
    count: 1
  })

  const result = await new HasgardApplication(rpc).recorder.stop()

  expect(result.count).toBe(1)
  expect(result.entries[0]).toEqual({ action: "click", timestamp: 120, ref: "e3" })
})

test("waitForFunction returns the predicate's own value and forwards the poll interval", async () => {
  const rpc = new HasgardRpcClient("/unused")
  const call = vi.spyOn(rpc, "call").mockResolvedValue({ found: true, value: 42 })

  const value = await new HasgardWindow(rpc, "main").waitForFunction<number>("window.rows.length", {
    timeoutMs: 3_000,
    pollMs: 25
  })

  expect(value).toBe(42)
  expect(call).toHaveBeenCalledWith("wait", {
    expression: "window.rows.length",
    timeout: 3_000,
    poll: 25,
    window: "main"
  })
})

test("waitForFunction omits timing options so the bridge keeps its own defaults", async () => {
  const rpc = new HasgardRpcClient("/unused")
  const call = vi.spyOn(rpc, "call").mockResolvedValue({ found: true, value: true })

  await new HasgardWindow(rpc, "main").waitForFunction("ready")

  expect(call).toHaveBeenCalledWith("wait", { expression: "ready", window: "main" })
})

test("check and uncheck drive an explicit state rather than toggling", async () => {
  const rpc = new HasgardRpcClient("/unused")
  const call = vi.spyOn(rpc, "call").mockResolvedValue({ ok: true })
  const locator = new HasgardWindow(rpc, "main").locator("#agree")

  await locator.check()
  await locator.uncheck()
  await locator.toggle()

  expect(call).toHaveBeenNthCalledWith(1, "check", { selector: "#agree", checked: true, window: "main" })
  expect(call).toHaveBeenNthCalledWith(2, "check", { selector: "#agree", checked: false, window: "main" })
  expect(call).toHaveBeenNthCalledWith(3, "check", { selector: "#agree", window: "main" })
})

test("nth sends the ordinal with the selector so resolution and action share a round trip", async () => {
  const rpc = new HasgardRpcClient("/unused")
  const call = vi.spyOn(rpc, "call").mockResolvedValue({ ok: true })
  const window = new HasgardWindow(rpc, "main")

  await window.locator(".row").nth(2).click()
  await window.locator(".row").last().click()

  expect(call).toHaveBeenNthCalledWith(1, "click", { selector: ".row", index: 2, window: "main" })
  expect(call).toHaveBeenNthCalledWith(2, "click", { selector: ".row", index: -1, window: "main" })
})

test("nth on a role locator picks from the snapshot instead of erroring on ambiguity", async () => {
  const rpc = new HasgardRpcClient("/unused")
  const call = vi.spyOn(rpc, "call")
  call.mockImplementation(async method => {
    if (method === "snapshot") {
      return {
        elements: [
          { ref: "e1", role: "listitem", depth: 1, name: "Row" },
          { ref: "e2", role: "listitem", depth: 1, name: "Row" },
          { ref: "e3", role: "listitem", depth: 1, name: "Row" }
        ]
      }
    }
    if (method === "click") return { ok: true }
    throw new Error(`Unexpected method: ${method}`)
  })
  const window = new HasgardWindow(rpc, "main")

  await window.getByRole("listitem", { name: "Row", exact: true }).last().click()

  expect(call).toHaveBeenLastCalledWith("click", { ref: "e3", window: "main" })
})

test("nth rejects a fractional index at the call site", () => {
  const rpc = new HasgardRpcClient("/unused")
  expect(() => new HasgardWindow(rpc, "main").locator(".row").nth(1.5)).toThrow("integer index")
})

test("count on an indexed locator reports presence, not the total match count", async () => {
  const rpc = new HasgardRpcClient("/unused")
  vi.spyOn(rpc, "call").mockResolvedValue({ count: 3 })
  const window = new HasgardWindow(rpc, "main")

  await expect(window.locator(".row").count()).resolves.toBe(3)
  await expect(window.locator(".row").nth(1).count()).resolves.toBe(1)
  await expect(window.locator(".row").nth(7).count()).resolves.toBe(0)
  await expect(window.locator(".row").last().count()).resolves.toBe(1)
})

test("waitFor on an indexed locator polls instead of waiting on the bare selector", async () => {
  const rpc = new HasgardRpcClient("/unused")
  const call = vi.spyOn(rpc, "call")
  let counted = 0
  call.mockImplementation(async method => {
    if (method === "count") {
      counted += 1
      return { count: counted < 2 ? 1 : 4 }
    }
    throw new Error(`Unexpected method: ${method}`)
  })

  await new HasgardWindow(rpc, "main").locator(".row").nth(3).waitFor({ state: "attached", timeoutMs: 1_000 })

  expect(counted).toBe(2)
  expect(call).not.toHaveBeenCalledWith("wait", expect.anything())
})

test("isEnabled is the negation of the bridge's disabled verdict", async () => {
  const rpc = new HasgardRpcClient("/unused")
  vi.spyOn(rpc, "call").mockResolvedValue({ disabled: true })
  const locator = new HasgardWindow(rpc, "main").locator("#save")

  await expect(locator.isDisabled()).resolves.toBe(true)
  await expect(locator.isEnabled()).resolves.toBe(false)
})

test("boundingBox validates every numeric field", async () => {
  const rpc = new HasgardRpcClient("/unused")
  vi.spyOn(rpc, "call").mockResolvedValue({ x: 10, y: 20, width: 100 })

  await expect(new HasgardWindow(rpc, "main").locator("#save").boundingBox()).rejects.toThrow(
    "boundingBox.height must be a number"
  )
})

test("keeps snapshot and action atomic for concurrent semantic locators in one window", async () => {
  const rpc = new HasgardRpcClient("/unused")
  const methods: string[] = []
  let snapshot = 0
  vi.spyOn(rpc, "call").mockImplementation(async method => {
    methods.push(method)
    if (method === "snapshot") {
      snapshot += 1
      return {
        elements: [{ ref: `e${snapshot}`, role: "button", depth: 1, name: "Run" }]
      }
    }
    if (method === "click") return { ok: true }
    throw new Error(`Unexpected method: ${method}`)
  })
  const window = new HasgardWindow(rpc, "main")

  await Promise.all([
    window.getByRole("button", { name: "Run", exact: true }).click(),
    window.getByRole("button", { name: "Run", exact: true }).click()
  ])

  expect(methods).toEqual(["snapshot", "click", "snapshot", "click"])
})
