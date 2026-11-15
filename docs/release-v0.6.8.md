# 0.6.8

CEF automation reaches real application commands and captures what the compositor shows.

- CEF `ipc` now runs through the page's own Tauri bridge in the top frame's main world, so it returns real command results, routes per window, and honors capabilities. Other automation stays in the isolated world.
- CEF `screenshot` asks the page only where the area is and takes the pixels through `Page.captureScreenshot`. Cross-origin images, embedded content and effects appear as they are on screen, for the document and for one element alike. Other runtimes keep redrawing the document in the page.
- A page holding an image it cannot read back, such as a cross-origin image without CORS, no longer fails the whole capture; that image is drawn empty.
- `download-cef` is updated to 3.0.1. Version 3.0.0 fails to build because the CEF index exceeds its response limit.

Validated locally on macOS on the secondary display: the CEF fixture's 12 native checks pass and the Wry fixture passes its 75 native tests, one of them (a CLI native key press) only on rerun. Wry behavior, the CLI and the Playwright client API are unchanged from 0.6.7.
