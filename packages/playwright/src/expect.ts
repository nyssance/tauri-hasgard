import type { HasgardLocator } from "./window.js"

async function poll<T>(read: () => Promise<T>, matches: (value: T) => boolean, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new RangeError("Assertion timeout must be a finite non-negative number")
  const deadline = Date.now() + timeoutMs
  // Read at least once, including timeout: 0. A failed read is never evidence
  // that a negative assertion is true.
  for (;;) {
    try {
      const value = await read()
      if (matches(value) || Date.now() >= deadline) return value
    } catch (error) {
      if (Date.now() >= deadline) throw error
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))))
  }
}

export function createHasgardExpect(playwrightExpect: typeof import("@playwright/test").expect) {
  return playwrightExpect.extend({
    async toBeVisible(locator: HasgardLocator, options: { timeout?: number } = {}) {
      const timeout = options.timeout === undefined ? 5_000 : options.timeout
      const result = await poll(
        () => locator.isVisible(),
        visible => (this.isNot ? !visible : visible),
        timeout
      )
      return {
        pass: result === true,
        message: () =>
          this.isNot
            ? "expected Hasgard locator not to be visible"
            : `expected Hasgard locator to be visible within ${timeout}ms`
      }
    },

    async toHaveText(locator: HasgardLocator, expected: string | RegExp, options: { timeout?: number } = {}) {
      const timeout = options.timeout === undefined ? 5_000 : options.timeout
      const matches = (text: string): boolean => {
        if (typeof expected === "string") return text === expected
        expected.lastIndex = 0
        return expected.test(text)
      }
      const result = await poll(
        () => locator.textContent(),
        text => (this.isNot ? !matches(text) : matches(text)),
        timeout
      )
      return {
        pass: matches(result),
        message: () =>
          this.isNot
            ? `expected Hasgard locator text not to match ${String(expected)}, received ${String(result)}`
            : `expected Hasgard locator text to match ${String(expected)}, received ${String(result)}`
      }
    }
  })
}
