import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { HasgardRpcClient } from "./rpc-client.js"
import type {
  BoundingBox,
  ClickOptions,
  ConsoleLogEntry,
  ConsoleLogOptions,
  DialogListing,
  DialogPolicy,
  DialogRecord,
  DiffChange,
  DiffOptions,
  DragOffset,
  DropFile,
  FileInput,
  FilterOptions,
  FormEntry,
  FormField,
  FormsDump,
  HasgardTarget,
  JsonValue,
  NativeScreenshot,
  NativeScreenshotOptions,
  NetworkRequestEntry,
  NetworkRequestOptions,
  QueryDimension,
  RecorderEntry,
  RecorderResult,
  RecorderStatus,
  RoleQuery,
  ScrollOptions,
  Snapshot,
  SnapshotDiff,
  SnapshotElement,
  SnapshotOptions,
  StorageEntry,
  StorageListing,
  StorageOptions,
  TextQuery,
  WaitForFunctionOptions,
  WaitOptions,
  WatchChanges,
  WatchNode,
  WatchOptions,
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

/**
 * Normalise file arguments into the base64 payloads the bridge understands.
 *
 * Paths are read here, in the test process, rather than in the app: the app may
 * be sandboxed, and the path the test means is the one on the test machine.
 */
async function readFileInputs(files: FileInput | FileInput[]): Promise<DropFile[]> {
  const list = Array.isArray(files) ? files : [files]
  return Promise.all(
    list.map(async entry => {
      if (typeof entry !== "string") return entry
      const contents = await readFile(entry)
      return { name: basename(entry), data: contents.toString("base64") }
    })
  )
}

function targetParams(target: HasgardTarget): Record<string, JsonValue> {
  if ("ref" in target) return { ref: target.ref }
  if ("selector" in target) {
    return target.index === undefined
      ? { selector: target.selector }
      : { selector: target.selector, index: target.index }
  }
  return { x: target.x, y: target.y }
}

/**
 * Serialize click options, omitting anything the caller left unset so the
 * bridge keeps applying its own defaults rather than receiving explicit nulls.
 */
function clickParams(options: ClickOptions): Record<string, JsonValue> {
  const params: Record<string, JsonValue> = {}
  if (options.modifiers !== undefined) params.modifiers = options.modifiers
  if (options.button !== undefined) params.button = options.button
  if (options.clickCount !== undefined) params.clickCount = options.clickCount
  if (options.position !== undefined) params.position = { ...options.position }
  return params
}

/** Resolve a possibly negative ordinal against a match count, Python-style. */
function absoluteIndex(index: number, total: number): number {
  return index < 0 ? total + index : index
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

function expectArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`)
  return value
}

function expectNullableString(value: unknown, context: string): string | null {
  if (value === null) return null
  return expectString(value, context)
}

function optionalString(value: unknown, context: string): string | undefined {
  return value === undefined ? undefined : expectString(value, context)
}

function parseConsoleLogEntry(value: unknown, index: number): ConsoleLogEntry {
  const entry = expectRecord(value, `console.getLogs[${index}]`)
  return {
    id: expectNumber(entry.id, `console.getLogs[${index}].id`),
    timestamp: expectNumber(entry.timestamp, `console.getLogs[${index}].timestamp`),
    level: expectString(entry.level, `console.getLogs[${index}].level`),
    args: expectArray(entry.args, `console.getLogs[${index}].args`) as JsonValue[],
    source: expectNullableString(entry.source, `console.getLogs[${index}].source`)
  }
}

function parseNetworkRequestEntry(value: unknown, index: number): NetworkRequestEntry {
  const entry = expectRecord(value, `network.getRequests[${index}]`)
  return {
    id: expectNumber(entry.id, `network.getRequests[${index}].id`),
    timestamp: expectNumber(entry.timestamp, `network.getRequests[${index}].timestamp`),
    method: expectString(entry.method, `network.getRequests[${index}].method`),
    url: expectString(entry.url, `network.getRequests[${index}].url`),
    status: expectNumber(entry.status, `network.getRequests[${index}].status`),
    duration_ms: expectNumber(entry.duration_ms, `network.getRequests[${index}].duration_ms`),
    error: expectNullableString(entry.error, `network.getRequests[${index}].error`),
    request_size: expectNumber(entry.request_size, `network.getRequests[${index}].request_size`),
    response_size: expectNumber(entry.response_size, `network.getRequests[${index}].response_size`)
  }
}

function parseFormField(value: unknown, context: string): FormField {
  const field = expectRecord(value, context)
  const raw = field.value
  const parsed: FormField = {
    tag: expectString(field.tag, `${context}.tag`),
    type: expectNullableString(field.type, `${context}.type`),
    name: expectString(field.name, `${context}.name`),
    value: Array.isArray(raw)
      ? raw.map((option, index) => expectString(option, `${context}.value[${index}]`))
      : expectString(raw, `${context}.value`)
  }
  if (field.checked !== undefined) parsed.checked = expectBoolean(field.checked, `${context}.checked`)
  return parsed
}

function parseFormEntry(value: unknown, index: number): FormEntry {
  const context = `forms.dump.forms[${index}]`
  const form = expectRecord(value, context)
  const parsed: FormEntry = {
    id: expectString(form.id, `${context}.id`),
    name: expectString(form.name, `${context}.name`),
    action: expectString(form.action, `${context}.action`),
    method: expectString(form.method, `${context}.method`),
    fields: expectArray(form.fields, `${context}.fields`).map((field, fieldIndex) =>
      parseFormField(field, `${context}.fields[${fieldIndex}]`)
    )
  }
  if (form.fieldsTruncated !== undefined) {
    parsed.fieldsTruncated = expectBoolean(form.fieldsTruncated, `${context}.fieldsTruncated`)
  }
  return parsed
}

function parseWatchNode(value: unknown, context: string): WatchNode {
  const node = expectRecord(value, context)
  const parsed: WatchNode = { tag: expectString(node.tag, `${context}.tag`) }
  const id = optionalString(node.id, `${context}.id`)
  if (id !== undefined) parsed.id = id
  const className = optionalString(node.class, `${context}.class`)
  if (className !== undefined) parsed.class = className
  const text = optionalString(node.text, `${context}.text`)
  if (text !== undefined) parsed.text = text
  const attr = optionalString(node.attr, `${context}.attr`)
  if (attr !== undefined) parsed.attr = attr
  const attrValue = optionalString(node.value, `${context}.value`)
  if (attrValue !== undefined) parsed.value = attrValue
  return parsed
}

function parseWatchNodes(value: unknown, context: string): WatchNode[] {
  return expectArray(value, context).map((node, index) => parseWatchNode(node, `${context}[${index}]`))
}

function parseDiffChange(value: unknown, index: number): DiffChange {
  const change = expectRecord(value, `diff.changed[${index}]`)
  return {
    old: parseSnapshotElement(change.old, index),
    new: parseSnapshotElement(change.new, index),
    changes: expectArray(change.changes, `diff.changed[${index}].changes`).map((entry, entryIndex) =>
      expectString(entry, `diff.changed[${index}].changes[${entryIndex}]`)
    )
  }
}

function parseRecorderEntry(value: unknown, index: number): RecorderEntry {
  const entry = expectRecord(value, `record.stop.entries[${index}]`)
  return {
    ...(entry as Record<string, JsonValue>),
    action: expectString(entry.action, `record.stop.entries[${index}].action`),
    timestamp: expectNumber(entry.timestamp, `record.stop.entries[${index}].timestamp`)
  }
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
      const info: WindowInfo = {
        label: expectString(window.label, `windows[${index}].label`),
        url: expectString(window.url, `windows[${index}].url`),
        title: expectString(window.title, `windows[${index}].title`)
      }
      if (window.native_id !== undefined) {
        info.nativeId = expectNumber(window.native_id, `windows[${index}].native_id`)
      }
      return info
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

  /**
   * Action recorder. Captures the RPC calls this connection makes into a
   * replayable scenario — this is not video capture.
   */
  readonly recorder = {
    start: async (): Promise<void> => {
      await this.rpc.call("record.start")
    },
    stop: async (): Promise<RecorderResult> => {
      const value = expectRecord(await this.rpc.call("record.stop"), "record.stop result")
      return {
        entries: expectArray(value.entries, "record.stop.entries").map(parseRecorderEntry),
        count: expectNumber(value.count, "record.stop.count")
      }
    },
    status: async (): Promise<RecorderStatus> => {
      const value = expectRecord(await this.rpc.call("record.status"), "record.status result")
      return {
        active: expectBoolean(value.active, "record.status.active"),
        count: expectNumber(value.count, "record.status.count"),
        elapsed_ms: expectNumber(value.elapsed_ms, "record.status.elapsed_ms")
      }
    },
    add: async (entry: RecorderEntry): Promise<void> => {
      await this.rpc.call("record.add", entry as unknown as Record<string, JsonValue>)
    }
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

  /**
   * Locate by visible text. Matching runs in the page against the live DOM, not
   * against a snapshot's `name`: that field collapses aria-label, alt, `<label>`,
   * placeholder, and text into one 50-character string, so a button with an
   * aria-label would never be findable by the text it actually shows.
   */
  getByText(text: string, query: TextQuery = {}): HasgardLocator {
    return new HasgardLocator(this, { kind: "query", by: "text", value: text, query })
  }

  getByLabel(text: string, query: TextQuery = {}): HasgardLocator {
    return new HasgardLocator(this, { kind: "query", by: "label", value: text, query })
  }

  getByPlaceholder(text: string, query: TextQuery = {}): HasgardLocator {
    return new HasgardLocator(this, { kind: "query", by: "placeholder", value: text, query })
  }

  getByAltText(text: string, query: TextQuery = {}): HasgardLocator {
    return new HasgardLocator(this, { kind: "query", by: "alt", value: text, query })
  }

  getByTitle(text: string, query: TextQuery = {}): HasgardLocator {
    return new HasgardLocator(this, { kind: "query", by: "title", value: text, query })
  }

  /** Test ids always match exactly, so `save` cannot select `save-draft`. */
  getByTestId(testId: string): HasgardLocator {
    return new HasgardLocator(this, { kind: "query", by: "testid", value: testId, query: {} })
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

  async url(): Promise<string> {
    return expectString(await this.rpc.call("url", withWindow(this.label)), "url result")
  }

  async title(): Promise<string> {
    return expectString(await this.rpc.call("title", withWindow(this.label)), "title result")
  }

  /**
   * Navigate this webview by assigning `location.href`. Unlike Playwright's
   * `goto`, this does not wait for the load to finish and returns no response —
   * follow it with `waitFor` or `waitForWindowReady`.
   */
  async navigate(url: string): Promise<void> {
    await this.rpc.call("navigate", withWindow(this.label, { url }))
  }

  /** Scroll the document by a relative amount, or to `top`/`bottom`. */
  async scrollBy(options: ScrollOptions): Promise<void> {
    await this.rpc.call("scroll", withWindow(this.label, options as unknown as Record<string, JsonValue>))
  }

  async press(key: string): Promise<void> {
    await this.rpc.call("press", withWindow(this.label, { key }))
  }

  async diff(options: DiffOptions = {}): Promise<SnapshotDiff> {
    const { reference, ...snapshotOptions } = options
    const params: Record<string, JsonValue> = { ...(snapshotOptions as Record<string, JsonValue>) }
    if (reference) params.reference = reference as unknown as JsonValue
    const value = expectRecord(await this.rpc.call("diff", withWindow(this.label, params)), "diff result")
    return {
      added: expectArray(value.added, "diff.added").map(parseSnapshotElement),
      removed: expectArray(value.removed, "diff.removed").map(parseSnapshotElement),
      changed: expectArray(value.changed, "diff.changed").map(parseDiffChange)
    }
  }

  /**
   * Poll a JavaScript expression in the webview until it returns a truthy
   * value, and return that value. The expression is polled rather than driven
   * by DOM mutations, so predicates that flip on a timer or a resolved fetch
   * are caught too. A predicate that throws rejects instead of being retried.
   */
  async waitForFunction<T = JsonValue>(expression: string, options: WaitForFunctionOptions = {}): Promise<T> {
    const params: Record<string, JsonValue> = { expression }
    if (options.timeoutMs !== undefined) params.timeout = options.timeoutMs
    if (options.pollMs !== undefined) params.poll = options.pollMs
    const value = expectRecord(await this.rpc.call("wait", withWindow(this.label, params)), "wait result")
    return value.value as T
  }

  /** Observe DOM mutations until they settle, or reject when nothing changes. */
  async watch(options: WatchOptions = {}): Promise<WatchChanges> {
    const params: Record<string, JsonValue> = {}
    if (options.selector !== undefined) params.selector = options.selector
    if (options.timeoutMs !== undefined) params.timeout = options.timeoutMs
    if (options.stableMs !== undefined) params.stable = options.stableMs
    if (options.requireMutation !== undefined) params.requireMutation = options.requireMutation
    const value = expectRecord(await this.rpc.call("watch", withWindow(this.label, params)), "watch result")
    return {
      added: parseWatchNodes(value.added, "watch.added"),
      removed: parseWatchNodes(value.removed, "watch.removed"),
      modified: parseWatchNodes(value.modified, "watch.modified"),
      truncated: expectBoolean(value.truncated, "watch.truncated")
    }
  }

  async consoleLogs(options: ConsoleLogOptions = {}): Promise<ConsoleLogEntry[]> {
    const value = await this.rpc.call(
      "console.getLogs",
      withWindow(this.label, options as unknown as Record<string, JsonValue>)
    )
    return expectArray(value, "console.getLogs result").map(parseConsoleLogEntry)
  }

  async clearConsole(): Promise<void> {
    await this.rpc.call("console.clear", withWindow(this.label))
  }

  async networkRequests(options: NetworkRequestOptions = {}): Promise<NetworkRequestEntry[]> {
    const value = await this.rpc.call(
      "network.getRequests",
      withWindow(this.label, options as unknown as Record<string, JsonValue>)
    )
    return expectArray(value, "network.getRequests result").map(parseNetworkRequestEntry)
  }

  async clearNetwork(): Promise<void> {
    await this.rpc.call("network.clear", withWindow(this.label))
  }

  /** `localStorage` by default; pass `{ session: true }` for `sessionStorage`. */
  readonly storage = {
    get: async (key: string, options: StorageOptions = {}): Promise<string | null> => {
      const value = expectRecord(
        await this.rpc.call("storage.get", withWindow(this.label, { key, ...options })),
        "storage.get result"
      )
      if (!expectBoolean(value.found, "storage.get.found")) return null
      return expectString(value.value, "storage.get.value")
    },
    set: async (key: string, value: string, options: StorageOptions = {}): Promise<void> => {
      await this.rpc.call("storage.set", withWindow(this.label, { key, value, ...options }))
    },
    list: async (options: StorageOptions = {}): Promise<StorageListing> => {
      const value = expectRecord(
        await this.rpc.call("storage.list", withWindow(this.label, { ...options })),
        "storage.list result"
      )
      return {
        entries: expectArray(value.entries, "storage.list.entries").map((entry, index): StorageEntry => {
          const parsed = expectRecord(entry, `storage.list.entries[${index}]`)
          return {
            key: expectString(parsed.key, `storage.list.entries[${index}].key`),
            value: expectString(parsed.value, `storage.list.entries[${index}].value`)
          }
        }),
        truncated: expectBoolean(value.truncated, "storage.list.truncated")
      }
    },
    clear: async (options: StorageOptions = {}): Promise<void> => {
      await this.rpc.call("storage.clear", withWindow(this.label, { ...options }))
    }
  }

  async forms(selector?: string): Promise<FormsDump> {
    const params = selector ? { selector } : undefined
    const value = expectRecord(await this.rpc.call("forms.dump", withWindow(this.label, params)), "forms.dump result")
    return {
      forms: expectArray(value.forms, "forms.dump.forms").map(parseFormEntry),
      truncated: expectBoolean(value.truncated, "forms.dump.truncated")
    }
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

  /**
   * Capture this window through the native compositor, writing a PNG to
   * `outputPath`. macOS only.
   *
   * Unlike `screenshot`, which renders the DOM inside the page, this records
   * what the window server actually shows — so it sees native chrome, layered
   * content, and anything the DOM renderer cannot reproduce.
   *
   * The operating-system window id is resolved from this window's label, so
   * callers do not have to discover it themselves.
   */
  async screenshotNative(options: NativeScreenshotOptions): Promise<NativeScreenshot> {
    const windowId = options.windowId ?? (await this.nativeId())
    const value = expectRecord(
      await this.rpc.call("screenshot_native", {
        window_id: windowId,
        output_path: options.outputPath
      }),
      "screenshot_native result"
    )
    return {
      output_path: expectString(value.output_path, "screenshot_native.output_path"),
      window_id: expectNumber(value.window_id, "screenshot_native.window_id"),
      width: expectNumber(value.width, "screenshot_native.width"),
      height: expectNumber(value.height, "screenshot_native.height"),
      scale_factor: expectNumber(value.scale_factor, "screenshot_native.scale_factor"),
      byte_size: expectNumber(value.byte_size, "screenshot_native.byte_size"),
      backend: expectString(value.backend, "screenshot_native.backend"),
      tcc_denied: expectBoolean(value.tcc_denied, "screenshot_native.tcc_denied")
    }
  }

  /**
   * Scroll the page by wheel.
   *
   * The document sees a real `wheel` event first and may cancel it; the scroll
   * only follows if it does not. Resolves to whether the page cancelled — which
   * is how you tell "the app intercepted my wheel" from "nothing was
   * listening". Use the locator method to scroll a nested scrollport.
   */
  async wheel(deltaX: number, deltaY: number): Promise<boolean> {
    const value = expectRecord(await this.call("wheel", { deltaX, deltaY }), "wheel result")
    return expectBoolean(value.defaultPrevented, "wheel.defaultPrevented")
  }

  /**
   * The page's modal dialogs (`alert`, `confirm`, `prompt`).
   *
   * These block the webview until answered, so the bridge always answers them —
   * dismissing by default, as Playwright does. A test that never touches this
   * namespace still cannot hang on a `confirm()`, and can read back what the
   * app tried to ask.
   */
  readonly dialogs = {
    /** Answer every subsequent dialog with OK. `promptText` fills a `prompt`. */
    accept: async (promptText?: string): Promise<DialogPolicy> => {
      const params: Record<string, JsonValue> = { action: "accept" }
      if (promptText !== undefined) params.promptText = promptText
      return parseDialogPolicy(await this.call("dialog.handle", params))
    },
    /** Answer every subsequent dialog with Cancel. This is the default. */
    dismiss: async (): Promise<DialogPolicy> =>
      parseDialogPolicy(await this.call("dialog.handle", { action: "dismiss" })),
    /** Every dialog the page has opened so far, oldest first. */
    list: async (): Promise<DialogListing> => {
      const value = expectRecord(await this.call("dialog.list"), "dialog.list result")
      if (!Array.isArray(value.dialogs)) throw new Error("dialog.list.dialogs must be an array")
      return {
        dialogs: value.dialogs.map((entry, index) => parseDialogRecord(entry, index)),
        policy: parseDialogPolicy(value.policy)
      }
    },
    /** Forget the recorded dialogs. Leaves the accept/dismiss policy alone. */
    clear: async (): Promise<void> => {
      await this.call("dialog.clear")
    }
  }

  /** This window's operating-system window id, where the platform exposes one. */
  async nativeId(): Promise<number> {
    const listing = await new HasgardApplication(this.rpc).windows()
    const self = listing.find(entry => entry.label === this.label)
    if (!self) throw new Error(`Window '${this.label}' is no longer open`)
    if (self.nativeId === undefined) {
      throw new Error(`Window '${this.label}' has no native window id on this platform`)
    }
    return self.nativeId
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

type LocatorQuery = (
  | { kind: "selector"; selector: string }
  | { kind: "role"; role: string; query: RoleQuery }
  | { kind: "query"; by: QueryDimension; value: string; query: TextQuery }
) & { index?: number; filters?: FilterOptions[] }

export class HasgardLocator {
  readonly window: HasgardWindow
  private readonly query: LocatorQuery

  constructor(window: HasgardWindow, query: LocatorQuery) {
    this.window = window
    this.query = query
  }

  /**
   * Click this element.
   *
   * A right or middle click raises `contextmenu`/`auxclick` and no `click`, and
   * `clickCount: 2` escalates `detail` across the presses before a single
   * `dblclick` -- both matching what the platform does, so a listener bound to
   * the wrong event fails here rather than in front of a user.
   */
  async click(options: ClickOptions = {}): Promise<void> {
    await this.withTarget(target => this.window.call("click", { ...targetParams(target), ...clickParams(options) }))
  }

  async fill(value: string): Promise<void> {
    await this.withTarget(target => this.window.call("fill", { ...targetParams(target), value }))
  }

  async type(text: string): Promise<void> {
    await this.withTarget(target => this.window.call("type", { ...targetParams(target), text }))
  }

  /** Empty the control, firing `input` and `change` as `fill` does. */
  async clear(): Promise<void> {
    await this.fill("")
  }

  /**
   * Select files on an `<input type="file">` without a native file chooser,
   * which an embedded webview gives no way to drive.
   *
   * Strings are read from the test machine's disk; `DropFile` payloads let you
   * supply content that never existed as a file. An empty array deselects.
   */
  async setInputFiles(files: FileInput | FileInput[]): Promise<void> {
    const payloads = await readFileInputs(files)
    await this.withTarget(target =>
      this.window.call("setInputFiles", {
        ...targetParams(target),
        files: payloads as unknown as JsonValue
      })
    )
  }

  /**
   * Scroll this element by wheel.
   *
   * The page sees a real `wheel` event first and may cancel it; the scroll only
   * follows if it does not — the same two steps a physical wheel produces.
   * Resolves to whether the page cancelled.
   */
  async wheel(deltaX: number, deltaY: number): Promise<boolean> {
    return this.withTarget(async target => {
      const value = expectRecord(
        await this.window.call("wheel", { ...targetParams(target), deltaX, deltaY }),
        "wheel result"
      )
      return expectBoolean(value.defaultPrevented, "wheel.defaultPrevented")
    })
  }

  async selectOption(value: string): Promise<void> {
    await this.withTarget(target => this.window.call("select", { ...targetParams(target), value }))
  }

  /** Drive the checkbox to checked. A no-op when it is already checked. */
  async check(): Promise<void> {
    await this.withTarget(target => this.window.call("check", { ...targetParams(target), checked: true }))
  }

  /** Drive the checkbox to unchecked. A no-op when it is already unchecked. */
  async uncheck(): Promise<void> {
    await this.withTarget(target => this.window.call("check", { ...targetParams(target), checked: false }))
  }

  /** Flip the checkbox, whatever its current state. */
  async toggle(): Promise<void> {
    await this.withTarget(target => this.window.call("check", targetParams(target)))
  }

  async hover(): Promise<void> {
    await this.withTarget(target => this.window.call("hover", targetParams(target)))
  }

  /** Shorthand for `click({ clickCount: 2 })`; other options still apply. */
  async dblclick(options: Omit<ClickOptions, "clickCount"> = {}): Promise<void> {
    await this.click({ ...options, clickCount: 2 })
  }

  async focus(): Promise<void> {
    await this.withTarget(target => this.window.call("focus", targetParams(target)))
  }

  async blur(): Promise<void> {
    await this.withTarget(target => this.window.call("blur", targetParams(target)))
  }

  /** Scroll this element's own scrollport. */
  async scrollBy(options: ScrollOptions): Promise<void> {
    await this.withTarget(target =>
      this.window.call("scroll", { ...targetParams(target), ...(options as unknown as Record<string, JsonValue>) })
    )
  }

  async boundingBox(): Promise<BoundingBox> {
    return this.withTarget(async target => {
      const value = expectRecord(await this.window.call("boundingBox", targetParams(target)), "boundingBox result")
      return {
        x: expectNumber(value.x, "boundingBox.x"),
        y: expectNumber(value.y, "boundingBox.y"),
        width: expectNumber(value.width, "boundingBox.width"),
        height: expectNumber(value.height, "boundingBox.height")
      }
    })
  }

  async isDisabled(): Promise<boolean> {
    return this.withTarget(async target => {
      const value = expectRecord(await this.window.call("disabled", targetParams(target)), "disabled result")
      return expectBoolean(value.disabled, "disabled.disabled")
    })
  }

  async isEnabled(): Promise<boolean> {
    return !(await this.isDisabled())
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

  async innerHTML(): Promise<string> {
    return this.withTarget(async target =>
      expectString(await this.window.call("html", targetParams(target)), "html result")
    )
  }

  async getAttribute(name: string): Promise<string | null> {
    const attributes = await this.attributes()
    return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name]! : null
  }

  /** Drag this element onto another one in the same window. */
  async dragTo(target: HasgardLocator): Promise<void> {
    if (target.window !== this.window) {
      throw new Error("dragTo requires both locators to belong to the same window")
    }
    await this.window.runExclusive(async () => {
      const source = await this.resolveUnique()
      const destination = await target.resolveUnique()
      await this.window.call("drag", {
        source: targetParams(source),
        target: targetParams(destination)
      })
    })
  }

  /** Drag this element by a pixel offset from its centre. */
  async dragBy(offset: DragOffset): Promise<void> {
    await this.withTarget(target =>
      this.window.call("drag", { source: targetParams(target), offset: { x: offset.x, y: offset.y } })
    )
  }

  /** Dispatch a file drop onto this element. `data` is base64-encoded. */
  async dropFiles(files: DropFile[]): Promise<void> {
    await this.withTarget(target =>
      this.window.call("drop", {
        ...targetParams(target),
        files: files as unknown as JsonValue
      })
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
    // The `count` op counts selector matches and knows nothing about text, so
    // a filtered locator has to resolve its elements to count them.
    const total =
      this.query.kind === "selector" && !this.query.filters?.length
        ? expectNumber(
            expectRecord(await this.window.call("count", { selector: this.query.selector }), "count result").count,
            "count.count"
          )
        : (await this.resolveAll()).length
    if (this.query.index === undefined) return total
    const position = absoluteIndex(this.query.index, total)
    return position >= 0 && position < total ? 1 : 0
  }

  async waitFor(options: WaitOptions): Promise<void> {
    // The bridge's `wait` op knows nothing about ordinals or text, so an
    // indexed or filtered locator has to poll its own count — waiting on the
    // bare selector would resolve as soon as *any* match appeared, even one
    // the index or filter excludes.
    if (this.query.kind === "selector" && this.query.index === undefined && !this.query.filters?.length) {
      await this.window.call("wait", {
        selector: this.query.selector,
        gone: options.state === "detached",
        timeout: options.timeoutMs
      })
      return
    }

    const deadline = Date.now() + options.timeoutMs
    while (Date.now() <= deadline) {
      const found = (await this.count()) > 0
      if (found === (options.state === "attached")) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Locator did not become ${options.state} within ${options.timeoutMs}ms`)
  }

  /**
   * Narrow this locator to a single match by position. A negative index counts
   * back from the end, so `last()` stays one round trip.
   */
  nth(index: number): HasgardLocator {
    if (!Number.isInteger(index)) throw new Error("nth requires an integer index")
    return new HasgardLocator(this.window, { ...this.query, index })
  }

  /**
   * Narrow this locator to the elements whose text matches.
   *
   * Filters accumulate, so `filter({hasText}).filter({hasNotText})` applies
   * both. Ordering matters against `nth`: filtering happens first, so
   * `filter({hasText: "x"}).first()` is the first *matching* element, which is
   * the reading that makes `first()` mean what it says.
   */
  filter(options: FilterOptions): HasgardLocator {
    if (options.hasText === undefined && options.hasNotText === undefined) {
      throw new Error("filter requires hasText or hasNotText")
    }
    return new HasgardLocator(this.window, {
      ...this.query,
      filters: [...(this.query.filters ?? []), options]
    })
  }

  first(): HasgardLocator {
    return this.nth(0)
  }

  last(): HasgardLocator {
    return this.nth(-1)
  }

  private async resolveUnique(): Promise<HasgardTarget> {
    // An unfiltered CSS locator resolves inside the same round trip that acts
    // on it, so the DOM cannot shift in between. A filter needs the elements'
    // text, which only the general path can read — accept the extra trip.
    if (this.query.kind === "selector" && !this.query.filters?.length) {
      return this.query.index === undefined
        ? bySelector(this.query.selector)
        : { selector: this.query.selector, index: this.query.index }
    }
    const elements = await this.resolveAll()
    if (this.query.index !== undefined) {
      const element = elements[absoluteIndex(this.query.index, elements.length)]
      if (!element) {
        throw new Error(`Locator has no element at index ${this.query.index} (${elements.length} matched)`)
      }
      return byRef(element.ref)
    }
    if (elements.length !== 1) {
      throw new Error(`Locator resolved to ${elements.length} elements; expected exactly one`)
    }
    return byRef(elements[0]!.ref)
  }

  private async withTarget<T>(operation: (target: HasgardTarget) => Promise<T>): Promise<T> {
    return this.window.runExclusive(async () => operation(await this.resolveUnique()))
  }

  private async resolveAll(): Promise<SnapshotElement[]> {
    return this.applyFilters(await this.resolveBase())
  }

  private async resolveBase(): Promise<SnapshotElement[]> {
    // A CSS locator reaches here only once a filter has been applied, and the
    // `selector` query dimension is what lets it produce refs like any other.
    if (this.query.kind === "selector") {
      return this.runQuery({ by: "selector", value: this.query.selector })
    }
    if (this.query.kind === "query") {
      const params: Record<string, JsonValue> = { by: this.query.by, value: this.query.value }
      if (this.query.query.exact !== undefined) params.exact = this.query.query.exact
      return this.runQuery(params)
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

  /**
   * Apply each accumulated filter, one round trip per filter.
   *
   * Filters run server-side rather than against a snapshot because the text a
   * filter matches on is not carried in snapshot entries — deliberately, so
   * that every unrelated `snapshot` call stays small.
   */
  private async applyFilters(elements: SnapshotElement[]): Promise<SnapshotElement[]> {
    const filters = this.query.filters ?? []
    let current = elements
    for (const filter of filters) {
      // An empty set cannot survive further narrowing; skip the round trip.
      if (current.length === 0) return current
      const params: Record<string, JsonValue> = { refs: current.map(element => element.ref) }
      if (filter.hasText !== undefined) params.hasText = filter.hasText
      if (filter.hasNotText !== undefined) params.hasNotText = filter.hasNotText
      if (filter.exact !== undefined) params.exact = filter.exact
      current = this.parseElements(await this.window.call("filter", params), "filter")
    }
    return current
  }

  private async runQuery(params: Record<string, JsonValue>): Promise<SnapshotElement[]> {
    return this.parseElements(await this.window.call("query", params), "query")
  }

  private parseElements(raw: unknown, source: string): SnapshotElement[] {
    const value = expectRecord(raw, `${source} result`)
    if (!Array.isArray(value.elements)) throw new Error(`${source}.elements must be an array`)
    return value.elements.map((entry, index) => parseSnapshotElement(entry, index))
  }
}

function parseDialogPolicy(value: unknown): DialogPolicy {
  const record = expectRecord(value, "dialog policy")
  const action = expectString(record.action, "dialog policy.action")
  if (action !== "accept" && action !== "dismiss") {
    throw new Error(`dialog policy.action must be "accept" or "dismiss", got ${action}`)
  }
  return {
    action,
    promptText: record.promptText == null ? null : expectString(record.promptText, "dialog policy.promptText")
  }
}

function parseDialogRecord(value: unknown, index: number): DialogRecord {
  const entry = expectRecord(value, `dialogs[${index}]`)
  const type = expectString(entry.type, `dialogs[${index}].type`)
  if (type !== "alert" && type !== "confirm" && type !== "prompt") {
    throw new Error(`dialogs[${index}].type must be alert, confirm, or prompt, got ${type}`)
  }
  const record: DialogRecord = {
    id: expectNumber(entry.id, `dialogs[${index}].id`),
    timestamp: expectNumber(entry.timestamp, `dialogs[${index}].timestamp`),
    type,
    message: expectString(entry.message, `dialogs[${index}].message`),
    accepted: expectBoolean(entry.accepted, `dialogs[${index}].accepted`)
  }
  if (entry.defaultValue !== undefined) {
    record.defaultValue = expectString(entry.defaultValue, `dialogs[${index}].defaultValue`)
  }
  if (entry.returned !== undefined) record.returned = expectString(entry.returned, `dialogs[${index}].returned`)
  return record
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
