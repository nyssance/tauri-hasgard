import { expect as playwrightExpect } from "@playwright/test"
import { expect, test } from "vitest"
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

for (const negative of [false, true]) {
  test(`RPC failure cannot satisfy ${negative ? "negative" : "positive"} assertions`, async () => {
    const error = new Error("application crashed: socket closed")
    const locator = {
      isVisible: async () => {
        throw error
      },
      textContent: async () => {
        throw error
      }
    } as unknown as HasgardLocator
    const assertion = negative ? hasgardExpect(locator).not : hasgardExpect(locator)
    await expect(assertion.toBeVisible({ timeout: 0 })).rejects.toThrow(error.message)
    await expect(assertion.toHaveText("hello", { timeout: 0 })).rejects.toThrow(error.message)
  })
}

test("zero timeout performs one read and invalid timeouts reject", async () => {
  let reads = 0
  const locator = {
    isVisible: async () => {
      reads++
      return true
    }
  } as unknown as HasgardLocator
  await hasgardExpect(locator).toBeVisible({ timeout: 0 })
  expect(reads).toBe(1)
  for (const timeout of [-1, NaN, Infinity]) {
    await expect(hasgardExpect(locator).not.toBeVisible({ timeout })).rejects.toThrow("finite non-negative")
  }
})
