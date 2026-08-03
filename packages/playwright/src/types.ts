export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type HasgardTarget =
  { ref: string } | { selector: string } | { x: number; y: number };

export interface SnapshotElement {
  ref: string;
  role: string;
  depth: number;
  name?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
}

export interface Snapshot {
  elements: SnapshotElement[];
}

export interface SnapshotOptions {
  interactive?: boolean;
  selector?: string;
  depth?: number;
}

export interface WindowInfo {
  label: string;
  url: string;
  title: string;
}

export interface WindowState {
  url: string;
  title: string;
  readyState: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  plugin_version: string;
}

export interface RoleQuery {
  name?: string | RegExp;
  exact?: boolean;
}

export interface WaitOptions {
  state: "attached" | "detached";
  timeoutMs: number;
}

export interface HasgardLaunchConfig {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface HasgardTestConfig {
  test: typeof import("@playwright/test").test;
  expect: typeof import("@playwright/test").expect;
  socketPath: string | ((workerIndex: number) => string);
  windowLabel: string;
  readySelector: string;
  launch?: HasgardLaunchConfig;
}

export interface HasgardFixtures {
  window: import("./window.js").HasgardWindow;
}

export interface HasgardWorkerFixtures {
  hasgard: import("./window.js").HasgardApplication;
}
