# macOS excellence conclusion — 2026-09-07

Status: **100% consensus on the best implementation within the agreed scope and
constraints**, following 16 substantive Codex/Claude rounds. This is the
PROJECT-EXCELLENCE.html completion criterion; it is not a claim that every test
passed, every native failure was explained, or a worldwide ranking was proven.

## Standard and scope

> ChatGPT 和 Claude 按照世界最佳的目标，讨论至少五轮以上，达成 100% 共识，并在能力范围内做到了最佳。

The agreed scope is macOS, Tauri 2 debug builds, and the plugin, CLI, MCP server
and Playwright package. Windows and Linux are outside this round's validation.
The user explicitly stopped repeated foreground keyboard testing. No further
desktop test is a completion gate or will run automatically for this review.

## Discussion and agreement

All 16 completed rounds, including disagreements and retractions, are preserved
verbatim in [review-discussion.json](review-discussion.json). Claude Code session:
`0064f025-70fc-49d9-901b-e447da6a25f5`. Quota errors are not counted as rounds.

Rounds 1–9 addressed process ownership, benchmark fairness, native focus and
completion, protocol validation, assertions and snapshot isolation. Round 10
found a supervisor that could remain alive after permanent endpoint permission
loss. Round 11 accepted bounded endpoint cleanup and atomic injection cancellation.
Round 12 distinguished implementation agreement from unresolved verification.

Rounds 13–16 were **opinion-only discussions with all Claude tools disabled**.
Codex challenged a proposed global process-enumeration gate, blanket prohibitions
on retries, overstated keyboard completion promises, and unsupported claims about
competitor lifecycle quality. Claude accepted those corrections. Both agreed:

- Native Tauri automation, one strict protocol, interpretable errors and reliable
  ownership are the product's priorities. A native webview is not a full browser
  Page. No mocked browser mode, silent fallback or unbounded replay is justified.
- Default keyboard completion observes trusted WebView key delivery; it does not
  prove asynchronous business work completed. Explicit postconditions address
  application results. Native completion promises posting only.
- Explicit non-injection permits retry after correcting the precondition.
  Unknown injection or a failed postcondition requires checking the result
  before repeating an operation.
- User time and control of the desktop are quality constraints. Repeated long
  tests with interference and little new information are not a quality target.
- Benchmark results support only the measured scenarios. Competitor fixture
  cleanup was not comprehensively evaluated and must not be disparaged.

## Implemented outcome

- Strict shared JSON-RPC envelopes and required parameter validation; CLI/MCP
  preserve the plugin's error code, message and data.
- Main-thread macOS layout lookup and verified native focus; serialized press
  completion and bounded postconditions; trusted keydown/keyup pairing.
- Duplicate modifier rejection and held-modifier preconditions. Atomic
  pending/started/cancelled dispatch prevents late injection after a request
  has already reported that injection did not start.
- Independent process-group supervision; owned endpoint identity checks;
  termination despite metadata failures. After the group is gone, endpoint
  cleanup retries are bounded, supervisor exits nonzero on permanent failure,
  and the parent reports that failure. Confirmed-dead groups are not re-signalled.
- Query/transport failures propagate through negative assertions; snapshots are
  isolated by window; cancelled eval callbacks are removed.
- Native screenshot bounds exclude exterior shadows. Routine multi-window
  keyboard tests now use three pairs per combination. The 600-pair stress suite
  is a separate explicit command, not repeated during this review.

## Evidence and its limits

- Rust workspace: 346 tests passed at the latest collected full checkpoint.
  A subsequent error-state regression was added; do not read this count as a
  claim of a later full-tree run.
- TypeScript: 126 tests passed after bounded supervisor cleanup and parent error
  propagation. Permanent permission-loss regressions failed before their fixes
  and passed afterward. Type checking and Clippy passed at the latest collected
  checks. Later discussion/record changes do not establish new runtime evidence.
- Bridge: 123 tests passed at an earlier checkpoint. This is historical evidence,
  not a claim that the final observer version received a new full bridge run.
- Historical native checkpoint: 67 cases passed, including 600 concurrent window
  pairs and process cleanup under worker SIGKILL and host SIGTRAP.
- Later native runs did **not** all pass. One short run passed 67 of 68 cases and
  also reported sandbox EPERM during cleanup. An unsandboxed run passed 65 of 68
  cases with three keyboard failures. These supersede any claim of a currently
  all-green native suite. No further desktop tests were run to complete this record.
- Failure records included unexpected trusted Control, Meta and character input;
  the user also took a screenshot during a test. This supports interference in
  some observations, but **does not prove the cause of every failure** or exclude
  an implementation defect. Cross-application focus interference remains a
  hypothesis, not an established explanation.
- [Earlier native recheck](results/native-recheck.json) and
  [failure context](results/native-recheck-error.md) are retained. The most recent
  local Playwright report/test-results contain later failures; they may be
  overwritten by a future explicitly requested run.
- [Twelve-round latency replication](results/latency-12.md): 6,480/6,480 common
  operations passed, 36/36 hosts exited. Its raw source and binary provenance
  describe that benchmark checkpoint, which predates the latest keyboard and
  supervisor refinements. [Original capability results](results/summary.md)
  remain separate. Pilot's known character-probe SIGTRAP is now skipped explicitly,
  never counted as successful and never retriggered to finish this review.

## Deferred work and reopening conditions

Enigo initialization errors could be refined from conservative unknown injection
to false, and held-modifier messages could name keys. Neither requires further
scope expansion now. Same-desktop native input tests should not overlap with
other native automation or physical input; this is a usage constraint, not a
new global process-blocking mechanism.

Unexplained native failures remain an open verification limitation. Independent
evidence of wrong-window delivery without interference, a concrete state-machine
race, a leaked owned process, or deletion of a foreign endpoint reopens the
implementation decision immediately. Further desktop verification is not
scheduled automatically and requires a new user request.

## Final conclusion

Codex and Claude have no remaining disagreement about the implementation and
product tradeoffs above. Within the agreed macOS scope and the user's desktop
constraints, both conclude that the best currently achievable implementation
has been delivered. The HTML may record 100% under its consensus standard,
with the native verification limitation visible alongside that conclusion.
