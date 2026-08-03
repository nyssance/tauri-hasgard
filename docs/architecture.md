# Architecture

Tauri Hasgard is one automation system with three public clients, not three independent test stacks.

```text
Playwright Test fixture ─┐
CLI ────────────────────┼─ newline-delimited JSON-RPC 2.0 ─ Tauri debug plugin ─ real webviews
MCP server ─────────────┘
```

## Product boundary

`tauri-hasgard` is the complete product and repository. `tauri-plugin-hasgard` is the required in-process bridge package because WKWebView and WebKitGTK do not expose Chromium CDP. Calling the product a plugin would be inaccurate; removing the plugin would make native macOS and Linux automation impossible.

## Why there is no fake Page

Playwright's `Page` contract includes Chromium-backed navigation, routing, tracing, frames, downloads, browser contexts, and hundreds of behavioral guarantees. A Tauri WebKit webview cannot honestly satisfy that contract. Hasgard therefore exposes:

- `HasgardApplication` for application and window discovery;
- `HasgardWindow` for one explicit Tauri window label;
- `HasgardLocator` for CSS or accessibility-snapshot targets;
- Playwright Test for scheduling, retries, assertions, reports, and artifacts.

## Isolation

Managed Playwright workers receive distinct `TAURI_HASGARD_SOCKET` paths. Every command from the fixture includes an explicit Tauri window label. The bridge never silently routes a missing window to an arbitrary open window.

## Target resolution

The wire protocol supports three target forms:

| Target             | JSON                                   |
| ------------------ | -------------------------------------- |
| Snapshot reference | `{ "ref": "e12" }`                     |
| CSS selector       | `{ "selector": "[data-testid=save]" }` |
| Viewport point     | `{ "x": 120, "y": 80 }`                |

Role locators take a fresh accessibility snapshot immediately before an action, require exactly one match, and then send the resulting ref. This preserves semantic selectors without inventing a Chromium locator engine.

## Test layers

| Layer                 | Covers                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| TypeScript unit       | JSON-RPC framing, out-of-order response IDs, error objects, locator uniqueness and window routing            |
| Bridge behavior       | Accessibility names, snapshots, select, drag, full-page screenshot                                           |
| Rust workspace        | socket/named-pipe transport, handlers, CLI, MCP, native screenshot platform code                             |
| Native Playwright E2E | real Tauri app, main/secondary window isolation, keyboard focus, dialog, 80 unequal-height items, screenshot |
