import { expect as playwrightExpect } from "@playwright/test"
import { test } from "vitest"
import { createHasgardExpect } from "./expect.js"
import type { HasgardLocator } from "./window.js"

const hasgardExpect = createHasgardExpect(playwrightExpect)

test("supports positive and negative visibility assertions without negative timeout delay", async () => {
  const visible = { isVisible: async () => true } as unknown as HasgardLocator
  const hidden = { isVisible: async () => false } as unknown as HasgardLocator

  await hasgardExpect(visible).toBeVisible({ timeout: 25 })
  await hasgardExpect(hidden).not.toBeVisible({ timeout: 25 })
})

test("uses exact strings and regular expressions for text assertions", async () => {
  const locator = {
    textContent: async () => "Saved Nyssance"
  } as unknown as HasgardLocator

  await hasgardExpect(locator).toHaveText("Saved Nyssance", { timeout: 25 })
  await hasgardExpect(locator).toHaveText(/^Saved/, { timeout: 25 })
  await hasgardExpect(locator).not.toHaveText("Saved", { timeout: 25 })
})
