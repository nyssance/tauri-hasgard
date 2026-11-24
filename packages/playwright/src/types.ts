export type JsonPrimitive = boolean | number | string | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type HasgardTarget = { ref: string } | { selector: string; index?: number } | { x: number; y: number }

export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface SnapshotElement {
  ref: string
  role: string
  depth: number
  name?: string
  value?: string
  checked?: boolean
  disabled?: boolean
}

export interface Snapshot {
  elements: SnapshotElement[]
}

export interface SnapshotOptions {
  interactive?: boolean
  selector?: string
  depth?: number
  /**
   * Take the snapshot inside this chain of same-origin iframes, one CSS
   * selector per nesting level, instead of in the top document.
   */
  frame?: string[]
}

export interface WindowInfo {
  /** Routing label of the webview, including CEF child webviews. */
  label: string
  /** Native host window label; multiple webviews can share one host. */
  windowLabel?: string
  url: string
  title: string
  /** Operating-system window id. Present only where native capture exists. */
  nativeId?: number
}

export interface WindowState {
  url: string
  title: string
  readyState: string
  viewport: { width: number; height: number }
  scroll: { x: number; y: number }
  plugin_version: string
}

export interface RoleQuery {
  name?: string | RegExp
  exact?: boolean
}

export interface WaitOptions {
  /** `visible` and `hidden` follow what a user sees; `attached` and `detached` follow the document. */
  state: "attached" | "detached" | "visible" | "hidden"
  timeoutMs: number
}

export interface ScrollOptions {
  direction: "up" | "down" | "left" | "right" | "top" | "bottom"
  amount?: number
}

export interface DragOffset {
  x: number
  y: number
}

/** A held keyboard modifier. Named as the platform reports them on the event. */
export type KeyModifier = "Alt" | "Control" | "Meta" | "Shift"

/** An application postcondition to await before another native press may focus a window. */
export interface PressOptions {
  completion?: "webview" | "native"
  waitFor?: string
  timeoutMs?: number
}

export type MouseButton = "left" | "middle" | "right"

/** A point inside the element, measured from its top-left corner. */
export interface ElementPosition {
  x: number
  y: number
}

export interface ClickOptions {
  /**
   * Modifiers held for the whole gesture. `Meta` is Command on macOS and the
   * Windows key elsewhere -- the platform's own accelerator, which is why
   * multi-select lists usually bind it rather than `Control`.
   */
  modifiers?: KeyModifier[]
  /**
   * Which button. `right` raises `contextmenu` and `middle` raises `auxclick`;
   * neither raises `click`, exactly as a real press does not.
   */
  button?: MouseButton
  /** Presses in one gesture. `2` also raises a single `dblclick` at the end. */
  clickCount?: number
  /** Where inside the element to press. Defaults to its centre. */
  position?: ElementPosition
}

export interface DropFile {
  name: string
  /** Base64-encoded file contents. */
  data: string
  type?: string
}

/** A file the application reads from disk itself; how a large file is sent. */
export interface DropFilePath {
  name: string
  /** Absolute path on the machine running the application. */
  path: string
  type?: string
}

/**
 * A file to hand to the page: either a path on the test machine, which is read
 * and encoded for you, or an in-memory payload for content that never existed
 * as a file.
 */
export type FileInput = string | DropFile

/** Refinement applied to an existing locator. Both may be combined. */
export interface FilterOptions {
  /** Keep only elements whose subtree text matches. */
  hasText?: string
  /** Drop elements whose subtree text matches. */
  hasNotText?: string
  /** Require a whole-string match instead of a substring one. */
  exact?: boolean
}

export type DialogType = "alert" | "confirm" | "prompt"

/** A modal the page opened while the standing policy decided its outcome. */
export interface DialogRecord {
  id: number
  timestamp: number
  type: DialogType
  message: string
  /** Whether the policy accepted it. A one-button `alert` is always accepted. */
  accepted: boolean
  /** The page's suggested answer, for `prompt` only. */
  defaultValue?: string
  /** What the page received back, for an accepted `prompt`. */
  returned?: string
}

/**
 * How the next dialog will be answered.
 *
 * This is a standing policy rather than Playwright's per-event handler: the
 * bridge must answer synchronously inside the page's `confirm()` call, with no
 * chance to await a decision from the test process.
 */
export interface DialogPolicy {
  action: "accept" | "dismiss"
  promptText: string | null
}

export interface DialogListing {
  dialogs: DialogRecord[]
  policy: DialogPolicy
}

/** How the dialog plugin's open, save and message dialogs are answered. */
export interface NativeDialogPolicy {
  /** `manual` leaves them to the operating system, as for a person. */
  action: "accept" | "dismiss" | "manual"
  paths: string[]
  button: string | null
}

export interface NativeDialogAnswer {
  /** What an open or save dialog returns. An open dialog that allows several takes them all. */
  paths?: string[]
  /** The message dialog button to press, by its label. Defaults to the affirmative one. */
  button?: string
}

/** One native dialog the application asked for while a policy was answering them. */
export interface NativeDialogRecord {
  id: number
  timestamp: number
  kind: "open" | "save" | "message"
  accepted: boolean
  title?: string
  message?: string
  defaultPath?: string
  multiple?: boolean
  directory?: boolean
  /** The labels a message dialog offered. */
  buttons?: string[]
  /** What the application received: a path, several, a button label, or null. */
  result: string | string[] | null
}

export interface NativeDialogListing {
  dialogs: NativeDialogRecord[]
  policy: NativeDialogPolicy
}

/** How a matched request is answered. */
export interface RouteOptions {
  /**
   * Glob against the full URL. `*` stays inside one path segment, `**` crosses
   * separators, and the pattern is anchored at both ends -- so `**\/api` does
   * not also intercept `/v2/api-docs`.
   */
  pattern: string
  /** Restrict to one HTTP verb. Any verb matches when omitted. */
  method?: string
  /** Stop matching after this many requests, letting later ones through. */
  times?: number
}

export interface FulfillOptions extends RouteOptions {
  /** Defaults to 200. */
  status?: number
  body?: string
  /** Defaults to `text/plain`. */
  contentType?: string
}

export interface RouteRule {
  id: number
  pattern: string
  method: string | null
  action: "fulfill" | "abort"
  status: number
  times: number | null
  /** How many requests this rule has already answered. */
  used: number
}

export interface InterceptedRequest {
  id: number
  timestamp: number
  route_id: number
  method: string
  url: string
  action: "fulfill" | "abort"
  status: number
}

export interface RouteListing {
  routes: RouteRule[]
  intercepted: InterceptedRequest[]
}

export interface ConsoleLogOptions {
  level?: "log" | "warn" | "error" | "info"
  since?: number
  sinceId?: number
  last?: number
}

export interface ConsoleLogEntry {
  id: number
  timestamp: number
  level: string
  args: JsonValue[]
  source: string | null
}

export interface NetworkRequestOptions {
  filter?: string
  failedOnly?: boolean
  sinceId?: number
  last?: number
}

export interface NetworkRequestEntry {
  id: number
  timestamp: number
  method: string
  url: string
  status: number
  duration_ms: number
  error: string | null
  request_size: number
  response_size: number
}

export interface StorageOptions {
  /** Read and write `sessionStorage` instead of `localStorage`. */
  session?: boolean
}

export interface StorageEntry {
  key: string
  value: string
}

export interface StorageListing {
  entries: StorageEntry[]
  truncated: boolean
}

export interface FormField {
  tag: string
  type: string | null
  name: string
  value: string | string[]
  checked?: boolean
}

export interface FormEntry {
  id: string
  name: string
  action: string
  method: string
  fields: FormField[]
  fieldsTruncated?: boolean
}

export interface FormsDump {
  forms: FormEntry[]
  truncated: boolean
}

export type QueryDimension = "text" | "label" | "placeholder" | "testid" | "alt" | "title"

export interface TextQuery {
  /** Full, case-sensitive match. Whitespace is normalized either way. */
  exact?: boolean
}

export interface WaitForFunctionOptions {
  timeoutMs?: number
  /** How often to re-evaluate the expression. Defaults to 50ms in the bridge. */
  pollMs?: number
}

/** A file a webview downloaded, as the application's download hook reported it. */
export interface Download {
  id: number
  timestamp: number
  /** The webview that started it. */
  window: string
  url: string
  /** Where the file is, or was to be, saved. */
  path: string | null
  state: "started" | "finished" | "failed"
}

/** A Tauri event the application emitted while it was being recorded. */
export interface RecordedEvent {
  id: number
  timestamp: number
  event: string
  payload: JsonValue
}

export type CookieSameSite = "Strict" | "Lax" | "None"

/** A cookie in the webview's store. `expires` is seconds since the Unix epoch, null for a session cookie. */
export interface Cookie {
  name: string
  value: string
  domain: string | null
  path: string | null
  expires: number | null
  httpOnly: boolean
  secure: boolean
  sameSite: CookieSameSite | null
}

/** A cookie to set. `url` supplies the domain, the path `/` and `secure` for https. */
export interface CookieInit {
  name: string
  value: string
  url?: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: CookieSameSite
}

export interface CookieFilter {
  /** Only the cookies a request to this URL would carry. */
  url?: string
  name?: string
}

/** The operating-system window: position and size in logical pixels, and its flags. */
export interface NativeWindowState {
  label: string
  x: number
  y: number
  width: number
  height: number
  scaleFactor: number
  visible: boolean
  focused: boolean
  minimized: boolean
  maximized: boolean
  fullscreen: boolean
}

export type LoadState = "load" | "domcontentloaded"

export interface WaitForURLOptions {
  timeoutMs?: number
  /** Also require the document to have reached this load state. */
  waitUntil?: LoadState
}

export interface WatchOptions {
  selector?: string
  timeoutMs?: number
  stableMs?: number
  requireMutation?: boolean
}

export interface WatchNode {
  tag: string
  id?: string
  class?: string
  text?: string
  attr?: string
  value?: string
}

export interface WatchChanges {
  added: WatchNode[]
  removed: WatchNode[]
  modified: WatchNode[]
  truncated: boolean
}

export interface DiffOptions extends SnapshotOptions {
  /** Compare against this snapshot instead of the plugin's last stored one. */
  reference?: Snapshot
}

export interface DiffChange {
  old: SnapshotElement
  new: SnapshotElement
  changes: string[]
}

export interface SnapshotDiff {
  added: SnapshotElement[]
  removed: SnapshotElement[]
  changed: DiffChange[]
}

export interface NativeScreenshotOptions {
  /** Absolute path; the parent directory must already exist. */
  outputPath: string
  /**
   * Explicit OS window id captures the whole composited window, including native
   * children. Omit to capture only this webview's rendered viewport.
   */
  windowId?: number
}

export interface NativeScreenshot {
  output_path: string
  window_id: number
  width: number
  height: number
  scale_factor: number
  byte_size: number
  backend: string
  tcc_denied: boolean
}

export interface RecorderEntry {
  action: string
  timestamp: number
  [key: string]: JsonValue
}

export interface RecorderStatus {
  active: boolean
  count: number
  elapsed_ms: number
}

export interface RecorderResult {
  entries: RecorderEntry[]
  count: number
}

export interface HasgardLaunchConfig {
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
  env?: NodeJS.ProcessEnv
}

export interface HasgardTestConfig {
  test: typeof import("@playwright/test").test
  expect: typeof import("@playwright/test").expect
  socketPath: string | ((workerIndex: number) => string)
  windowLabel: string
  readySelector: string
  launch?: HasgardLaunchConfig
}

export interface HasgardFixtures {
  window: import("./window.js").HasgardWindow
}

export interface HasgardWorkerFixtures {
  hasgard: import("./window.js").HasgardApplication
}
