## [0.4.1] — 2026-09-07

- Fix macOS teardown waiting when process-group existence probes return EPERM.
  Actual termination permission errors remain explicit. This release includes
  the changes from the blocked 0.4.0 release attempt.

- Known limitation: native keyboard rechecks still include unresolved failures.
  The review records implementation consensus, not a fully passing native suite.
  See `benchmarks/macos/REVIEW.md` in the repository for the verification record.

- Keep routine native keyboard checks short; move the 600-pair foreground
  switching stress suite to the explicit `test:e2e:stress` command.
- Bound endpoint cleanup retries after the application group is gone. Permanent
  filesystem errors terminate the supervisor with an explicit failure, and
  `stop()` propagates it instead of silently reporting successful cleanup.

- Reject macOS injection before dispatch when modifiers remain held. Report
  pre-dispatch failures as `injected: false`, and cancel queued work atomically
  so a timeout cannot be followed by a late injection.

- Reject duplicate modifier aliases before native injection. Enforce the macOS
  main-thread requirement at the Enigo boundary so accidental worker-thread
  calls fail explicitly before reaching HIToolbox.

- Keep terminating owned process groups when endpoint metadata becomes
  inaccessible during startup; report and retry endpoint cleanup separately.

- Preserve plugin error code, message, and data through the Rust client. MCP
  tool errors now expose `rpcError`; CLI `--json` prints the structured plugin
  error while retaining a nonzero exit status. Real native CLI/MCP tests verify
  successful key delivery and postcondition failures without losing injection
  status.

- **Breaking:** native `press` now waits for a trusted WebView keyup by default.
  Cross-window presses share one ordering lock through completion. Use
  `--completion native` (MCP `completion`, Playwright `PressOptions.completion`)
  for OS shortcuts or navigation; it explicitly confirms posting only.
  Optional `waitFor` postconditions retain keyboard ownership for at most ten
  seconds. Errors identify the phase and whether injection occurred.
- Confirm AppKit activation and native WebView focus instead of assuming a
  fixed delay succeeded. Keep keyboard-layout access on the main thread.
- Preserve real crash signals and log tails in fixture failure diagnostics,
  and keep screenshot failures from replacing the original test failure.
- Remove owned stale socket files after process-group cleanup, including worker
  death. Confirm ownership before readiness returns and preserve replaced files
  or accepting endpoints belonging to another application.
- Reject invalid window and timeout parameters. Isolate snapshot baselines by
  window, reject missing snapshot arrays, and clean cancelled eval requests.
- Reject missing, conflicting, or malformed internal eval callback results
  instead of fabricating a successful null or accepting non-JSON data.
- Keep negated assertions from passing when an RPC fails. Zero-timeout
  assertions still perform one read.

- Exclude exterior window shadows from macOS native captures so screenshot
  dimensions and scale metadata match the window, verified on a real display.

- Reap managed macOS applications after a Playwright worker is SIGKILLed using an
  independent IPC supervisor. Share normal and orphan group cleanup, bound IPC
  output buffering, and verify both real native teardown and resistant children.
- Make fixture turn heights actually unequal and assert their rendered dimensions.

- Fix Unix fixture cleanup when a launcher exits before its children, startup
  fails, or an application ignores SIGTERM. Wait for the process group to exit,
  support repeated launches and concurrent cleanup, and bound startup logs.
- Refuse to unlink live application endpoints and require a real connection
  for readiness. Add native multi-window Tauri teardown tests for both successful
  and failed Playwright runs, plus real process lifecycle regression tests.
- Generate Rust envelopes from one source and check generated files in CI and
  release validation. Share response vectors across Rust and TypeScript.
- Reject malformed RPC envelopes, preserving explicit null results and surfacing
  uncorrelated server errors. Missing results are now errors rather than silent
  success. Enforce the existing 1 MiB request limit before sending in all clients.
- Load the native E2E configuration explicitly so its single-worker setting,
  timeouts, and HTML reporting apply to the normal test command.
