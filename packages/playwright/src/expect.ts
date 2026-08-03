import type { HasgardLocator } from "./window.js"

async function poll<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  timeoutMs: number
): Promise<{ pass: boolean; value: T | undefined; error: unknown }> {
  const deadline = Date.now() + timeoutMs
  let value: T | undefined
  let error: unknown
  while (Date.now() <= deadline) {
    try {
      value = await read()
      error = undefined
      if (matches(value)) return { pass: true, value, error }
    } catch (caught) {
      error = caught
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return { pass: false, value, error }
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
        pass: result.value === true,
        message: () =>
          this.isNot
            ? "expected Hasgard locator not to be visible"
            : `expected Hasgard locator to be visible within ${timeout}ms${result.error ? `: ${String(result.error)}` : ""}`
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
        pass: result.value === undefined ? false : matches(result.value),
        message: () =>
          this.isNot
            ? `expected Hasgard locator text not to match ${String(expected)}, received ${String(result.value)}`
            : `expected Hasgard locator text to match ${String(expected)}, received ${String(result.value)}`
      }
    }
  })
}
