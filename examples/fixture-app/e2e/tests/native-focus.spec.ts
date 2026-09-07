import { HasgardRpcClient } from "@nyssance/tauri-hasgard"
import { expect, fixtureEndpoint, test } from "../fixtures.js"

const stress = process.env.HASGARD_NATIVE_STRESS
if (stress !== undefined && stress !== "1") throw new Error("HASGARD_NATIVE_STRESS must be 1 when supplied")
const pairs = stress === "1" ? 200 : 3

for (const keys of [
  { main: "m", settings: "s", mainText: "m", settingsText: "s" },
  { main: "Shift+m", settings: "s", mainText: "M", settingsText: "s" },
  { main: "m", settings: "Shift+s", mainText: "m", settingsText: "S" }
]) {
  test(`concurrent native ${keys.main}/${keys.settings} stays in the requested real window`, async ({
    hasgard,
    window
  }, testInfo) => {
    test.setTimeout(90_000)
    test.skip(process.platform !== "darwin", "Verifies AppKit focus ownership")
    const settings = hasgard.window("settings")
    await hasgard.waitForWindowReady("settings", 'html[data-hasgard-ready="true"]', 10_000)
    // Secure text controls bypass IME composition without changing the user's
    // system input source. This case isolates native routing and text delivery.
    await window.evaluate('document.querySelector("#key-probe").type = "password"')
    await settings.evaluate('document.querySelector("#settings-key-probe").type = "password"')
    await window.locator("#key-probe").fill("")
    await settings.locator("#settings-key-probe").fill("")
    for (const target of [window, settings]) {
      await target.evaluate(
        '(() => { window.__nativeKeys = []; window.__keyObserver = new AbortController(); document.addEventListener("keydown", e => { if (e.key !== "Shift") window.__nativeKeys.push({key: e.key, trusted: e.isTrusted}); }, {signal: window.__keyObserver.signal}); return true })()'
      )
    }
    const first = new HasgardRpcClient(fixtureEndpoint(testInfo.workerIndex))
    const second = new HasgardRpcClient(fixtureEndpoint(testInfo.workerIndex))
    try {
      await Promise.all([first.connect(5_000), second.connect(5_000)])
      for (let index = 1; index <= pairs; index++) {
        const outcomes = await Promise.allSettled([
          first.call("press", { window: "main", key: keys.main }),
          second.call("press", { window: "settings", key: keys.settings })
        ])
        const failure = outcomes.find(outcome => outcome.status === "rejected")
        if (failure?.status === "rejected") {
          const states = await Promise.allSettled(
            [window, settings].map(target =>
              target.evaluate(
                '({ focused: document.hasFocus(), activeElement: document.activeElement.id, inputs: Array.from(document.querySelectorAll("input"), input => ({id: input.id, value: input.value})), keys: window.__nativeKeys })'
              )
            )
          )
          await testInfo.attach("native-press-failure.json", {
            contentType: "application/json",
            body: Buffer.from(JSON.stringify({ pair: index, outcomes, states }, null, 2))
          })
          throw failure.reason
        }
        await expect(window.locator("#key-probe").inputValue()).resolves.toBe(keys.mainText.repeat(index))
        await expect(settings.locator("#settings-key-probe").inputValue()).resolves.toBe(
          keys.settingsText.repeat(index)
        )
      }
      await expect(window.evaluate("window.__nativeKeys")).resolves.toEqual(
        Array.from({ length: pairs }, () => ({ key: keys.mainText, trusted: true }))
      )
      await expect(settings.evaluate("window.__nativeKeys")).resolves.toEqual(
        Array.from({ length: pairs }, () => ({ key: keys.settingsText, trusted: true }))
      )
    } catch (error) {
      const states = await Promise.allSettled(
        [window, settings].map(target =>
          target.evaluate(
            '({focused: document.hasFocus(), activeElement: document.activeElement.id, value: document.querySelector("input[type=password]").value, keys: window.__nativeKeys})'
          )
        )
      )
      await testInfo.attach("native-window-state.json", {
        contentType: "application/json",
        body: Buffer.from(JSON.stringify({ error: String(error), states }, null, 2))
      })
      throw error
    } finally {
      first.disconnect()
      second.disconnect()
      await window.evaluate('window.__keyObserver.abort(); document.querySelector("#key-probe").type = "text"')
      await settings.evaluate(
        'window.__keyObserver.abort(); document.querySelector("#settings-key-probe").type = "text"'
      )
    }
  })
}

test("native modifiers and a failed postcondition leave input usable", async ({ window }) => {
  test.skip(process.platform !== "darwin", "Verifies AppKit keyboard delivery")
  await window.evaluate('document.querySelector("#key-probe").type = "password"')
  try {
    await window.locator("#key-probe").fill("")
    await window.press("Shift+m", { waitFor: 'document.querySelector("#key-probe").value === "M"' })
    await window.press("M")
    await window.press("Shift")
    await expect(window.press("ArrowRight", { waitFor: "false", timeoutMs: 0 })).rejects.toMatchObject({
      data: { phase: "postcondition", injected: true }
    })
    await window.press("Tab", { waitFor: 'document.activeElement.id !== "key-probe"' })
  } finally {
    await window.evaluate('document.querySelector("#key-probe").type = "text"')
  }
})

test("a synthetic keyup cannot satisfy native completion in the real webview", async ({ window }) => {
  test.skip(process.platform !== "darwin", "Verifies native event observation")
  await window.locator("#key-probe").focus()
  await window.evaluate("window.__HASGARD__._preparePress({token: 1})")
  try {
    await window.evaluate('window.dispatchEvent(new KeyboardEvent("keyup", {key: "ArrowRight"}))')
    await expect(
      window.evaluate(
        'Promise.race([window.__HASGARD__._waitPress({token: 1}).then(() => "completed"), new Promise(resolve => setTimeout(() => resolve("pending"), 50))])'
      )
    ).resolves.toBe("pending")
    await window.press("ArrowRight")
    await expect(window.evaluate("window.__HASGARD__._waitPress({token: 1})")).resolves.toEqual({ ok: true })
  } finally {
    await window.evaluate("window.__HASGARD__._cancelPress({token: 1})")
  }
})

test("explicit native completion drives an actual registered global shortcut", async ({ window }) => {
  test.skip(process.platform !== "darwin", "Verifies a macOS global shortcut")
  await window.invoke("fixture_shortcut", { action: "register" })
  try {
    await window.press("Control+Alt+Shift+F12", { completion: "native" })
    await expect.poll(() => window.invoke<number>("fixture_shortcut", { action: "count" })).toBe(1)
  } finally {
    await window.invoke("fixture_shortcut", { action: "unregister" })
  }
})
