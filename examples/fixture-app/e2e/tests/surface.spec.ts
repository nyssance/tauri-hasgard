// Every capability added to the client is exercised here against a real
// WKWebView/WebKitGTK/WebView2, not a mocked DOM. The unit suites pin intent;
// this suite is the only thing that can catch a mock that lies about how the
// real engine behaves — event dispatch, label association, computed geometry,
// and storage all differ from a hand-built stub in ways a unit test cannot see.

import { readFile } from "node:fs/promises"

import type { HasgardWindow } from "@nyssance/tauri-hasgard"

import { expect, test } from "../fixtures.js"

test("missing elements are not visible while query and transport errors still fail", async ({ hasgard, window }) => {
  await expect(window.locator("#definitely-absent")).not.toBeVisible({ timeout: 0 })
  await expect(window.getByRole("button", { name: "definitely absent", exact: true })).not.toBeVisible({ timeout: 0 })
  await expect(window.locator("button").nth(10000)).not.toBeVisible({ timeout: 0 })
  await expect(expect(window.locator("[")).not.toBeVisible({ timeout: 0 })).rejects.toThrow()
  await expect(
    expect(hasgard.window("missing-window").locator("button")).not.toBeVisible({ timeout: 0 })
  ).rejects.toThrow()
})

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
  // Start from a known-unfocused state. An earlier test fills #search — it
  // carries the "Type to filter" placeholder — and `fill` focuses the control.
  // Calling `.focus()` on the already-focused element fires no focus event, so
  // the probe would keep whatever it last said and this test would read a stale
  // answer. That is exactly how it failed on one macOS runner and not another.
  await window.evaluate("(document.activeElement?.blur(), document.querySelector('#focus-state').textContent = 'none')")
  await expect(window.locator("#focus-state").textContent()).resolves.toBe("none")

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
  expect(logs.some((entry) => entry.args.includes("fixture warning marker"))).toBe(true)
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
  expect(listing.entries.some((entry) => entry.key === "written-by-test")).toBe(true)

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
  const touched = [...diff.added, ...diff.changed.map((change) => change.new)]
  expect(touched.some((element) => (element.name ?? "").includes("Aiolia"))).toBe(true)
})

test("snapshot baselines stay isolated between real windows", async ({ hasgard, window }) => {
  const settings = hasgard.window("settings")
  await hasgard.waitForWindowReady("settings", 'html[data-hasgard-ready="true"]', 10_000)
  await window.snapshot()
  await settings.snapshot()
  await expect(window.diff()).resolves.toEqual({ added: [], removed: [], changed: [] })
  await expect(settings.diff()).resolves.toEqual({ added: [], removed: [], changed: [] })
  await expect(window.diff({ reference: {} as never })).rejects.toThrow(/elements array/)
})

test("reports the page title and URL without a full state read", async ({ window }) => {
  await expect(window.title()).resolves.toBe("Hasgard fixture")
  await expect(window.url()).resolves.toBe(
    process.platform === "win32" ? "http://tauri.localhost/" : "tauri://localhost"
  )
})

// `nativeId` is present only where native capture exists, so a client can tell
// "this platform cannot capture natively" from "this window has no id". Both
// halves of that contract are asserted, rather than skipping the platforms that
// take the other branch — skipping is how the missing-id case went unnoticed
// until CI ran it.
test("resolves its own operating-system window id", async ({ hasgard, window }) => {
  const listing = await hasgard.windows()
  const main = listing.find((entry) => entry.label === "main")

  if (process.platform !== "darwin") {
    expect(main?.nativeId).toBeUndefined()
    await expect(window.nativeId()).rejects.toThrow(/no native window id/)
    return
  }

  expect(main?.nativeId).toBeGreaterThan(0)
  await expect(window.nativeId()).resolves.toBe(main?.nativeId)
})

test("captures the webview through WebKit without being told a window id", async ({ window }, testInfo) => {
  test.skip(process.platform !== "darwin", "native capture is macOS-only")

  const outputPath = testInfo.outputPath("native.png")
  await window.press("Shift")
  const shot = await window.screenshotNative({ outputPath })
  // WebKit renders the pixels itself, so no screen-recording grant is involved
  // and the capture is never degraded to a TCC fallback.
  expect(shot.backend).toBe("wkwebview")
  expect(shot.tcc_denied).toBe(false)
  expect(shot.window_id).toBeGreaterThan(0)
  expect(shot.output_path).toBe(outputPath)
  const scale = await window.evaluate<number>("window.devicePixelRatio")
  expect(shot.scale_factor).toBeCloseTo(scale, 2)
  const viewport = await window.evaluate<{ width: number; height: number }>(
    "({ width: window.innerWidth, height: window.innerHeight })"
  )
  expect(shot.width).toBe(Math.round(viewport.width * shot.scale_factor))
  // The view extends under a full-size-content title bar, so it may be a
  // little taller than the layout viewport but never shorter.
  expect(shot.height).toBeGreaterThanOrEqual(Math.round(viewport.height * shot.scale_factor))
  expect(shot.byte_size).toBeGreaterThan(1_000)
})

test("native screenshots stay scoped to differently sized windows", async ({ hasgard, window }, testInfo) => {
  test.skip(process.platform !== "darwin", "native capture is macOS-only")
  await window.locator("#open-settings").click()
  const settings = await hasgard.waitForWindowReady("settings", 'html[data-hasgard-ready="true"]', 5_000)
  const mainShot = await window.screenshotNative({ outputPath: testInfo.outputPath("main-scoped.png") })
  const settingsShot = await settings.screenshotNative({ outputPath: testInfo.outputPath("settings-scoped.png") })

  expect(mainShot.window_id).toBe(await window.nativeId())
  expect(settingsShot.window_id).toBe(await settings.nativeId())
  expect(settingsShot.window_id).not.toBe(mainShot.window_id)
  const width = await settings.evaluate<number>("innerWidth * devicePixelRatio")
  expect(settingsShot.width).toBe(Math.round(width))
  expect(settingsShot.width).toBeLessThan(mainShot.width)
  await expect(
    hasgard.window("missing-window").screenshotNative({ outputPath: testInfo.outputPath("missing.png") })
  ).rejects.toThrow(/not found/)
})

test("heap snapshots hold the page's live objects and leave the webview usable", async ({
  hasgard,
  window
}, testInfo) => {
  test.skip(process.platform !== "darwin" && process.platform !== "win32", "heap snapshots need WebKit or WebView2")
  await window.evaluate(
    "window.__heapProbe = Array.from({ length: 2000 }, () => new (class HasgardHeapProbe {})()); true"
  )
  const format = process.platform === "darwin" ? "jsc" : "v8"
  // Twice in a row: the inspector backend is detached after each snapshot and must reattach.
  for (const name of ["first", "second"]) {
    const outputPath = testInfo.outputPath(`${name}.heap.json`)
    const snapshot = await window.heapSnapshot(outputPath)
    expect(snapshot).toEqual({ outputPath, byteSize: expect.any(Number), format })
    const text = await readFile(outputPath, "utf8")
    expect(text.length).toBe(snapshot.byteSize)
    expect(text).toContain("HasgardHeapProbe")
  }
  expect(await window.evaluate<number>("window.__heapProbe.length")).toBe(2000)
  await expect(hasgard.window("missing-window").heapSnapshot(testInfo.outputPath("missing.heap.json"))).rejects.toThrow(
    /not found/
  )
})

// A plain character is the case that used to abort the entire host application:
// enigo's layout lookup calls TSMGetInputSourceProperty, which asserts it is on
// the main dispatch queue and raises SIGTRAP anywhere else. Named keys like Tab
// carry fixed keycodes and never take that path, which is why the crash stayed
// invisible until a character was pressed.
test("delivers a plain character without aborting the host application", async ({ window }) => {
  test.skip(process.platform === "win32", "WebView2 does not expose this native input path")

  await window.locator("#key-probe").click()
  await window.evaluate("document.querySelector('#key-log').textContent = ''")
  await window.press("k")

  // Injection is asynchronous, so wait for the delivered KeyboardEvent.
  await window.waitForFunction("document.querySelector('#key-log').textContent === 'k'", {
    timeoutMs: 5_000,
    pollMs: 25
  })

  // The app survived and is still serving requests.
  await expect(window.title()).resolves.toBe("Hasgard fixture")
})

// A modifier combo holds the modifier down across the main key's own layout
// lookup, so it runs the longest stretch of injection on the main thread.
// Shift+k is deliberately chosen over a Cmd combo: OS-level injection lands on
// whatever window has focus, and a stray Cmd shortcut would fire in whatever
// application the developer happens to be using.
test("delivers a modifier combo with the modifier still applied", async ({ window }) => {
  test.skip(process.platform === "win32", "WebView2 does not expose this native input path")

  await window.locator("#key-probe").click()
  await window.evaluate("document.querySelector('#key-log').textContent = ''")
  await window.press("Shift+k")

  await window.waitForFunction("document.querySelector('#key-log').textContent === 'shift+K'", {
    timeoutMs: 5_000,
    pollMs: 25
  })
})

test("filter narrows a CSS locator that matches several identical elements", async ({ window }) => {
  // All three <li> share tag and class; only their text separates them, and a
  // CSS selector cannot express "the one that says open".
  const tickets = window.locator("#tickets .ticket")
  await expect(tickets.count()).resolves.toBe(3)

  const open = tickets.filter({ hasText: "open" })
  await expect(open.count()).resolves.toBe(2)
  await expect(open.first().textContent()).resolves.toContain("Ticket 1")
})

test("filters compose, and hasNotText subtracts", async ({ window }) => {
  const tickets = window.locator("#tickets .ticket")
  const openButNotFirst = tickets.filter({ hasText: "open" }).filter({ hasNotText: "Ticket 1" })

  await expect(openButNotFirst.count()).resolves.toBe(1)
  await expect(openButNotFirst.textContent()).resolves.toContain("Ticket 3")
})

test("filter applies before nth, so first() means the first match", async ({ window }) => {
  // The alternative reading — index into the unfiltered set, then filter —
  // would make this resolve to Ticket 1 or to nothing at all.
  const second = window.locator("#tickets .ticket").filter({ hasText: "open" }).nth(1)
  await expect(second.textContent()).resolves.toContain("Ticket 3")
})

test("setInputFiles hands the page a real File the change handler can measure", async ({ window }) => {
  await window.locator("#upload").setInputFiles({ name: "notes.txt", data: btoa("hello") })

  // The page reports name:size read back off its own FileList.
  await expect(window.locator("#upload-log").textContent()).resolves.toBe("notes.txt:5")
})

test("setInputFiles reads a path from the test machine's disk", async ({ window }) => {
  const { writeFile } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const path = join(tmpdir(), `hasgard-fixture-upload-${process.pid}.txt`)
  await writeFile(path, "twelve bytes")

  await window.locator("#upload").setInputFiles(path)

  await expect(window.locator("#upload-log").textContent()).resolves.toBe(
    `hasgard-fixture-upload-${process.pid}.txt:12`
  )
})

test("setInputFiles carries a file larger than one request can hold", async ({ window }) => {
  const { rm, writeFile } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const path = join(tmpdir(), `hasgard-fixture-large-${process.pid}.bin`)
  const size = 3 * 1024 * 1024
  await writeFile(path, Buffer.alloc(size, 7))
  try {
    await window.locator("#upload").setInputFiles(path)
    await expect(window.locator("#upload-log").textContent()).resolves.toBe(
      `hasgard-fixture-large-${process.pid}.bin:${size}`
    )
  } finally {
    await rm(path, { force: true })
  }
})

test("setInputFiles clears a selection and rejects overfilling a single-file input", async ({ window }) => {
  await window.locator("#uploads").setInputFiles([
    { name: "a.txt", data: btoa("aa") },
    { name: "b.txt", data: btoa("bbb") }
  ])
  await expect(window.locator("#uploads-log").textContent()).resolves.toBe("a.txt:2,b.txt:3")

  await window.locator("#uploads").setInputFiles([])
  await expect(window.locator("#uploads-log").textContent()).resolves.toBe("none")

  // A browser silently keeps only the last file here; failing loudly is the
  // difference between a caught mistake and a test that asserts the wrong file.
  await expect(
    window.locator("#upload").setInputFiles([
      { name: "a.txt", data: btoa("aa") },
      { name: "b.txt", data: btoa("bb") }
    ])
  ).rejects.toThrow(/not \[multiple\]/)
})

test("setInputFiles refuses a target that would silently ignore the assignment", async ({ window }) => {
  await expect(window.locator("#display-name").setInputFiles([])).rejects.toThrow(/input type="file"/)
})

test("wheel fires the event and moves the real scrollport", async ({ window }) => {
  const scroller = window.locator("#wheel-scroller")
  await expect(window.evaluate("document.querySelector('#wheel-scroller').scrollTop")).resolves.toBe(0)

  const prevented = await scroller.wheel(0, 200)

  expect(prevented).toBe(false)
  await expect(window.locator("#wheel-log").textContent()).resolves.toBe("1")
  // The scroll actually happened — a synthetic WheelEvent alone would leave
  // this at 0 while the listener above still reported a hit.
  await expect(window.evaluate("document.querySelector('#wheel-scroller').scrollTop")).resolves.toBe(200)
})

test("wheel reports a cancelled event and leaves the scrollport alone", async ({ window }) => {
  const blocked = window.locator("#wheel-blocked")

  const prevented = await blocked.wheel(0, 200)

  expect(prevented).toBe(true)
  await expect(window.evaluate("document.querySelector('#wheel-blocked').scrollTop")).resolves.toBe(0)
})

test("a confirm() is answered instead of freezing the webview", async ({ window }) => {
  // Without interception this click never returns and every later call in this
  // file dies on a timeout blaming the wrong thing.
  await window.dialogs.clear()
  await window.locator("#ask-confirm").click()

  await expect(window.locator("#dialog-answer").textContent()).resolves.toBe("confirm:false")

  const listing = await window.dialogs.list()
  expect(listing.dialogs).toHaveLength(1)
  expect(listing.dialogs[0]?.message).toBe("Delete the record?")
  expect(listing.dialogs[0]?.accepted).toBe(false)
})

test("accept flips confirm and can answer a prompt", async ({ window }) => {
  await window.dialogs.accept("Renamed")
  await window.locator("#ask-confirm").click()
  await expect(window.locator("#dialog-answer").textContent()).resolves.toBe("confirm:true")

  await window.locator("#ask-prompt").click()
  await expect(window.locator("#dialog-answer").textContent()).resolves.toBe("prompt:Renamed")

  // Restore the default so ordering between tests cannot leak a policy.
  await window.dialogs.dismiss()
})

test("an alert returns so the handler after it still runs", async ({ window }) => {
  await window.dialogs.clear()
  await window.locator("#ask-alert").click()

  // This line is only reachable because alert() returned.
  await expect(window.locator("#dialog-answer").textContent()).resolves.toBe("alert:returned")
  const listing = await window.dialogs.list()
  expect(listing.dialogs.at(-1)?.type).toBe("alert")
})

test("clear empties a control through the same path as fill", async ({ window }) => {
  const input = window.locator("#display-name")
  await input.fill("Nyssance")
  await expect(input.inputValue()).resolves.toBe("Nyssance")

  await input.clear()

  await expect(input.inputValue()).resolves.toBe("")
})

test("a right click raises contextmenu and never click", async ({ window }) => {
  await window.locator("#mouse-reset").click()
  const log = window.locator("#mouse-log")

  await window.locator("#mouse-target").click({ button: "right" })

  // The sequence, not just the presence of an event: a menu bound to `click`
  // would still fire on a left press and pass a weaker assertion.
  await expect(log.textContent()).resolves.toBe("auxclick:2 contextmenu:2")
})

test("a middle click raises auxclick without contextmenu", async ({ window }) => {
  await window.locator("#mouse-reset").click()
  await window.locator("#mouse-target").click({ button: "middle" })

  await expect(window.locator("#mouse-log").textContent()).resolves.toBe("auxclick:1")
})

test("clickCount 2 escalates detail and ends in one dblclick", async ({ window }) => {
  await window.locator("#mouse-reset").click()
  await window.locator("#mouse-target").click({ clickCount: 2 })

  await expect(window.locator("#mouse-log").textContent()).resolves.toBe("click:0 click:0 dblclick:0")
  await expect(window.locator("#detail-log").textContent()).resolves.toBe("2")
})

test("shift extends a selection the way a real multi-select list reads it", async ({ window }) => {
  const rows = window.locator("#rows .row")
  const log = window.locator("#select-log")

  await rows.nth(0).click()
  await expect(log.textContent()).resolves.toBe("1")

  await rows.nth(1).click({ modifiers: ["Shift"] })
  await expect(log.textContent()).resolves.toBe("1,2")

  // Without the modifier the selection resets, proving the flag reached the page
  // rather than the second click simply accumulating.
  await rows.nth(1).click()
  await expect(log.textContent()).resolves.toBe("2")
})

test("position presses a point inside the element, not its centre", async ({ window }) => {
  const pad = window.locator("#hit-pad")
  const hit = async (): Promise<[number, number]> => {
    const [x, y] = (await window.locator("#hit-log").textContent()).split(",").map(Number)
    return [x, y]
  }
  // One pixel of slack: an element's box lands on fractional coordinates, and
  // the platform rounds the event's own clientX/clientY independently, so an
  // exact equality here fails on a layout that is not off by anything real.
  const near = (actual: number, expected: number) => Math.abs(actual - expected) <= 1

  await pad.click({ position: { x: 10, y: 5 } })
  const [px, py] = await hit()
  expect(near(px, 10) && near(py, 5), `expected near 10,5 but got ${px},${py}`).toBe(true)

  // A 200x100 pad: the centre is 100,50, far enough from 10,5 that the slack
  // above cannot hide a press that ignored `position` entirely.
  await pad.click()
  const [cx, cy] = await hit()
  expect(near(cx, 100) && near(cy, 50), `expected near 100,50 but got ${cx},${cy}`).toBe(true)
})

test("a frame-scoped locator acts inside the frame, not the top document", async ({ window }) => {
  // Both documents carry #pay and #pay-log, so a locator that quietly fell back
  // to the top document would still click something and still find a log.
  const frame = window.frameLocator("#pane")

  await frame.locator("#pay").click()

  await expect(frame.locator("#pay-log").textContent()).resolves.toBe("inner clicked")
  await expect(window.locator("#pay-log").textContent()).resolves.toBe("none")
})

test("the top document is unaffected by the presence of a frame", async ({ window }) => {
  await window.locator("#pay").click()

  await expect(window.locator("#pay-log").textContent()).resolves.toBe("outer clicked")
})

test("text and role locators read the frame's own document", async ({ window }) => {
  const frame = window.frameLocator("#pane")

  await expect(frame.locator("#scope").textContent()).resolves.toBe("inner")
  await expect(window.locator("#scope").textContent()).resolves.toBe("outer")
  await expect(frame.locator(".row").count()).resolves.toBe(3)
})

test("html and an untargeted scroll use the frame's own document", async ({ window }) => {
  const inner = await window.call<string>("html", { frame: ["#pane"] })
  expect(inner).toContain('<h1 id="scope">inner</h1>')
  expect(inner).not.toContain('<h1 id="scope">outer</h1>')
  expect(await window.call<string>("html")).toContain('<h1 id="scope">outer</h1>')

  // The top document must stay where it is when only the frame is asked to scroll.
  const before = await window.evaluate<number>("window.scrollY")
  await window.call("scroll", { direction: "down", amount: 40, frame: ["#pane"] })
  expect(await window.evaluate<number>("window.scrollY")).toBe(before)
})

test("a nested frame chain reaches two levels down", async ({ window }) => {
  const nested = window.frameLocator("#pane").frameLocator("#nested")

  await expect(nested.locator("#scope").textContent()).resolves.toBe("nested")
})

test("a missing frame names the frame, not the element", async ({ window }) => {
  await expect(window.frameLocator("#absent").locator("#pay").click()).rejects.toThrow(
    /No frame matches selector: #absent/
  )
})

/**
 * Fire a network probe and wait for the page to report the answer.
 *
 * The click only starts an async request, so reading `#net-log` straight after
 * it returns whatever the previous test left there. Resetting first and then
 * waiting for the log to move is what makes each of these independent.
 */
async function probeNetwork(window: HasgardWindow, button: "#do-fetch" | "#do-xhr"): Promise<string> {
  await window.locator("#net-reset").click()
  await window.locator(button).click()
  await window.waitForFunction('document.querySelector("#net-log").textContent !== "none"', { timeoutMs: 5_000 })
  return window.locator("#net-log").textContent()
}

test("a fulfilled route answers the page without a backend", async ({ window }) => {
  await window.routes.clear()
  await window.routes.fulfill({ pattern: "**/api/user", status: 503, body: "down" })

  expect(await probeNetwork(window, "#do-fetch")).toBe("fetch:503:down")
})

test("an aborted route fails the request the way a dropped connection does", async ({ window }) => {
  await window.routes.clear()
  await window.routes.abort({ pattern: "**/api/**" })

  expect(await probeNetwork(window, "#do-fetch")).toBe("fetch:error:TypeError")
})

test("XHR is routed too, not just fetch", async ({ window }) => {
  await window.routes.clear()
  await window.routes.fulfill({ pattern: "**/api/user", status: 418, body: "teapot" })

  expect(await probeNetwork(window, "#do-xhr")).toBe("xhr:418:teapot")
})

test("times lets the first call fail and the next one through", async ({ window }) => {
  await window.routes.clear()
  await window.routes.fulfill({ pattern: "**/api/user", status: 500, body: "once", times: 1 })

  expect(await probeNetwork(window, "#do-fetch")).toBe("fetch:500:once")
  // The second call is no longer matched, so whatever answers it is not the rule.
  expect(await probeNetwork(window, "#do-fetch")).not.toBe("fetch:500:once")

  const listing = await window.routes.list()
  expect(listing.routes[0]?.used).toBe(1)
  expect(listing.intercepted).toHaveLength(1)
})

test("clear lets traffic through again", async ({ window }) => {
  await window.routes.fulfill({ pattern: "**", status: 500, body: "blocked" })
  const { removed } = await window.routes.clear()
  expect(removed).toBeGreaterThan(0)

  // Against the exact response the rule produced, not a substring of it: an
  // unrouted request here gets the app's own index.html, which contains plenty
  // of words the stub body might have shared.
  expect(await probeNetwork(window, "#do-fetch")).not.toBe("fetch:500:blocked")
})

test("radio selection is idempotent and keeps native group exclusivity", async ({ window }) => {
  await window.evaluate(`(() => {
    const host = document.createElement('div'); host.id = 'radio-regression';
    host.innerHTML = '<input id="radio-a" type="radio" name="regression-choice"><input id="radio-b" type="radio" name="regression-choice">';
    document.body.append(host);
  })()`)
  try {
    await window.locator("#radio-a").toggle()
    await window.locator("#radio-a").toggle()
    await expect(window.locator("#radio-a").isChecked()).resolves.toBe(true)
    await window.locator("#radio-b").check()
    await expect(window.locator("#radio-a").isChecked()).resolves.toBe(false)
    await expect(window.locator("#radio-b").isChecked()).resolves.toBe(true)
    await expect(window.locator("#radio-b").uncheck()).rejects.toThrow(/radio/)
    await expect(window.locator("#radio-regression").check()).rejects.toThrow(/checkbox|radio/)
  } finally {
    await window.evaluate("document.getElementById('radio-regression').remove()")
  }
})

test("cross-origin navigation fails before changing the real webview", async ({ window }) => {
  const before = await window.url()
  await expect(window.navigate("https://example.invalid/hasgard")).rejects.toThrow(/Cross-origin/)
  await expect(window.url()).resolves.toBe(before)
  await expect(window.title()).resolves.toBe("Hasgard fixture")
})

test("native video targets a window and reports permission failures explicitly", async ({ window }, testInfo) => {
  test.skip(process.platform !== "darwin", "Native compositor recording is macOS-only")
  const outputPath = testInfo.outputPath("native-window.mp4")
  try {
    await window.startVideo({ outputPath, fps: 2, maxDurationMs: 1000 })
  } catch (error) {
    // Hosted runners may not have TCC screen-recording permission. This is an
    // explicit capability failure, never a successful empty video.
    expect(String(error)).toMatch(/Screen Recording permission|native recording process timed out/)
    await testInfo.attach("native-video-capability", {
      body: JSON.stringify({ captured: false, error: String(error) }),
      contentType: "application/json"
    })
    await expect(window.videoStatus()).resolves.toEqual({ active: false, pendingResult: false })
    return
  }
  // Let the bounded session finish so this verifies a sequence of compositor
  // frames and automatic completion, not just encoding the first screenshot.
  await expect(async () => {
    expect((await window.videoStatus()).active).toBe(false)
  }).toPass({ timeout: 10_000 })
  const result = await window.stopVideo()
  await testInfo.attach("native-video-result", {
    body: JSON.stringify({ captured: true, ...result }),
    contentType: "application/json"
  })
  expect(result.outputPath).toBe(outputPath)
  expect(result.frames).toBeGreaterThan(1)
  expect(result.durationMs).toBeGreaterThanOrEqual(1000)
  expect(result.byteSize).toBeGreaterThan(0)
  await expect(window.videoStatus()).resolves.toEqual({ active: false, pendingResult: false })
  await expect(window.stopVideo()).rejects.toThrow(/no video session/)
})

test("an element screenshot has the element's own proportions", async ({ window }) => {
  const box = await window.locator("#hit-pad").boundingBox()
  const png = await window.screenshot("#hit-pad")

  expect(png.subarray(1, 4).toString("latin1")).toBe("PNG")
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  // The capture is in device pixels, so both sides scale by the same factor.
  const scale = width / box.width
  expect(scale).toBeGreaterThanOrEqual(0.99)
  expect(Math.abs(height - box.height * scale)).toBeLessThanOrEqual(2)
})

test("a pending watch observes the action that follows it on the same connection", async ({ window }) => {
  const started = Date.now()
  const watching = window.watch({ selector: "#status", requireMutation: true, timeoutMs: 8_000 })
  await window.locator("#display-name").fill("Pipelined")
  await window.locator("#save").click()

  // `requireMutation` rejects on timeout, so resolving means the watch saw
  // the save. Serial dispatch held the fill behind the watch until it timed out.
  await watching
  expect(Date.now() - started).toBeLessThan(4_000)
  await expect(window.locator("#status")).toHaveText("Saved Pipelined")
})

test("a ref to a removed element is stale instead of silently succeeding", async ({ window }) => {
  await window.evaluate(
    'const b = document.createElement("button"); b.id = "transient"; b.textContent = "Transient"; document.body.append(b); null'
  )
  const found = await window.call<{ elements: { ref: string }[] }>("query", { by: "selector", value: "#transient" })
  const ref = found.elements[0].ref
  await window.call("click", { ref })

  await window.evaluate('document.querySelector("#transient").remove(); null')

  await expect(window.call("click", { ref })).rejects.toThrow(/Stale ref/)
  await expect(window.call("wait", { ref, gone: true, timeout: 1_000 })).resolves.toEqual({ found: true })
})

test("role assertions cover value, state and count without a snapshot per poll", async ({ window }) => {
  await window.getByRole("textbox", { name: "Display name" }).fill("Asserted")

  await expect(window.getByRole("textbox", { name: "Display name" })).toHaveValue("Asserted")
  await expect(window.locator("#locked")).toBeDisabled()
  await expect(window.locator("#save")).toBeEnabled()
  await expect(window.locator("[data-turn]")).toHaveCount(80)
  await expect(window.locator("#status")).not.toContainText("never")
})

test("waitForURL holds across the navigation that reaches it", async ({ hasgard }) => {
  const settings = await hasgard.waitForWindow("settings", 5_000)
  // Registered first: the wait is answered by whichever document is current, not by the one it started in.
  const reached = settings.waitForURL("**/embedded.html", { waitUntil: "load", timeoutMs: 10_000 })
  await settings.navigate("embedded.html")
  await reached
  expect(await settings.url()).toMatch(/embedded\.html$/)

  await expect(settings.waitForURL("**/never.html", { timeoutMs: 300 })).rejects.toThrow(/Timeout waiting/)

  await settings.navigate("settings.html")
  await settings.waitForURL(/settings\.html$/, { timeoutMs: 10_000 })
  await settings.waitForLoadState("load")
})

test("the native window reports its state and takes a new size and position", async ({ window }) => {
  const before = await window.nativeState()
  expect(before.label).toBe("main")
  expect(before.visible).toBe(true)
  expect(before.minimized).toBe(false)
  expect(before.width).toBeGreaterThan(100)

  const width = Math.round(before.width) - 60
  const height = Math.round(before.height) - 40
  await window.setSize(width, height)
  // The window manager applies the change after the call returns.
  await expect.poll(async () => (await window.nativeState()).width).toBeCloseTo(width, 0)
  expect((await window.nativeState()).height).toBeCloseTo(height, 0)
  // The page sees the same size the native window reports.
  expect(await window.evaluate<number>("window.innerWidth")).toBeCloseTo(width, 0)

  await window.setPosition(before.x + 24, before.y + 24)
  await expect.poll(async () => (await window.nativeState()).x).toBeCloseTo(before.x + 24, 0)

  await window.setSize(before.width, before.height)
  await window.setPosition(before.x, before.y)
  await expect.poll(async () => (await window.nativeState()).width).toBeCloseTo(before.width, 0)
  await expect(window.setSize(0, 10)).rejects.toThrow(/at least 1/)
})

test("the cookie store takes, lists and deletes a cookie the page cannot read", async ({ window }) => {
  const url = "https://hasgard-cookies.example.test/account"
  await window.clearCookies({ domain: "hasgard-cookies.example.test" })

  const set = await window.setCookie({ name: "session", value: "s3cret", url, httpOnly: true, sameSite: "Lax" })
  expect(set).toMatchObject({ name: "session", domain: "hasgard-cookies.example.test", path: "/", secure: true })

  const listed = await window.cookies({ url, name: "session" })
  expect(listed).toHaveLength(1)
  expect(listed[0]).toMatchObject({ name: "session", value: "s3cret", httpOnly: true, secure: true })
  // Not this page's cookie, and HttpOnly besides: page script never sees it.
  expect(await window.evaluate<string>("document.cookie")).not.toContain("s3cret")

  expect(await window.clearCookies({ name: "session", domain: "hasgard-cookies.example.test" })).toBe(1)
  expect(await window.cookies({ url, name: "session" })).toEqual([])
  await expect(window.setCookie({ name: "orphan", value: "x" })).rejects.toThrow(/domain.*url/)
})

test("the system clipboard's text is read and written from the application", async ({ hasgard }) => {
  const before = await hasgard.clipboardText()
  try {
    await hasgard.setClipboardText("hasgard clipboard 剪贴板")
    expect(await hasgard.clipboardText()).toBe("hasgard clipboard 剪贴板")
  } finally {
    // The clipboard belongs to whoever is using the machine.
    if (before !== null) await hasgard.setClipboardText(before)
  }
})

test("native dialogs are answered in advance and recorded, and nothing else is intercepted", async ({ window }) => {
  const log = window.locator("#native-log")
  expect((await window.nativeDialogs.list()).policy).toEqual({ action: "manual", paths: [], button: null })
  await window.nativeDialogs.clear()

  // The policy is set before the click: no operating-system dialog ever opens.
  await window.nativeDialogs.accept({ paths: ["/tmp/hasgard-report.csv"] })
  await window.locator("#native-save").click()
  await expect(log).toHaveText('save:"/tmp/hasgard-report.csv"')

  await window.nativeDialogs.accept({ paths: ["/tmp/a.txt", "/tmp/b.txt"] })
  await window.locator("#native-open").click()
  await expect(log).toHaveText('open:["/tmp/a.txt","/tmp/b.txt"]')
  await window.locator("#native-ask").click()
  await expect(log).toHaveText('message:"Yes"')

  await window.nativeDialogs.dismiss()
  await window.locator("#native-save").click()
  await expect(log).toHaveText("save:null")
  await window.locator("#native-ask").click()
  await expect(log).toHaveText('message:"No"')

  const { dialogs } = await window.nativeDialogs.list()
  expect(dialogs.map(({ kind, accepted, title, result }) => ({ kind, accepted, title, result }))).toEqual([
    { kind: "save", accepted: true, title: "Export report", result: "/tmp/hasgard-report.csv" },
    { kind: "open", accepted: true, title: "Attach files", result: ["/tmp/a.txt", "/tmp/b.txt"] },
    { kind: "message", accepted: true, title: "Draft", result: "Yes" },
    { kind: "save", accepted: false, title: "Export report", result: null },
    { kind: "message", accepted: false, title: "Draft", result: "No" }
  ])
  expect(dialogs[2]).toMatchObject({ message: "Discard draft?", buttons: ["Yes", "No"] })

  // The application's own commands still reach its real backend.
  expect(await window.invoke<number>("fixture_process_id", {})).toBeGreaterThan(0)
  expect((await window.nativeDialogs.manual()).action).toBe("manual")
  await window.nativeDialogs.clear()
})

test("routes and the dialog policy hold across a navigation", async ({ hasgard }) => {
  const settings = await hasgard.waitForWindow("settings", 5_000)
  await settings.routes.clear()
  await settings.routes.fulfill({ pattern: "**/api/profile", status: 200, body: "stubbed profile" })
  await settings.dialogs.accept("typed")
  await settings.evaluate("console.info('before navigation')")
  try {
    await settings.navigate("embedded.html")
    await settings.waitForURL("**/embedded.html", { waitUntil: "load", timeoutMs: 10_000 })

    // The new document never saw the calls that set these; it found them standing.
    const read = "fetch('/api/profile').then((response) => response.text())"
    expect(await settings.evaluate<string>(read)).toBe("stubbed profile")
    expect(await settings.evaluate<string | null>("prompt('Name?')")).toBe("typed")
    // The log is of the flow, so what the last document wrote is still in it.
    const logged = (await settings.consoleLogs()).map((entry) => entry.args[0])
    expect(logged).toContain("before navigation")
    const { routes } = await settings.routes.list()
    expect(routes.map(({ pattern, used }) => ({ pattern, used }))).toEqual([{ pattern: "**/api/profile", used: 1 }])
    // The application's session storage does not show Hasgard's own entry.
    expect(await settings.evaluate<number>("sessionStorage.length")).toBeGreaterThan(0)
    expect((await settings.call<{ entries: unknown[] }>("storage.list", { session: true })).entries).toEqual([])
  } finally {
    await settings.routes.clear()
    await settings.dialogs.dismiss()
    expect(await settings.evaluate<number>("sessionStorage.length")).toBe(0)
    await settings.navigate("settings.html")
    await settings.waitForURL(/settings\.html$/, { waitUntil: "load", timeoutMs: 10_000 })
  }
})

test("Tauri events reach the application and its own are recorded", async ({ hasgard, window }) => {
  await hasgard.events.clear()
  // To the application: its listener receives the payload as if the backend had sent it.
  await hasgard.emit("fixture:ping", { from: "test", n: 1 })
  await expect(window.locator("#event-log")).toHaveText('ping:{"from":"test","n":1}')

  // From the application: recorded from the moment the wait begins.
  const saved = hasgard.waitForEvent("fixture:saved", { timeoutMs: 5_000 })
  await hasgard.events.listen("fixture:saved")
  await window.locator("#emit-saved").click()
  expect(await saved).toMatchObject({ event: "fixture:saved", payload: { id: 7 } })

  await window.locator("#emit-saved").click()
  await expect.poll(async () => (await hasgard.events.list({ event: "fixture:saved" })).length).toBe(2)
  const [first, second] = await hasgard.events.list({ event: "fixture:saved" })
  expect(await hasgard.events.list({ sinceId: first.id })).toEqual([second])

  await hasgard.events.unlisten("fixture:saved")
  await hasgard.events.clear()
  expect(await hasgard.events.list()).toEqual([])
  await expect(hasgard.emit("not a name")).rejects.toThrow(/event names may contain only/)
})
