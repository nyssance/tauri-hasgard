// Every capability added to the client is exercised here against a real
// WKWebView/WebKitGTK/WebView2, not a mocked DOM. The unit suites pin intent;
// this suite is the only thing that can catch a mock that lies about how the
// real engine behaves — event dispatch, label association, computed geometry,
// and storage all differ from a hand-built stub in ways a unit test cannot see.

import { expect, test } from "../fixtures.js"

test("finds a button by the text it shows, not the accessible name that outranks it", async ({ window }) => {
  // #labelled reports "Save profile" as its snapshot name; the visible text is
  // "Submit changes". A name-based locator could only ever reach the former.
  await expect(window.getByText("Submit changes").count()).resolves.toBe(1)
  await expect(window.getByRole("button", { name: "Save profile", exact: true }).count()).resolves.toBe(1)
})

test("finds a control by placeholder even though its label wins the accessible name", async ({ window }) => {
  await expect(window.getByPlaceholder("Type to filter").count()).resolves.toBe(1)
  await expect(window.getByLabel("Search records").count()).resolves.toBe(1)

  await window.getByPlaceholder("Type to filter").fill("hasgard")
  await expect(window.locator("#search").inputValue()).resolves.toBe("hasgard")
})

test("matches a test id exactly so a prefix cannot select its sibling", async ({ window }) => {
  await expect(window.getByTestId("save").count()).resolves.toBe(1)
  await expect(window.getByTestId("save").textContent()).resolves.toBe("Save it")
  await expect(window.getByTestId("save-draft").textContent()).resolves.toBe("Draft it")
})

test("text matching is case-insensitive by default and exact on request", async ({ window }) => {
  await expect(window.getByText("submit CHANGES").count()).resolves.toBe(1)
  await expect(window.getByText("submit CHANGES", { exact: true }).count()).resolves.toBe(0)
  await expect(window.getByText("Submit changes", { exact: true }).count()).resolves.toBe(1)
})

test("check and uncheck are idempotent where a repeated toggle would invert", async ({ window }) => {
  const agree = window.locator("#agree")

  await agree.check()
  await agree.check()
  await expect(agree.isChecked()).resolves.toBe(true)

  await agree.uncheck()
  await agree.uncheck()
  await expect(agree.isChecked()).resolves.toBe(false)

  await agree.toggle()
  await expect(agree.isChecked()).resolves.toBe(true)
})

test("reports disabled from both the property and aria-disabled", async ({ window }) => {
  await expect(window.locator("#locked").isDisabled()).resolves.toBe(true)
  await expect(window.locator("#aria-locked").isDisabled()).resolves.toBe(true)
  await expect(window.locator("#save").isDisabled()).resolves.toBe(false)
  await expect(window.locator("#save").isEnabled()).resolves.toBe(true)
})

test("dispatches hover and dblclick that the page's own listeners accept", async ({ window }) => {
  await expect(window.locator("#hover-state").textContent()).resolves.toBe("idle")
  await window.locator("#hover-target").hover()
  await expect(window.locator("#hover-state").textContent()).resolves.toBe("hovered")

  await window.locator("#dbl-target").dblclick()
  await expect(window.locator("#dbl-count").textContent()).resolves.toBe("1")
})

test("moves focus in and out of a real input", async ({ window }) => {
  await window.locator("#search").focus()
  await expect(window.locator("#focus-state").textContent()).resolves.toBe("focused")
  await window.locator("#search").blur()
  await expect(window.locator("#focus-state").textContent()).resolves.toBe("blurred")
})

test("measures a real element and scrolls its own scrollport", async ({ window }) => {
  const box = await window.locator("#scroller").boundingBox()
  expect(box.width).toBeGreaterThan(0)
  expect(box.height).toBeGreaterThan(0)

  await window.locator("#scroller").scrollBy({ direction: "down", amount: 120 })
  await expect(window.evaluate("document.querySelector('#scroller').scrollTop")).resolves.toBe(120)
})

test("ordinal locators resolve against the live document", async ({ window }) => {
  const turns = window.locator("[data-turn]")
  await expect(turns.count()).resolves.toBe(80)
  await expect(turns.first().getAttribute("data-turn")).resolves.toBe("1")
  await expect(turns.last().getAttribute("data-turn")).resolves.toBe("80")
  await expect(turns.nth(41).getAttribute("data-turn")).resolves.toBe("42")
  await expect(turns.nth(-2).getAttribute("data-turn")).resolves.toBe("79")
  await expect(turns.nth(500).count()).resolves.toBe(0)
})

test("waits on a condition that never mutates the DOM before it fires", async ({ window }) => {
  const value = await window.waitForFunction<string>(
    "document.querySelector('#delayed').textContent === 'ready' ? 'ready' : ''",
    { timeoutMs: 5_000, pollMs: 25 }
  )
  expect(value).toBe("ready")
})

test("a failing predicate surfaces its own error instead of a bare timeout", async ({ window }) => {
  await expect(window.waitForFunction("window.__absent.field", { timeoutMs: 3_000 })).rejects.toThrow(
    /expression threw/
  )
})

test("reads element HTML and attributes from the live tree", async ({ window }) => {
  await expect(window.locator("#labelled").getAttribute("aria-label")).resolves.toBe("Save profile")
  await expect(window.locator("#labelled").getAttribute("data-absent")).resolves.toBeNull()
  await expect(window.locator("#dbl-target").innerHTML()).resolves.toContain("Double click target")
})

test("reads console output from the running app", async ({ window }) => {
  const logs = await window.consoleLogs({ level: "warn" })
  expect(logs.some(entry => entry.args.includes("fixture warning marker"))).toBe(true)
})

// Drives the whole storage lifecycle from inside the test rather than reading a
// value the app wrote at startup. Web storage under a custom `tauri://` scheme
// does not reliably read back a first-launch write, so a test that depended on
// one passed locally only because an earlier run had left the key on disk — and
// would fail on any clean CI machine.
test("round-trips web storage from a known-empty state", async ({ window }) => {
  await window.storage.clear()
  await expect(window.storage.get("written-by-test")).resolves.toBeNull()

  await window.storage.set("written-by-test", "1")
  await expect(window.storage.get("written-by-test")).resolves.toBe("1")

  const listing = await window.storage.list()
  expect(listing.entries.some(entry => entry.key === "written-by-test")).toBe(true)

  await window.storage.set("session-scoped", "s", { session: true })
  await expect(window.storage.get("session-scoped", { session: true })).resolves.toBe("s")
  await expect(window.storage.get("session-scoped")).resolves.toBeNull()

  await window.storage.clear()
  await expect(window.storage.get("written-by-test")).resolves.toBeNull()
})

test("diffs the accessibility tree across a real interaction", async ({ window }) => {
  await window.snapshot()
  await window.getByRole("textbox", { name: "Display name" }).fill("Aiolia")
  await window.getByRole("button", { name: "Save", exact: true }).click()

  const diff = await window.diff()
  const touched = [...diff.added, ...diff.changed.map(change => change.new)]
  expect(touched.some(element => (element.name ?? "").includes("Aiolia"))).toBe(true)
})

test("reports the page title and URL without a full state read", async ({ window }) => {
  await expect(window.title()).resolves.toBe("Hasgard fixture")
  await expect(window.url()).resolves.toBe("tauri://localhost")
})

test("resolves its own operating-system window id", async ({ hasgard, window }) => {
  const listing = await hasgard.windows()
  const main = listing.find(entry => entry.label === "main")
  expect(main?.nativeId).toBeGreaterThan(0)
  await expect(window.nativeId()).resolves.toBe(main?.nativeId)
})

test("captures the native window without being told its id", async ({ window }, testInfo) => {
  test.skip(process.platform !== "darwin", "native capture is macOS-only")

  const outputPath = testInfo.outputPath("native.png")
  const shot = await window.screenshotNative({ outputPath })

  // Screen recording permission is a machine-level grant this suite cannot
  // make. Without it the capture still reports its metadata, so assert the
  // resolution path either way and the pixels only when TCC allowed them.
  expect(shot.window_id).toBeGreaterThan(0)
  expect(shot.output_path).toBe(outputPath)
  if (!shot.tcc_denied) {
    expect(shot.width).toBeGreaterThan(0)
    expect(shot.height).toBeGreaterThan(0)
    expect(shot.byte_size).toBeGreaterThan(1_000)
  }
})
