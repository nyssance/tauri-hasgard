# Local macOS comparison

Measured 2026-09-07T07:26:00.150Z on Apple M4 Pro, Darwin 25.6.0 arm64, Node v26.8.1.

These are plugin-level measurements through one neutral persistent socket harness. They do not rank the full CLI, MCP, or official Playwright fixture experience. 12 rounds rotate application order; each scenario has 5 warmups and 30 recorded samples per round. All applications use the same frontend and debug build profile, with exactly one real plugin enabled.

Latency includes request encoding, native plugin execution, response parsing and validation. This replication skips screenshot and keyboard capability probes. The six scenarios use 1, 3, 4, 4, 1 and 1 RPC calls respectively.

| Scenario         | Tool       | Success | p50 ms | p95 ms | Min ms | Max ms | Round p50 ms                                                                                  |
| ---------------- | ---------- | ------- | ------ | ------ | ------ | ------ | --------------------------------------------------------------------------------------------- |
| round_trip       | hasgard    | 360/360 | 0.544  | 1.118  | 0.300  | 1.762  | 0.466 / 0.593 / 0.556 / 0.449 / 0.503 / 0.601 / 0.577 / 0.615 / 0.618 / 0.593 / 0.427 / 0.387 |
| round_trip       | pilot      | 360/360 | 0.585  | 1.096  | 0.372  | 1.870  | 0.514 / 0.628 / 0.652 / 0.593 / 0.530 / 0.631 / 0.638 / 0.505 / 0.552 / 0.558 / 0.577 / 0.619 |
| round_trip       | playwright | 360/360 | 0.655  | 1.064  | 0.362  | 1.572  | 0.730 / 0.722 / 0.716 / 0.526 / 0.578 / 0.684 / 0.671 / 0.618 / 0.505 / 0.655 / 0.707 / 0.688 |
| fill_click_read  | hasgard    | 360/360 | 1.187  | 1.991  | 0.858  | 6.870  | 1.057 / 1.093 / 1.111 / 1.376 / 1.163 / 1.257 / 1.106 / 1.208 / 1.177 / 1.277 / 1.084 / 1.183 |
| fill_click_read  | pilot      | 360/360 | 1.144  | 1.966  | 0.881  | 7.003  | 1.179 / 1.237 / 1.076 / 1.199 / 1.157 / 1.177 / 1.085 / 1.181 / 1.047 / 1.085 / 1.216 / 1.125 |
| fill_click_read  | playwright | 360/360 | 1.447  | 2.178  | 1.175  | 3.101  | 1.560 / 1.482 / 1.402 / 1.463 / 1.413 / 1.399 / 1.503 / 1.355 / 1.422 / 1.417 / 1.491 / 1.355 |
| html_dialog      | hasgard    | 360/360 | 1.921  | 3.010  | 1.501  | 4.588  | 1.877 / 1.715 / 1.927 / 2.053 / 1.972 / 1.953 / 1.756 / 1.965 / 1.813 / 2.037 / 1.920 / 1.869 |
| html_dialog      | pilot      | 360/360 | 1.819  | 3.009  | 1.467  | 4.131  | 1.866 / 2.000 / 1.783 / 1.870 / 1.710 / 1.865 / 1.787 / 1.761 / 1.738 / 1.732 / 1.922 / 1.720 |
| html_dialog      | playwright | 360/360 | 2.508  | 4.138  | 1.882  | 7.481  | 2.843 / 2.241 / 2.862 / 2.785 / 2.391 / 2.298 / 2.404 / 2.204 / 2.264 / 2.603 / 2.641 / 2.626 |
| window_isolation | hasgard    | 360/360 | 1.240  | 1.595  | 1.062  | 2.296  | 1.285 / 1.160 / 1.240 / 1.335 / 1.242 / 1.211 / 1.174 / 1.269 / 1.257 / 1.238 / 1.235 / 1.229 |
| window_isolation | pilot      | 360/360 | 1.250  | 1.549  | 1.064  | 2.433  | 1.258 / 1.262 / 1.298 / 1.343 / 1.235 / 1.205 / 1.161 / 1.177 / 1.202 / 1.250 / 1.277 / 1.201 |
| window_isolation | playwright | 360/360 | 1.577  | 1.877  | 1.226  | 2.617  | 1.576 / 1.482 / 1.558 / 1.592 / 1.575 / 1.563 / 1.596 / 1.562 / 1.593 / 1.576 / 1.572 / 1.614 |
| unequal_content  | hasgard    | 360/360 | 0.337  | 0.460  | 0.286  | 0.811  | 0.367 / 0.334 / 0.317 / 0.356 / 0.326 / 0.325 / 0.318 / 0.382 / 0.336 / 0.328 / 0.346 / 0.335 |
| unequal_content  | pilot      | 360/360 | 0.338  | 0.481  | 0.277  | 0.757  | 0.347 / 0.365 / 0.331 / 0.368 / 0.328 / 0.354 / 0.325 / 0.309 / 0.335 / 0.331 / 0.323 / 0.327 |
| unequal_content  | playwright | 360/360 | 0.465  | 0.545  | 0.378  | 0.784  | 0.492 / 0.465 / 0.469 / 0.508 / 0.456 / 0.433 / 0.460 / 0.444 / 0.451 / 0.465 / 0.457 / 0.448 |
| error_diagnostic | hasgard    | 360/360 | 0.302  | 0.403  | 0.254  | 0.715  | 0.306 / 0.298 / 0.284 / 0.327 / 0.314 / 0.300 / 0.307 / 0.300 / 0.290 / 0.289 / 0.300 / 0.306 |
| error_diagnostic | pilot      | 360/360 | 0.301  | 0.460  | 0.241  | 1.060  | 0.301 / 0.297 / 0.297 / 0.309 / 0.300 / 0.291 / 0.281 / 0.311 / 0.284 / 0.299 / 0.316 / 0.319 |
| error_diagnostic | playwright | 360/360 | 0.388  | 0.583  | 0.336  | 10.913 | 0.383 / 0.373 / 0.378 / 0.434 / 0.499 / 0.374 / 0.427 / 0.366 / 0.375 / 0.397 / 0.379 / 0.373 |

Percentiles use nearest rank on successful samples only. Failures remain in the raw JSON and success counts; repeated runs on one developer machine do not establish statistical or universal superiority.

## Capability observations

| Round | Tool       | Probe                           | Observation                          |
| ----- | ---------- | ------------------------------- | ------------------------------------ |
| 1     | hasgard    | capability_probes               | SKIPPED: latency-only replication    |
| 1     | hasgard    | application_exit_before_cleanup | still running before harness cleanup |
| 1     | pilot      | capability_probes               | SKIPPED: latency-only replication    |
| 1     | pilot      | application_exit_before_cleanup | still running before harness cleanup |
| 1     | playwright | capability_probes               | SKIPPED: latency-only replication    |
| 1     | playwright | application_exit_before_cleanup | still running before harness cleanup |
| 2     | pilot      | capability_probes               | SKIPPED: latency-only replication    |
| 2     | pilot      | application_exit_before_cleanup | still running before harness cleanup |
| 2     | playwright | capability_probes               | SKIPPED: latency-only replication    |
| 2     | playwright | application_exit_before_cleanup | still running before harness cleanup |
| 2     | hasgard    | capability_probes               | SKIPPED: latency-only replication    |
| 2     | hasgard    | application_exit_before_cleanup | still running before harness cleanup |
| 3     | playwright | capability_probes               | SKIPPED: latency-only replication    |
| 3     | playwright | application_exit_before_cleanup | still running before harness cleanup |
| 3     | hasgard    | capability_probes               | SKIPPED: latency-only replication    |
| 3     | hasgard    | application_exit_before_cleanup | still running before harness cleanup |
| 3     | pilot      | capability_probes               | SKIPPED: latency-only replication    |
| 3     | pilot      | application_exit_before_cleanup | still running before harness cleanup |
| 4     | hasgard    | capability_probes               | SKIPPED: latency-only replication    |
| 4     | hasgard    | application_exit_before_cleanup | still running before harness cleanup |
| 4     | pilot      | capability_probes               | SKIPPED: latency-only replication    |
| 4     | pilot      | application_exit_before_cleanup | still running before harness cleanup |
| 4     | playwright | capability_probes               | SKIPPED: latency-only replication    |
| 4     | playwright | application_exit_before_cleanup | still running before harness cleanup |
| 5     | pilot      | capability_probes               | SKIPPED: latency-only replication    |
| 5     | pilot      | application_exit_before_cleanup | still running before harness cleanup |
| 5     | playwright | capability_probes               | SKIPPED: latency-only replication    |
| 5     | playwright | application_exit_before_cleanup | still running before harness cleanup |
| 5     | hasgard    | capability_probes               | SKIPPED: latency-only replication    |
| 5     | hasgard    | application_exit_before_cleanup | still running before harness cleanup |
| 6     | playwright | capability_probes               | SKIPPED: latency-only replication    |
| 6     | playwright | application_exit_before_cleanup | still running before harness cleanup |
| 6     | hasgard    | capability_probes               | SKIPPED: latency-only replication    |
| 6     | hasgard    | application_exit_before_cleanup | still running before harness cleanup |
| 6     | pilot      | capability_probes               | SKIPPED: latency-only replication    |
| 6     | pilot      | application_exit_before_cleanup | still running before harness cleanup |
| 7     | hasgard    | capability_probes               | SKIPPED: latency-only replication    |
| 7     | hasgard    | application_exit_before_cleanup | still running before harness cleanup |
| 7     | pilot      | capability_probes               | SKIPPED: latency-only replication    |
| 7     | pilot      | application_exit_before_cleanup | still running before harness cleanup |
| 7     | playwright | capability_probes               | SKIPPED: latency-only replication    |
| 7     | playwright | application_exit_before_cleanup | still running before harness cleanup |
| 8     | pilot      | capability_probes               | SKIPPED: latency-only replication    |
| 8     | pilot      | application_exit_before_cleanup | still running before harness cleanup |
| 8     | playwright | capability_probes               | SKIPPED: latency-only replication    |
| 8     | playwright | application_exit_before_cleanup | still running before harness cleanup |
| 8     | hasgard    | capability_probes               | SKIPPED: latency-only replication    |
| 8     | hasgard    | application_exit_before_cleanup | still running before harness cleanup |
| 9     | playwright | capability_probes               | SKIPPED: latency-only replication    |
| 9     | playwright | application_exit_before_cleanup | still running before harness cleanup |
| 9     | hasgard    | capability_probes               | SKIPPED: latency-only replication    |
| 9     | hasgard    | application_exit_before_cleanup | still running before harness cleanup |
| 9     | pilot      | capability_probes               | SKIPPED: latency-only replication    |
| 9     | pilot      | application_exit_before_cleanup | still running before harness cleanup |
| 10    | hasgard    | capability_probes               | SKIPPED: latency-only replication    |
| 10    | hasgard    | application_exit_before_cleanup | still running before harness cleanup |
| 10    | pilot      | capability_probes               | SKIPPED: latency-only replication    |
| 10    | pilot      | application_exit_before_cleanup | still running before harness cleanup |
| 10    | playwright | capability_probes               | SKIPPED: latency-only replication    |
| 10    | playwright | application_exit_before_cleanup | still running before harness cleanup |
| 11    | pilot      | capability_probes               | SKIPPED: latency-only replication    |
| 11    | pilot      | application_exit_before_cleanup | still running before harness cleanup |
| 11    | playwright | capability_probes               | SKIPPED: latency-only replication    |
| 11    | playwright | application_exit_before_cleanup | still running before harness cleanup |
| 11    | hasgard    | capability_probes               | SKIPPED: latency-only replication    |
| 11    | hasgard    | application_exit_before_cleanup | still running before harness cleanup |
| 12    | playwright | capability_probes               | SKIPPED: latency-only replication    |
| 12    | playwright | application_exit_before_cleanup | still running before harness cleanup |
| 12    | hasgard    | capability_probes               | SKIPPED: latency-only replication    |
| 12    | hasgard    | application_exit_before_cleanup | still running before harness cleanup |
| 12    | pilot      | capability_probes               | SKIPPED: latency-only replication    |
| 12    | pilot      | application_exit_before_cleanup | still running before harness cleanup |

The HTML dialog scenario tests the native webview's HTML `<dialog>` element, not OS dialogs or JavaScript alert interception. Window isolation verifies two real webviews by label. Unequal content reads the rendered heights of 80 articles; it is not a virtualized scrolling benchmark.

Hasgard and pilot provide both DOM rasterization and native screenshot APIs. Native screenshot output travels as a file for these two and base64 for tauri-playwright, so capture latency is not compared. Pilot receives its native window ID from the fixture's explicit AppKit helper; Hasgard discovers it with its own windows.list. This helper does not change any competitor implementation.

## Revisions

- hasgard: `fde4cf77c184784f3b193544a1f08464648d2581`
- tauri-pilot: `ed31926726b4cd7b3ffbc11f188e046f2b5e0faa`
- tauri-playwright: `7e50bff1905ad8d5e6a52fb40e6439e0dbcbe6e6`

Hasgard was measured from a dirty working tree. Its tracked diff hash and status, the resolved Cargo.lock hash, and all three executable hashes are recorded in the raw JSON. The Vendor checkouts were clean and copied before building.

## Cleanup scope

36/36 application hosts were confirmed exited. This cleanup belongs to the neutral benchmark harness; it is not evidence for competitors' fixture cleanup. Hasgard's worker-death and signal-resistant descendant cleanup are tested separately in its real process tests and nested native Playwright runs.
