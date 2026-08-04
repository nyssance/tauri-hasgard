import { expect, test } from "../fixtures.js"

test("fills and submits a form in the main window", async ({ window }) => {
  await window.getByRole("textbox", { name: "Display name" }).fill("Nyssance")
  await window.getByRole("button", { name: "Save", exact: true }).click()
  await expect(window.getByRole("status")).toHaveText("Saved Nyssance")
})

test("opens and closes an HTML dialog in the main window", async ({ window }) => {
  await window.getByRole("button", { name: "Open dialog", exact: true }).click()
  await expect(window.getByRole("dialog")).toBeVisible()
  await window.getByRole("button", { name: "Close", exact: true }).click()
  await expect(window.getByRole("dialog")).not.toBeVisible()
})

test("delivers native keyboard input to the focused webview", async ({ window }) => {
  test.skip(
    process.platform === "win32",
    "WebView2 does not expose browser Tab traversal through this native input path"
  )
  await window.getByRole("textbox", { name: "Display name" }).click()
  await window.press("TAB")
  // OS-level injection is asynchronous: enigo posts the event to the window
  // server and the app receives it on a later turn of its event loop.
  await window.waitForFunction("document.activeElement && document.activeElement.id === 'save'", {
    timeoutMs: 5_000,
    pollMs: 25
  })
})

test("routes commands to a real secondary window without leaking to main", async ({ hasgard, window }) => {
  await window.getByRole("button", { name: "Open settings", exact: true }).click()
  const settings = await hasgard.waitForWindowReady("settings", 'html[data-hasgard-ready="true"]', 5_000)
  await settings.getByRole("combobox", { name: "Theme" }).selectOption("dark")
  await settings.getByRole("button", { name: "Apply", exact: true }).click()
  await expect(settings.getByRole("status")).toHaveText("Applied dark")
  await expect(window.getByRole("heading", { name: "Hasgard fixture", exact: true })).toBeVisible()
})

test("handles 80 unequal-height turns", async ({ window }) => {
  await expect(window.locator("[data-turn]").count()).resolves.toBe(80)
  await expect(window.locator('[data-turn="80"]')).toHaveText(/Turn 80, line 4/)
})

test("captures the real webview", async ({ window }) => {
  const screenshot = await window.screenshot()
  expect(screenshot.byteLength).toBeGreaterThan(1_000)
})
