import { expect as playwrightExpect } from "@playwright/test"
import { expect, test } from "vitest"

import { createHasgardExpect } from "./expect.js"
import type { HasgardLocator } from "./window.js"

const hasgardExpect = createHasgardExpect(playwrightExpect)

test("supports positive and negative visibility assertions without negative timeout delay", async () => {
  const visible = { isVisible: () => Promise.resolve(true) } as unknown as HasgardLocator
  const hidden = { isVisible: () => Promise.resolve(false) } as unknown as HasgardLocator

  await hasgardExpect(visible).toBeVisible({ timeout: 25 })
  await hasgardExpect(hidden).not.toBeVisible({ timeout: 25 })
})

test("uses exact strings and regular expressions for text assertions", async () => {
  const locator = {
    textContent: () => Promise.resolve("Saved Nyssance")
  } as unknown as HasgardLocator

  await hasgardExpect(locator).toHaveText("Saved Nyssance", { timeout: 25 })
  await hasgardExpect(locator).toHaveText(/^Saved/, { timeout: 25 })
  await hasgardExpect(locator).not.toHaveText("Saved", { timeout: 25 })
})

for (const negative of [false, true]) {
  test(`RPC failure cannot satisfy ${negative ? "negative" : "positive"} assertions`, async () => {
    const error = new Error("application crashed: socket closed")
    const locator = {
      isVisible: () => Promise.reject(error),
      textContent: () => Promise.reject(error)
    } as unknown as HasgardLocator
    const assertion = negative ? hasgardExpect(locator).not : hasgardExpect(locator)
    await expect(assertion.toBeVisible({ timeout: 0 })).rejects.toThrow(error.message)
    await expect(assertion.toHaveText("hello", { timeout: 0 })).rejects.toThrow(error.message)
  })
}

test("zero timeout performs one read and invalid timeouts reject", async () => {
  let reads = 0
  const locator = {
    isVisible: () => {
      reads++
      return Promise.resolve(true)
    }
  } as unknown as HasgardLocator
  await hasgardExpect(locator).toBeVisible({ timeout: 0 })
  expect(reads).toBe(1)
  for (const timeout of [-1, Number.NaN, Infinity]) {
    await expect(hasgardExpect(locator).not.toBeVisible({ timeout })).rejects.toThrow("finite non-negative")
  }
})

test("state, value, attribute and count assertions read through the locator", async () => {
  const locator = {
    isVisible: () => Promise.resolve(false),
    isDisabled: () => Promise.resolve(true),
    isChecked: () => Promise.resolve(true),
    textContent: () => Promise.resolve("Saved Nyssance"),
    inputValue: () => Promise.resolve("me@example.com"),
    getAttribute: (name: string) => Promise.resolve(name === "href" ? "/settings" : null),
    count: () => Promise.resolve(3)
  } as unknown as HasgardLocator
  const options = { timeout: 25 }

  await hasgardExpect(locator).toBeHidden(options)
  await hasgardExpect(locator).toBeDisabled(options)
  await hasgardExpect(locator).not.toBeEnabled(options)
  await hasgardExpect(locator).toBeChecked(options)
  await hasgardExpect(locator).toContainText("Nyssance", options)
  await hasgardExpect(locator).not.toContainText("nyssance", options)
  await hasgardExpect(locator).toHaveValue("me@example.com", options)
  await hasgardExpect(locator).toHaveValue(/@example\.com$/, options)
  await hasgardExpect(locator).toHaveAttribute("href", "/settings", options)
  await hasgardExpect(locator).not.toHaveAttribute("target", "_blank", options)
  await hasgardExpect(locator).toHaveCount(3, options)
  await hasgardExpect(locator).not.toHaveCount(2, options)
})

test("a failed assertion reports what was last read", async () => {
  const locator = {
    inputValue: () => Promise.resolve("draft"),
    count: () => Promise.resolve(1)
  } as unknown as HasgardLocator

  await expect(hasgardExpect(locator).toHaveValue("final", { timeout: 0 })).rejects.toThrow(
    'expected Hasgard locator value to match final, received "draft" within 0ms'
  )
  await expect(hasgardExpect(locator).not.toHaveCount(1, { timeout: 0 })).rejects.toThrow(
    "expected Hasgard locator not to match 1 elements, received 1 within 0ms"
  )
})

test("an assertion that becomes true is noticed well inside the old 50 ms poll interval", async () => {
  const flipAt = Date.now() + 5
  const locator = { isVisible: () => Promise.resolve(Date.now() >= flipAt) } as unknown as HasgardLocator

  const started = Date.now()
  await hasgardExpect(locator).toBeVisible({ timeout: 1_000 })

  expect(Date.now() - started).toBeLessThan(45)
})
