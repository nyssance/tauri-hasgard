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

// `nativeId` is present only where native capture exists, so a client can tell
// "this platform cannot capture natively" from "this window has no id". Both
// halves of that contract are asserted, rather than skipping the platforms that
// take the other branch — skipping is how the missing-id case went unnoticed
// until CI ran it.
test("resolves its own operating-system window id", async ({ hasgard, window }) => {
  const listing = await hasgard.windows()
  const main = listing.find(entry => entry.label === "main")

  if (process.platform !== "darwin") {
    expect(main?.nativeId).toBeUndefined()
    await expect(window.nativeId()).rejects.toThrow(/no native window id/)
    return
  }

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

  await pad.click({ position: { x: 10, y: 5 } })
  await expect(window.locator("#hit-log").textContent()).resolves.toBe("10,5")

  // A 200x100 pad: the centre is 100,50, so the default must differ from above.
  await pad.click()
  await expect(window.locator("#hit-log").textContent()).resolves.toBe("100,50")
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

test("a nested frame chain reaches two levels down", async ({ window }) => {
  const nested = window.frameLocator("#pane").frameLocator("#nested")

  await expect(nested.locator("#scope").textContent()).resolves.toBe("nested")
})

test("a missing frame names the frame, not the element", async ({ window }) => {
  await expect(window.frameLocator("#absent").locator("#pay").click()).rejects.toThrow(
    /No frame matches selector: #absent/
  )
})
