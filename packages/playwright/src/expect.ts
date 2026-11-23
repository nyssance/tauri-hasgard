import { pollDelay, sleep } from "./poll.js"
import type { HasgardLocator } from "./window.js"

export interface HasgardAssertionOptions {
  timeout?: number
}

async function poll<T>(read: () => Promise<T>, matches: (value: T) => boolean, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new RangeError("Assertion timeout must be a finite non-negative number")
  const deadline = Date.now() + timeoutMs
  // Read at least once, including timeout: 0. A failed read is never evidence
  // that a negative assertion is true.
  for (let attempt = 0; ; attempt++) {
    try {
      const value = await read()
      if (matches(value) || Date.now() >= deadline) return value
    } catch (error) {
      if (Date.now() >= deadline) throw error
    }
    await sleep(pollDelay(attempt, deadline))
  }
}

function textMatcher(expected: string | RegExp, substring: boolean): (text: string) => boolean {
  if (typeof expected === "string") {
    return substring ? (text) => text.includes(expected) : (text) => text === expected
  }
  return (text) => {
    expected.lastIndex = 0
    return expected.test(text)
  }
}

interface MatcherState {
  isNot: boolean
}

/**
 * Poll `read` until it satisfies `matches` — or, under `.not`, until it stops
 * satisfying it — and report the last value read.
 */
async function assertEventually<T>(
  state: MatcherState,
  options: HasgardAssertionOptions,
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  describe: (received: T) => string
) {
  const { timeout = 5_000 } = options
  const received = await poll(read, (value) => matches(value) !== state.isNot, timeout)
  return {
    pass: matches(received),
    message: () => `expected Hasgard locator ${state.isNot ? "not " : ""}${describe(received)} within ${timeout}ms`
  }
}

export function createHasgardExpect(playwrightExpect: typeof import("@playwright/test").expect) {
  return playwrightExpect.extend({
    async toBeVisible(locator: HasgardLocator, options: HasgardAssertionOptions = {}) {
      return assertEventually(
        this,
        options,
        () => locator.isVisible(),
        (visible) => visible,
        () => "to be visible"
      )
    },

    async toBeHidden(locator: HasgardLocator, options: HasgardAssertionOptions = {}) {
      return assertEventually(
        this,
        options,
        () => locator.isVisible(),
        (visible) => !visible,
        () => "to be hidden"
      )
    },

    async toBeEnabled(locator: HasgardLocator, options: HasgardAssertionOptions = {}) {
      return assertEventually(
        this,
        options,
        () => locator.isDisabled(),
        (disabled) => !disabled,
        () => "to be enabled"
      )
    },

    async toBeDisabled(locator: HasgardLocator, options: HasgardAssertionOptions = {}) {
      return assertEventually(
        this,
        options,
        () => locator.isDisabled(),
        (disabled) => disabled,
        () => "to be disabled"
      )
    },

    async toBeChecked(locator: HasgardLocator, options: HasgardAssertionOptions = {}) {
      return assertEventually(
        this,
        options,
        () => locator.isChecked(),
        (checked) => checked,
        () => "to be checked"
      )
    },

    async toHaveText(locator: HasgardLocator, expected: string | RegExp, options: HasgardAssertionOptions = {}) {
      return assertEventually(
        this,
        options,
        () => locator.textContent(),
        textMatcher(expected, false),
        (received) => `text to match ${String(expected)}, received ${JSON.stringify(received)}`
      )
    },

    async toContainText(locator: HasgardLocator, expected: string | RegExp, options: HasgardAssertionOptions = {}) {
      return assertEventually(
        this,
        options,
        () => locator.textContent(),
        textMatcher(expected, true),
        (received) => `text to contain ${String(expected)}, received ${JSON.stringify(received)}`
      )
    },

    async toHaveValue(locator: HasgardLocator, expected: string | RegExp, options: HasgardAssertionOptions = {}) {
      return assertEventually(
        this,
        options,
        () => locator.inputValue(),
        textMatcher(expected, false),
        (received) => `value to match ${String(expected)}, received ${JSON.stringify(received)}`
      )
    },

    async toHaveAttribute(
      locator: HasgardLocator,
      name: string,
      expected: string | RegExp,
      options: HasgardAssertionOptions = {}
    ) {
      const matches = textMatcher(expected, false)
      return assertEventually(
        this,
        options,
        () => locator.getAttribute(name),
        (value) => value !== null && matches(value),
        (received) => `attribute ${name} to match ${String(expected)}, received ${JSON.stringify(received)}`
      )
    },

    async toHaveCount(locator: HasgardLocator, expected: number, options: HasgardAssertionOptions = {}) {
      return assertEventually(
        this,
        options,
        () => locator.count(),
        (count) => count === expected,
        (received) => `to match ${expected} elements, received ${received}`
      )
    }
  })
}
