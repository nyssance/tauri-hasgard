# Changelog

All notable changes to this project are documented here. Versions follow
[Semantic Versioning](https://semver.org/); while the project is `0.x`, a minor
bump may carry breaking changes.

The three published artifacts — `tauri-plugin-hasgard`, `tauri-hasgard-cli`, and
`@nyssance/tauri-hasgard` — share one version.

## [Unreleased]

### Added

- `click` takes `modifiers`, `button`, `clickCount`, and `position`. Until now a
  click could only be an unmodified left press at the element centre, which put
  Shift-extended multi-select, right-click context menus, and anything that
  branches on `detail` out of reach entirely.

  The event stream follows the platform rather than being convenient: a right
  press raises `contextmenu` and a middle press raises `auxclick`, and **neither
  raises `click`**. An app that binds its context menu to `click` therefore fails
  here, which is the point — it is already broken for every real user.
  `clickCount: 2` escalates `detail` across the presses and ends in a single
  `dblclick`, so the two are distinguishable.

  Available on all four surfaces: `locator.click(options)`, the `click` MCP tool,
  and `tauri-hasgard click --modifier Shift --button right --click-count 2
--position 10,5`.

### Changed

- `dblclick` is now `click({ clickCount: 2 })` on every surface, one
  implementation instead of two. The previous version replayed the whole gesture
  twice, which reset `detail` to 1 on the second press and raised `dblclick`
  unconditionally — neither matches a real double click.

## [0.2.1]

Supersedes `v0.2.0`, which was tagged but published nothing: its release run
failed in the end-to-end gate before any registry job started, so no crate, npm
package, or GitHub Release for `0.2.0` exists.

### Fixed since the 0.2.0 tag

- Two end-to-end tests asserted behaviour that only holds on one platform:
  `resolves its own operating-system window id` expected a native id everywhere,
  though `native_window_id` returns `None` off macOS by design; and
  `moves focus in and out of a real input` depended on `#search` not already
  being focused, which an earlier test leaves it.

### Fixed

- **macOS: `press` of a plain character aborted the host application.** enigo's
  layout lookup reaches HIToolbox's `TSMGetInputSourceProperty`, which asserts it
  is on the main dispatch queue and raises `SIGTRAP` anywhere else — killing the
  process rather than returning an error. Injection now runs on the main thread.
  Named keys such as `Tab` carry fixed keycodes and never took that path, which
  is why the bug survived a release. The hop is confined to macOS: Windows'
  `SendInput` and the Linux X11/libei backends inject from any thread, and
  blocking the Linux main loop can deadlock `Enigo::new`'s portal handshake.
- **macOS: `windows.list` read `NSWindow.windowNumber` off the main thread.** The
  same class of unsafe AppKit access, in a spot that happens not to assert. The
  read now hops, bounded at 2s so a wedged main thread degrades the listing to
  "no id" rather than hanging it.
- `count()` and `waitFor()` on a filtered locator took a CSS fast path that
  ignored the filter, reporting the unfiltered count and waking on an excluded
  match.

### Added

- **Modal dialog handling.** `alert`, `confirm`, and `prompt` block the webview
  until answered; unanswered, the app freezes and every in-flight call dies on an
  unrelated timeout. The bridge now answers them — dismissing by default, as
  Playwright does — and records each one. This is a standing policy rather than a
  per-event handler because the answer must be produced synchronously inside the
  page's own call. `window.dialogs.{accept,dismiss,list,clear}`; CLI `dialog`.
- **`setInputFiles`.** Populates an `<input type="file">` without a native file
  chooser, which an embedded webview gives no way to drive. Rejects a non-file
  target, where the assignment would silently no-op, and rejects overfilling a
  single-file input, where the browser would keep only the last file. CLI
  `set-input-files`.
- **`wheel`.** Reproduces the browser's two steps — dispatch, then scroll only if
  the page did not cancel — and reports which happened. A synthetic `WheelEvent`
  alone fires listeners without moving the scrollport. CLI `wheel`.
- **`filter({ hasText, hasNotText })`.** Refines any locator kind. Filters
  compose and apply before `nth`, so `filter(...).first()` is the first
  _matching_ element.
- **`clear`.** Routed through `fill("")` in every surface so the two cannot drift
  on which events they fire. CLI `clear`.
- MCP tools for each of the above: `clear`, `dialog`, `set_input_files`, `wheel`.

### Changed

- CLI results of the form `{ok: true, …}` no longer discard their sibling
  fields — `wheel` reports whether the page cancelled and `set-input-files` how
  many files landed. `disabled` and `bounding-box` print as prose rather than raw
  JSON.
- `drop` and `set-input-files` share one file encoder, so the two cannot diverge
  on size limits or MIME guessing.

### Known issues

- The native-keyboard tests depend on the fixture window holding OS focus. One
  failure was observed in roughly eight full-suite runs, immediately after a
  rebuild, and could not be reproduced in twelve subsequent runs. Unresolved.
- Only macOS is verified on real hardware; Linux and Windows rely on CI, where
  the Windows end-to-end job is currently allowed to fail.

## [0.1.2] and earlier

Released before this file existed. See the Git history and the GitHub Releases
page.
