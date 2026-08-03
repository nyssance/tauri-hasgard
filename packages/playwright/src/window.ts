import { HasgardRpcClient } from "./rpc-client.js"
import type {
  HasgardTarget,
  JsonValue,
  RoleQuery,
  Snapshot,
  SnapshotElement,
  SnapshotOptions,
  WaitOptions,
  WindowInfo,
  WindowState
} from "./types.js"

interface WindowLock {
  tail: Promise<void>
}

const locks = new WeakMap<HasgardRpcClient, Map<string, WindowLock>>()

function lockFor(rpc: HasgardRpcClient, label: string): WindowLock {
  let clientLocks = locks.get(rpc)
  if (!clientLocks) {
    clientLocks = new Map()
    locks.set(rpc, clientLocks)
  }
  let lock = clientLocks.get(label)
  if (!lock) {
    lock = { tail: Promise.resolve() }
    clientLocks.set(label, lock)
  }
  return lock
}

export const byRef = (ref: string): HasgardTarget => ({ ref })
export const bySelector = (selector: string): HasgardTarget => ({ selector })
export const byPoint = (x: number, y: number): HasgardTarget => ({ x, y })

function withWindow(window: string, params?: Record<string, JsonValue>): Record<string, JsonValue> {
  return params ? { ...params, window } : { window }
}

function targetParams(target: HasgardTarget): Record<string, JsonValue> {
  if ("ref" in target) return { ref: target.ref }
  if ("selector" in target) return { selector: target.selector }
  return { x: target.x, y: target.y }
}

function expectRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`)
  }
  return value as Record<string, unknown>
}

function expectString(value: unknown, context: string): string {
  if (typeof value !== "string") throw new Error(`${context} must be a string`)
  return value
}

function expectBoolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${context} must be a boolean`)
  return value
}

function expectNumber(value: unknown, context: string): number {
  if (typeof value !== "number") throw new Error(`${context} must be a number`)
  return value
}

export class HasgardApplication {
  readonly rpc: HasgardRpcClient

  constructor(rpc: HasgardRpcClient) {
    this.rpc = rpc
  }

  async ping(): Promise<{ status: string; plugin_version: string }> {
    const value = expectRecord(await this.rpc.call("ping"), "ping result")
    return {
      status: expectString(value.status, "ping.status"),
      plugin_version: expectString(value.plugin_version, "ping.plugin_version")
    }
  }

  async windows(): Promise<WindowInfo[]> {
    const value = expectRecord(await this.rpc.call("windows.list"), "windows.list result")
    if (!Array.isArray(value.windows)) throw new Error("windows.list.windows must be an array")
    return value.windows.map((entry, index) => {
      const window = expectRecord(entry, `windows[${index}]`)
      return {
        label: expectString(window.label, `windows[${index}].label`),
        url: expectString(window.url, `windows[${index}].url`),
        title: expectString(window.title, `windows[${index}].title`)
      }
    })
  }

  async waitForWindow(label: string, timeoutMs: number): Promise<HasgardWindow> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() <= deadline) {
      if ((await this.windows()).some(window => window.label === label)) {
        const window = this.window(label)
        const state = await window.state()
        if (state.url !== "about:blank" && state.readyState !== "loading") {
          return window
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Window '${label}' did not finish loading within ${timeoutMs}ms`)
  }

  async waitForWindowReady(label: string, readySelector: string, timeoutMs: number): Promise<HasgardWindow> {
    const window = await this.waitForWindow(label, timeoutMs)
    const deadline = Date.now() + timeoutMs
    while (Date.now() <= deadline) {
      if ((await window.locator(readySelector).count()) === 1) return window
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Window '${label}' did not match ready selector '${readySelector}' within ${timeoutMs}ms`)
  }

  window(label: string): HasgardWindow {
    return new HasgardWindow(this.rpc, label)
  }
}

export class HasgardWindow {
  readonly label: string
  private readonly rpc: HasgardRpcClient

  constructor(rpc: HasgardRpcClient, label: string) {
    this.rpc = rpc
    this.label = label
  }

  locator(selector: string): HasgardLocator {
    return new HasgardLocator(this, { kind: "selector", selector })
  }

  getByRole(role: string, query: RoleQuery = {}): HasgardLocator {
    return new HasgardLocator(this, { kind: "role", role, query })
  }

  async snapshot(options: SnapshotOptions = {}): Promise<Snapshot> {
    const raw = expectRecord(
      await this.rpc.call("snapshot", withWindow(this.label, options as Record<string, JsonValue>)),
      "snapshot result"
    )
    if (!Array.isArray(raw.elements)) throw new Error("snapshot.elements must be an array")
    return {
      elements: raw.elements.map((entry, index) => parseSnapshotElement(entry, index))
    }
  }

  async state(): Promise<WindowState> {
    const value = expectRecord(await this.rpc.call("state", withWindow(this.label)), "state result")
    const viewport = expectRecord(value.viewport, "state.viewport")
    const scroll = expectRecord(value.scroll, "state.scroll")
    return {
      url: expectString(value.url, "state.url"),
      title: expectString(value.title, "state.title"),
      readyState: expectString(value.readyState, "state.readyState"),
      viewport: {
        width: expectNumber(viewport.width, "state.viewport.width"),
        height: expectNumber(viewport.height, "state.viewport.height")
      },
      scroll: {
        x: expectNumber(scroll.x, "state.scroll.x"),
        y: expectNumber(scroll.y, "state.scroll.y")
      },
      plugin_version: expectString(value.plugin_version, "state.plugin_version")
    }
  }

  async press(key: string): Promise<void> {
    await this.rpc.call("press", withWindow(this.label, { key }))
  }

  async evaluate<T>(script: string): Promise<T> {
    return this.rpc.call<T>("eval", withWindow(this.label, { script }))
  }

  async invoke<T>(command: string, args: Record<string, JsonValue>): Promise<T> {
    return this.rpc.call<T>("ipc", withWindow(this.label, { command, args }))
  }

  async screenshot(selector?: string): Promise<Buffer> {
    const params = selector ? { selector } : undefined
    const dataUrl = await this.rpc.call<string>("screenshot", withWindow(this.label, params))
    const prefix = "data:image/png;base64,"
    if (!dataUrl.startsWith(prefix)) throw new Error("screenshot result is not a PNG data URL")
    return Buffer.from(dataUrl.slice(prefix.length), "base64")
  }

  async call<T>(method: string, params?: Record<string, JsonValue>): Promise<T> {
    return this.rpc.call<T>(method, withWindow(this.label, params))
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const lock = lockFor(this.rpc, this.label)
    const previous = lock.tail
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    lock.tail = previous.then(() => gate)
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

type LocatorQuery = { kind: "selector"; selector: string } | { kind: "role"; role: string; query: RoleQuery }

export class HasgardLocator {
  readonly window: HasgardWindow
  private readonly query: LocatorQuery

  constructor(window: HasgardWindow, query: LocatorQuery) {
    this.window = window
    this.query = query
  }

  async click(): Promise<void> {
    await this.withTarget(target => this.window.call("click", targetParams(target)))
  }

  async fill(value: string): Promise<void> {
    await this.withTarget(target => this.window.call("fill", { ...targetParams(target), value }))
  }

  async type(text: string): Promise<void> {
    await this.withTarget(target => this.window.call("type", { ...targetParams(target), text }))
  }

  async selectOption(value: string): Promise<void> {
    await this.withTarget(target => this.window.call("select", { ...targetParams(target), value }))
  }

  async check(): Promise<void> {
    await this.withTarget(target => this.window.call("check", targetParams(target)))
  }

  async textContent(): Promise<string> {
    return this.withTarget(async target =>
      expectString(await this.window.call("text", targetParams(target)), "text result")
    )
  }

  async inputValue(): Promise<string> {
    return this.withTarget(async target =>
      expectString(await this.window.call("value", targetParams(target)), "value result")
    )
  }

  async attributes(): Promise<Record<string, string>> {
    return this.withTarget(async target => {
      const value = expectRecord(await this.window.call("attrs", targetParams(target)), "attrs result")
      return Object.fromEntries(
        Object.entries(value).map(([name, attr]) => [name, expectString(attr, `attribute ${name}`)])
      )
    })
  }

  async isVisible(): Promise<boolean> {
    return this.withTarget(async target => {
      const value = expectRecord(await this.window.call("visible", targetParams(target)), "visible result")
      return expectBoolean(value.visible, "visible.visible")
    })
  }

  async isChecked(): Promise<boolean> {
    return this.withTarget(async target => {
      const value = expectRecord(await this.window.call("checked", targetParams(target)), "checked result")
      return expectBoolean(value.checked, "checked.checked")
    })
  }

  async count(): Promise<number> {
    if (this.query.kind === "role") return (await this.resolveAll()).length
    const value = expectRecord(await this.window.call("count", { selector: this.query.selector }), "count result")
    return expectNumber(value.count, "count.count")
  }

  async waitFor(options: WaitOptions): Promise<void> {
    if (this.query.kind === "selector") {
      await this.window.call("wait", {
        selector: this.query.selector,
        gone: options.state === "detached",
        timeout: options.timeoutMs
      })
      return
    }

    const deadline = Date.now() + options.timeoutMs
    while (Date.now() <= deadline) {
      const found = (await this.resolveAll()).length > 0
      if (found === (options.state === "attached")) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Role locator did not become ${options.state} within ${options.timeoutMs}ms`)
  }

  private async resolveUnique(): Promise<HasgardTarget> {
    if (this.query.kind === "selector") return bySelector(this.query.selector)
    const elements = await this.resolveAll()
    if (elements.length !== 1) {
      throw new Error(`Role locator resolved to ${elements.length} elements; expected exactly one`)
    }
    return byRef(elements[0]!.ref)
  }

  private async withTarget<T>(operation: (target: HasgardTarget) => Promise<T>): Promise<T> {
    return this.window.runExclusive(async () => operation(await this.resolveUnique()))
  }

  private async resolveAll(): Promise<SnapshotElement[]> {
    if (this.query.kind === "selector") {
      throw new Error("resolveAll is only valid for role locators")
    }
    const query = this.query
    const snapshot = await this.window.snapshot()
    return snapshot.elements.filter(element => {
      if (element.role !== query.role) return false
      const expected = query.query.name
      if (expected === undefined) return true
      if (element.name === undefined) return false
      if (expected instanceof RegExp) return expected.test(element.name)
      return query.query.exact ? element.name === expected : element.name.includes(expected)
    })
  }
}

function parseSnapshotElement(value: unknown, index: number): SnapshotElement {
  const entry = expectRecord(value, `snapshot.elements[${index}]`)
  const element: SnapshotElement = {
    ref: expectString(entry.ref, `snapshot.elements[${index}].ref`),
    role: expectString(entry.role, `snapshot.elements[${index}].role`),
    depth: expectNumber(entry.depth, `snapshot.elements[${index}].depth`)
  }
  if (entry.name !== undefined) element.name = expectString(entry.name, `snapshot.elements[${index}].name`)
  if (entry.value !== undefined) element.value = expectString(entry.value, `snapshot.elements[${index}].value`)
  if (entry.checked !== undefined) element.checked = expectBoolean(entry.checked, `snapshot.elements[${index}].checked`)
  if (entry.disabled !== undefined)
    element.disabled = expectBoolean(entry.disabled, `snapshot.elements[${index}].disabled`)
  return element
}
