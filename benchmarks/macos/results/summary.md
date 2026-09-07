# Local macOS comparison

Measured 2026-09-07T07:08:48.272Z on Apple M4 Pro, Darwin 25.6.0 arm64, Node v26.8.1.

These are plugin-level measurements through one neutral persistent socket harness. They do not rank the full CLI, MCP, or official Playwright fixture experience. Three rounds rotate application order; each scenario has five warmups and thirty recorded samples per round. All applications use the same frontend and debug build profile, with exactly one real plugin enabled.

Latency includes request encoding, native plugin execution, response parsing and validation. Screenshots and keyboard probes run after latency samples and are not timed against each other. The six scenarios use 1, 3, 4, 4, 1 and 1 RPC calls respectively.

| Scenario         | Tool       | Success | p50 ms | p95 ms | Min ms | Max ms | Round p50 ms          |
| ---------------- | ---------- | ------- | ------ | ------ | ------ | ------ | --------------------- |
| round_trip       | hasgard    | 90/90   | 0.668  | 1.287  | 0.273  | 3.899  | 0.684 / 0.952 / 0.342 |
| round_trip       | pilot      | 90/90   | 0.544  | 0.928  | 0.307  | 1.942  | 0.512 / 0.677 / 0.379 |
| round_trip       | playwright | 90/90   | 0.460  | 1.097  | 0.318  | 1.163  | 0.477 / 0.689 / 0.372 |
| fill_click_read  | hasgard    | 90/90   | 1.675  | 7.504  | 0.924  | 12.302 | 1.378 / 3.080 / 1.165 |
| fill_click_read  | pilot      | 90/90   | 1.158  | 1.971  | 0.910  | 11.025 | 1.158 / 1.197 / 1.140 |
| fill_click_read  | playwright | 90/90   | 1.440  | 1.992  | 1.054  | 2.128  | 1.501 / 1.528 / 1.213 |
| html_dialog      | hasgard    | 90/90   | 2.680  | 9.439  | 1.588  | 26.521 | 2.260 / 5.285 / 1.916 |
| html_dialog      | pilot      | 90/90   | 1.907  | 4.178  | 1.552  | 6.316  | 1.760 / 1.788 / 2.280 |
| html_dialog      | playwright | 90/90   | 2.359  | 3.751  | 1.724  | 4.582  | 2.316 / 2.295 / 2.581 |
| window_isolation | hasgard    | 90/90   | 1.376  | 3.726  | 1.018  | 5.715  | 1.354 / 2.893 / 1.162 |
| window_isolation | pilot      | 90/90   | 1.320  | 1.805  | 1.144  | 2.423  | 1.277 / 1.270 / 1.428 |
| window_isolation | playwright | 90/90   | 1.564  | 1.891  | 1.268  | 2.674  | 1.650 / 1.616 / 1.368 |
| unequal_content  | hasgard    | 90/90   | 0.351  | 0.905  | 0.273  | 1.777  | 0.341 / 0.625 / 0.323 |
| unequal_content  | pilot      | 90/90   | 0.362  | 0.447  | 0.296  | 0.845  | 0.376 / 0.356 / 0.356 |
| unequal_content  | playwright | 90/90   | 0.453  | 0.579  | 0.358  | 11.709 | 0.468 / 0.482 / 0.401 |
| error_diagnostic | hasgard    | 90/90   | 0.331  | 0.951  | 0.257  | 1.528  | 0.327 / 0.701 / 0.286 |
| error_diagnostic | pilot      | 90/90   | 0.301  | 0.412  | 0.231  | 0.528  | 0.307 / 0.322 / 0.275 |
| error_diagnostic | playwright | 90/90   | 0.372  | 0.604  | 0.298  | 1.558  | 0.365 / 0.453 / 0.334 |

Percentiles use nearest rank on successful samples only. Failures remain in the raw JSON and success counts; three runs on one developer machine do not establish statistical or universal superiority.

## Capability observations

| Round | Tool       | Probe                           | Observation                                                                       |
| ----- | ---------- | ------------------------------- | --------------------------------------------------------------------------------- |
| 1     | hasgard    | screenshot                      | 883×7269; DOM rasterization in native webview; direct plugin capture              |
| 1     | hasgard    | screenshot_native               | 1800×1400; screencapture; plugin windows.list native_id; tcc_denied=false         |
| 1     | hasgard    | keyboard_Tab                    | events=[{"key":"Tab","trusted":true}], focus=save, value=""                       |
| 1     | hasgard    | keyboard_a                      | events=[{"key":"a","trusted":true}], focus=display-name, value="a"                |
| 1     | hasgard    | application_exit_before_cleanup | still running before harness cleanup                                              |
| 1     | pilot      | screenshot                      | 883×7269; DOM rasterization in native webview; direct plugin capture              |
| 1     | pilot      | screenshot_native               | native capture is smaller than the expected window                                |
| 1     | pilot      | keyboard_Tab                    | events=[{"key":"Tab","trusted":true}], focus=save, value=""                       |
| 1     | pilot      | keyboard_a                      | RPC connection closed                                                             |
| 1     | pilot      | application_exit_before_cleanup | exited before harness cleanup: signal=SIGTRAP, code=null                          |
| 1     | playwright | screenshot                      | 1800×1400; native window; direct plugin capture                                   |
| 1     | playwright | keyboard_Tab                    | events=[{"key":"Tab","trusted":false}], focus=display-name, value=""              |
| 1     | playwright | keyboard_a                      | events=[{"key":"a","trusted":false}], focus=display-name, value=""                |
| 1     | playwright | application_exit_before_cleanup | still running before harness cleanup                                              |
| 2     | pilot      | screenshot                      | 883×7269; DOM rasterization in native webview; direct plugin capture              |
| 2     | pilot      | screenshot_native               | 2024×1624; screencapture; external fixture native-window helper; tcc_denied=false |
| 2     | pilot      | keyboard_Tab                    | events=[{"key":"Tab","trusted":true}], focus=save, value=""                       |
| 2     | pilot      | keyboard_a                      | RPC connection closed                                                             |
| 2     | pilot      | application_exit_before_cleanup | exited before harness cleanup: signal=SIGTRAP, code=null                          |
| 2     | playwright | screenshot                      | 1800×1400; native window; direct plugin capture                                   |
| 2     | playwright | keyboard_Tab                    | events=[{"key":"Tab","trusted":false}], focus=display-name, value=""              |
| 2     | playwright | keyboard_a                      | events=[{"key":"a","trusted":false}], focus=display-name, value=""                |
| 2     | playwright | application_exit_before_cleanup | still running before harness cleanup                                              |
| 2     | hasgard    | screenshot                      | 883×7269; DOM rasterization in native webview; direct plugin capture              |
| 2     | hasgard    | screenshot_native               | 1800×1400; screencapture; plugin windows.list native_id; tcc_denied=false         |
| 2     | hasgard    | keyboard_Tab                    | events=[{"key":"Tab","trusted":true}], focus=save, value=""                       |
| 2     | hasgard    | keyboard_a                      | events=[{"key":"a","trusted":true}], focus=display-name, value="a"                |
| 2     | hasgard    | application_exit_before_cleanup | still running before harness cleanup                                              |
| 3     | playwright | screenshot                      | 1800×1400; native window; direct plugin capture                                   |
| 3     | playwright | keyboard_Tab                    | events=[{"key":"Tab","trusted":false}], focus=display-name, value=""              |
| 3     | playwright | keyboard_a                      | events=[{"key":"a","trusted":false}], focus=display-name, value=""                |
| 3     | playwright | application_exit_before_cleanup | still running before harness cleanup                                              |
| 3     | hasgard    | screenshot                      | 883×7269; DOM rasterization in native webview; direct plugin capture              |
| 3     | hasgard    | screenshot_native               | 1800×1400; screencapture; plugin windows.list native_id; tcc_denied=false         |
| 3     | hasgard    | keyboard_Tab                    | events=[{"key":"Tab","trusted":true}], focus=save, value=""                       |
| 3     | hasgard    | keyboard_a                      | events=[{"key":"a","trusted":true}], focus=display-name, value="a"                |
| 3     | hasgard    | application_exit_before_cleanup | still running before harness cleanup                                              |
| 3     | pilot      | screenshot                      | 883×7269; DOM rasterization in native webview; direct plugin capture              |
| 3     | pilot      | screenshot_native               | 2024×1624; screencapture; external fixture native-window helper; tcc_denied=false |
| 3     | pilot      | keyboard_Tab                    | events=[{"key":"Tab","trusted":true}], focus=save, value=""                       |
| 3     | pilot      | keyboard_a                      | RPC connection closed                                                             |
| 3     | pilot      | application_exit_before_cleanup | exited before harness cleanup: signal=SIGTRAP, code=null                          |

The HTML dialog scenario tests the native webview's HTML `<dialog>` element, not OS dialogs or JavaScript alert interception. Window isolation verifies two real webviews by label. Unequal content reads the rendered heights of 80 articles; it is not a virtualized scrolling benchmark.

Hasgard and pilot provide both DOM rasterization and native screenshot APIs. Native screenshot output travels as a file for these two and base64 for tauri-playwright, so capture latency is not compared. Pilot receives its native window ID from the fixture's explicit AppKit helper; Hasgard discovers it with its own windows.list. This helper does not change any competitor implementation.

## Revisions

- hasgard: `fde4cf77c184784f3b193544a1f08464648d2581`
- tauri-pilot: `ed31926726b4cd7b3ffbc11f188e046f2b5e0faa`
- tauri-playwright: `7e50bff1905ad8d5e6a52fb40e6439e0dbcbe6e6`

Hasgard was measured from a dirty working tree. Its tracked diff hash and status, the resolved Cargo.lock hash, and all three executable hashes are recorded in the raw JSON. The Vendor checkouts were clean and copied before building.

## Cleanup scope

9/9 application hosts were confirmed exited. This cleanup belongs to the neutral benchmark harness; it is not evidence for competitors' fixture cleanup. Hasgard's worker-death and signal-resistant descendant cleanup are tested separately in its real process tests and nested native Playwright runs.
