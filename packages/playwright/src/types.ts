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
}

export interface WindowInfo {
  label: string
  url: string
  title: string
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
  state: "attached" | "detached"
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

export interface DropFile {
  name: string
  /** Base64-encoded file contents. */
  data: string
  type?: string
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
  /** Operating-system window id, not a Tauri webview label. */
  windowId: number
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
