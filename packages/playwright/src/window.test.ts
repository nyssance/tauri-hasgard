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
