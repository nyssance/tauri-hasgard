# macOS comparison

[Measured results](results/summary.md) · [Raw observations](results/local.json) · [Review and validation](REVIEW.md)

This comparison uses the local `tauri-playwright` and `tauri-pilot` Vendor
checkouts, copied without modifying their sources. Each test executable embeds
the same fixture frontend and exactly one real plugin. No headless browser or
mocked Tauri runtime is involved.

```sh
bun benchmarks/macos/setup.mjs /path/to/ALwith/Vendor /private/tmp/hasgard-benchmark
node benchmarks/macos/run.mjs /private/tmp/hasgard-benchmark benchmarks/macos/results/local.json
node benchmarks/macos/report.mjs benchmarks/macos/results/local.json benchmarks/macos/results/summary.md
```

For additional latency replication without repeating native capability probes:

```sh
node benchmarks/macos/run.mjs /private/tmp/hasgard-benchmark benchmarks/macos/results/latency-12.json --rounds 12 --latency-only
node benchmarks/macos/report.mjs benchmarks/macos/results/latency-12.json benchmarks/macos/results/latency-12.md
```

Round counts must be positive multiples of three to preserve balanced launch
order. This separate output preserves the original capability failure evidence.

Run in a real macOS desktop session with native input and screen capture access.
Avoid concurrent tests, builds, or interaction with the test windows during
measurement. The script records successful capture metadata and API errors;
it does not grant permissions or hide denied captures. It uses fresh private
socket directories for every application launch. Screenshot calls have a 30-second deadline; other calls have five seconds.
PNG files remain under the
work directory's `captures` directory.

The latency layer uses the same sequential, persistent Unix socket harness for
all three plugins. This intentionally excludes CLI process startup, MCP framing,
locator resolution in official clients, default recording and fixture overhead.
It measures common low-level operations, not the complete developer experience.
The fixture brings each application to the foreground and allows one second
for compositor animations before measuring. Native captures must be at least
the expected window pixel width, so a Stage Manager thumbnail cannot pass.
There are three rotated rounds, five warmups and thirty samples per scenario per
round. A timed-out connection is discarded, so late responses cannot corrupt the
following measurements. Incomplete measurements make report generation fail.

Keyboard probes record trusted events, focus movement and inserted text.
Pilot's character-key probe is now skipped explicitly: the recorded runs
repeatedly terminated with SIGTRAP when Enigo queried the keyboard layout from
a Tokio worker (`TSMGetInputSourceProperty` → `dispatch_assert_queue`). The
existing raw failure observations are retained. New runs label this probe
SKIPPED, never successful, and do not repeat the known crash or its macOS crash
report dialogs. Pilot's Tab probe and the other tools' keyboard probes remain.
Synthetic events are described as different semantics, not counted as native
input failures. An application exit is recorded before the harness sends its
own cleanup signal. Screenshot probes cover native capture for all three tools,
and DOM capture where provided; they are not compared for latency because the
capture and delivery contracts differ. Pilot's required native window ID comes
from a fixture-owned AppKit helper; Hasgard discovers it through `windows.list`.

The results apply to the recorded checkouts and machine. They do not justify a
worldwide ranking. An earlier Hasgard regression run had one isolated Tab-focus
failure whose exact cause was not established. Subsequent work reproduced a
separate cross-window text-delivery race and added native focus plus trusted
WebView completion. The 67-test native suite passed, including 600 concurrent
window pairs with plain and shifted keys. Two additional CLI/MCP native tests
verify the same press contract through the public tools. Later stress rechecks failed; see the current [review status](REVIEW.md) for
the timeout and unexpected trusted Control-event evidence. These results do not
claim immunity to concurrent physical input or desktop interference.

Separately, Hasgard's lifecycle tests verify normal teardown, assertion failure,
worker SIGKILL, supervisor SIGTERM and descendants that ignore SIGTERM. The
supervisor cannot recover from its own SIGKILL or reclaim children that escape
the managed process group.

An earlier screenshot probe captured a Stage Manager thumbnail before the
foreground precondition was added. It also exposed shadow pixels inflating
Hasgard's reported scale from 2 to 2.25. Hasgard now captures without exterior
shadows; the native regression suite checks its screencapture scale against the
webview's device pixel ratio. Competitor implementations remain unchanged.

Pilot retains its upstream shadow-inclusive native capture. Its PNG dimensions
and reported scale therefore differ from Hasgard's shadow-free captures; the
raw values are preserved without normalizing or ranking these image sizes.

## Interactive desktop test duration

The default native multi-window keyboard cases use three pairs each. They still
exercise independent socket connections and Shift combinations, but avoid
hundreds of foreground switches during routine local checks. Run
`bun run test:e2e:stress` explicitly for the 600-pair extended keyboard suite.
Reserve an idle desktop for that run: typing, screenshot shortcuts, or switching
windows changes the same native input stream under test. Long stress runs are
not silently retried or treated as passed when interrupted.
