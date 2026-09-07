# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: native-focus.spec.ts >> concurrent native m/s stays in the requested real window
- Location: e2e/tests/native-focus.spec.ts:9:3

# Error details

```
Error: expect(received).resolves.toEqual(expected) // deep equality

- Expected  -  0
+ Received  + 12

@@ -58,11 +58,19 @@
    Object {
      "key": "s",
      "trusted": true,
    },
    Object {
+     "key": "Control",
+     "trusted": true,
+   },
+   Object {
      "key": "s",
+     "trusted": true,
+   },
+   Object {
+     "key": "Control",
      "trusted": true,
    },
    Object {
      "key": "s",
      "trusted": true,
@@ -167,10 +175,14 @@
      "key": "s",
      "trusted": true,
    },
    Object {
      "key": "s",
+     "trusted": true,
+   },
+   Object {
+     "key": "Control",
      "trusted": true,
    },
    Object {
      "key": "s",
      "trusted": true,
```

# Test source

```ts
  1   | import { HasgardRpcClient } from "@nyssance/tauri-hasgard"
  2   | import { expect, fixtureEndpoint, test } from "../fixtures.js"
  3   |
  4   | for (const keys of [
  5   |   { main: "m", settings: "s", mainText: "m", settingsText: "s" },
  6   |   { main: "Shift+m", settings: "s", mainText: "M", settingsText: "s" },
  7   |   { main: "m", settings: "Shift+s", mainText: "m", settingsText: "S" }
  8   | ]) {
  9   |   test(`concurrent native ${keys.main}/${keys.settings} stays in the requested real window`, async ({
  10  |     hasgard,
  11  |     window
  12  |   }, testInfo) => {
  13  |     test.setTimeout(90_000)
  14  |     test.skip(process.platform !== "darwin", "Verifies AppKit focus ownership")
  15  |     const settings = hasgard.window("settings")
  16  |     await hasgard.waitForWindowReady("settings", 'html[data-hasgard-ready="true"]', 10_000)
  17  |     // Secure text controls bypass IME composition without changing the user's
  18  |     // system input source. This case isolates native routing and text delivery.
  19  |     await window.evaluate('document.querySelector("#key-probe").type = "password"')
  20  |     await settings.evaluate('document.querySelector("#settings-key-probe").type = "password"')
  21  |     await window.locator("#key-probe").fill("")
  22  |     await settings.locator("#settings-key-probe").fill("")
  23  |     for (const target of [window, settings]) {
  24  |       await target.evaluate(
  25  |         '(() => { window.__nativeKeys = []; window.__keyObserver = new AbortController(); document.addEventListener("keydown", e => { if (e.key !== "Shift") window.__nativeKeys.push({key: e.key, trusted: e.isTrusted}); }, {signal: window.__keyObserver.signal}); return true })()'
  26  |       )
  27  |     }
  28  |     const first = new HasgardRpcClient(fixtureEndpoint(testInfo.workerIndex))
  29  |     const second = new HasgardRpcClient(fixtureEndpoint(testInfo.workerIndex))
  30  |     try {
  31  |       await Promise.all([first.connect(5_000), second.connect(5_000)])
  32  |       for (let index = 1; index <= 200; index++) {
  33  |         const outcomes = await Promise.allSettled([
  34  |           first.call("press", { window: "main", key: keys.main }),
  35  |           second.call("press", { window: "settings", key: keys.settings })
  36  |         ])
  37  |         const failure = outcomes.find(outcome => outcome.status === "rejected")
  38  |         if (failure?.status === "rejected") {
  39  |           const states = await Promise.allSettled([window, settings].map(target => target.evaluate(
  40  |             '({ focused: document.hasFocus(), activeElement: document.activeElement.id, inputs: Array.from(document.querySelectorAll("input"), input => ({id: input.id, value: input.value})), keys: window.__nativeKeys })'
  41  |           )))
  42  |           await testInfo.attach("native-press-failure.json", {
  43  |             contentType: "application/json",
  44  |             body: Buffer.from(JSON.stringify({pair: index, outcomes, states}, null, 2))
  45  |           })
  46  |           throw failure.reason
  47  |         }
  48  |         await expect(window.locator("#key-probe").inputValue()).resolves.toBe(keys.mainText.repeat(index))
  49  |         await expect(settings.locator("#settings-key-probe").inputValue()).resolves.toBe(
  50  |           keys.settingsText.repeat(index)
  51  |         )
  52  |       }
  53  |       await expect(window.evaluate("window.__nativeKeys")).resolves.toEqual(
  54  |         Array.from({ length: 200 }, () => ({ key: keys.mainText, trusted: true }))
  55  |       )
> 56  |       await expect(settings.evaluate("window.__nativeKeys")).resolves.toEqual(
      |                                                                       ^ Error: expect(received).resolves.toEqual(expected) // deep equality
  57  |         Array.from({ length: 200 }, () => ({ key: keys.settingsText, trusted: true }))
  58  |       )
  59  |     } finally {
  60  |       first.disconnect()
  61  |       second.disconnect()
  62  |       await window.evaluate('window.__keyObserver.abort(); document.querySelector("#key-probe").type = "text"')
  63  |       await settings.evaluate(
  64  |         'window.__keyObserver.abort(); document.querySelector("#settings-key-probe").type = "text"'
  65  |       )
  66  |     }
  67  |   })
  68  | }
  69  |
  70  | test("native modifiers and a failed postcondition leave input usable", async ({ window }) => {
  71  |   test.skip(process.platform !== "darwin", "Verifies AppKit keyboard delivery")
  72  |   await window.evaluate('document.querySelector("#key-probe").type = "password"')
  73  |   try {
  74  |     await window.locator("#key-probe").fill("")
  75  |     await window.press("Shift+m", { waitFor: 'document.querySelector("#key-probe").value === "M"' })
  76  |     await window.press("M")
  77  |     await window.press("Shift")
  78  |     await expect(window.press("ArrowRight", { waitFor: "false", timeoutMs: 0 })).rejects.toMatchObject({
  79  |       data: { phase: "postcondition", injected: true }
  80  |     })
  81  |     await window.press("Tab", { waitFor: 'document.activeElement.id !== "key-probe"' })
  82  |   } finally {
  83  |     await window.evaluate('document.querySelector("#key-probe").type = "text"')
  84  |   }
  85  | })
  86  |
  87  | test("a synthetic keyup cannot satisfy native completion in the real webview", async ({ window }) => {
  88  |   test.skip(process.platform !== "darwin", "Verifies native event observation")
  89  |   await window.locator("#key-probe").focus()
  90  |   await window.evaluate("window.__HASGARD__._preparePress({token: 1})")
  91  |   try {
  92  |     await window.evaluate('window.dispatchEvent(new KeyboardEvent("keyup", {key: "ArrowRight"}))')
  93  |     await expect(
  94  |       window.evaluate(
  95  |         'Promise.race([window.__HASGARD__._waitPress({token: 1}).then(() => "completed"), new Promise(resolve => setTimeout(() => resolve("pending"), 50))])'
  96  |       )
  97  |     ).resolves.toBe("pending")
  98  |     await window.press("ArrowRight")
  99  |     await expect(window.evaluate("window.__HASGARD__._waitPress({token: 1})")).resolves.toEqual({ ok: true })
  100 |   } finally {
  101 |     await window.evaluate("window.__HASGARD__._cancelPress({token: 1})")
  102 |   }
  103 | })
  104 |
  105 | test("explicit native completion drives an actual registered global shortcut", async ({ window }) => {
  106 |   test.skip(process.platform !== "darwin", "Verifies a macOS global shortcut")
  107 |   await window.invoke("fixture_shortcut", { action: "register" })
  108 |   try {
  109 |     await window.press("Control+Alt+Shift+F12", { completion: "native" })
  110 |     await expect.poll(() => window.invoke<number>("fixture_shortcut", { action: "count" })).toBe(1)
  111 |   } finally {
  112 |     await window.invoke("fixture_shortcut", { action: "unregister" })
  113 |   }
  114 | })
  115 |
```
