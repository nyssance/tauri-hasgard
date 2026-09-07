import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"

const [input, output] = process.argv.slice(2)
if (!input || !output) throw new Error("Usage: node benchmarks/macos/report.mjs INPUT_JSON OUTPUT_MARKDOWN")
const result = JSON.parse(await readFile(input, "utf8"))
const names = ["hasgard", "pilot", "playwright"]
const scenarios = [
  "round_trip",
  "fill_click_read",
  "html_dialog",
  "window_isolation",
  "unequal_content",
  "error_diagnostic"
]
const percentile = (values, p) => values[Math.ceil(values.length * p) - 1]
const lines = [
  "# Local macOS comparison",
  "",
  `Measured ${result.date} on ${result.environment.cpu}, ${result.environment.os} ${result.environment.release} ${result.environment.arch}, Node ${result.environment.runtime}.`,
  "",
  `These are plugin-level measurements through one neutral persistent socket harness. They do not rank the full CLI, MCP, or official Playwright fixture experience. ${result.method.rounds} rounds rotate application order; each scenario has ${result.method.warmups} warmups and ${result.method.samplesPerRound} recorded samples per round. All applications use the same frontend and debug build profile, with exactly one real plugin enabled.`,
  "",
  `Latency includes request encoding, native plugin execution, response parsing and validation. ${result.method.latencyOnly ? "This replication skips screenshot and keyboard capability probes." : "Screenshots and keyboard probes run after latency samples and are not timed against each other."} The six scenarios use 1, 3, 4, 4, 1 and 1 RPC calls respectively.`,
  "",
  "| Scenario | Tool | Success | p50 ms | p95 ms | Min ms | Max ms | Round p50 ms |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |"
]
for (const scenario of scenarios) {
  for (const tool of names) {
    const samples = result.samples.filter(sample => sample.scenario === scenario && sample.tool === tool)
    assert.equal(samples.length, result.method.rounds * result.method.samplesPerRound, `incomplete ${tool}/${scenario}`)
    const successful = samples.filter(sample => sample.ok)
    const values = successful.map(sample => sample.ms).sort((a, b) => a - b)
    const medians = Array.from({ length: result.method.rounds }, (_, round) => {
      const roundSamples = samples.filter(sample => sample.round === round)
      assert.equal(roundSamples.length, result.method.samplesPerRound, `incomplete round ${round}: ${tool}/${scenario}`)
      const timings = roundSamples
        .filter(sample => sample.ok)
        .map(sample => sample.ms)
        .sort((a, b) => a - b)
      return timings.length ? percentile(timings, 0.5).toFixed(3) : "—"
    })
    const stats = values.length
      ? [percentile(values, 0.5), percentile(values, 0.95), values[0], values.at(-1)].map(value => value.toFixed(3))
      : ["—", "—", "—", "—"]
    lines.push(
      `| ${scenario} | ${tool} | ${successful.length}/${samples.length} | ${stats.join(" | ")} | ${medians.join(" / ")} |`
    )
  }
}
lines.push(
  "",
  "Percentiles use nearest rank on successful samples only. Failures remain in the raw JSON and success counts; repeated runs on one developer machine do not establish statistical or universal superiority.",
  "",
  "## Capability observations",
  "",
  "| Round | Tool | Probe | Observation |",
  "| --- | --- | --- | --- |"
)
for (const probe of result.capabilities) {
  let observation
  if (probe.skipped) observation = `SKIPPED: ${probe.skipped}`
  else if (probe.error) observation = probe.error
  else if (probe.probe.startsWith("keyboard_"))
    observation = `events=${JSON.stringify(probe.events)}, focus=${probe.focusedElement}, value=${JSON.stringify(probe.inputValue)}`
  else if (probe.probe.startsWith("screenshot"))
    observation = `${probe.width}×${probe.height}; ${probe.capture ?? probe.backend}; ${probe.discovery ?? "direct plugin capture"}${probe.tcc_denied === undefined ? "" : `; tcc_denied=${probe.tcc_denied}`}`
  else if (probe.probe === "application_exit_before_cleanup")
    observation =
      probe.signal !== null || probe.code !== null
        ? `exited before harness cleanup: signal=${probe.signal}, code=${probe.code}`
        : "still running before harness cleanup"
  else observation = JSON.stringify(probe)
  lines.push(
    `| ${probe.round + 1} | ${probe.tool} | ${probe.probe} | ${observation.replaceAll("|", "\\|").replaceAll("\n", " ")} |`
  )
}
lines.push(
  "",
  "The HTML dialog scenario tests the native webview's HTML `<dialog>` element, not OS dialogs or JavaScript alert interception. Window isolation verifies two real webviews by label. Unequal content reads the rendered heights of 80 articles; it is not a virtualized scrolling benchmark.",
  "",
  "Hasgard and pilot provide both DOM rasterization and native screenshot APIs. Native screenshot output travels as a file for these two and base64 for tauri-playwright, so capture latency is not compared. Pilot receives its native window ID from the fixture's explicit AppKit helper; Hasgard discovers it with its own windows.list. This helper does not change any competitor implementation.",
  "",
  "## Revisions",
  ""
)
for (const tool of ["hasgard", "tauri-pilot", "tauri-playwright"])
  lines.push(`- ${tool}: \`${result.revisions[tool]}\``)
lines.push(
  "",
  `Hasgard was measured from a ${result.revisions.hasgardStatus.trim() ? "dirty" : "clean"} working tree. Its tracked diff hash and status, the resolved Cargo.lock hash, and all three executable hashes are recorded in the raw JSON. The Vendor checkouts were clean and copied before building.`,
  "",
  "## Cleanup scope",
  "",
  `${result.cleanup.filter(item => item.applicationExited).length}/${result.cleanup.length} application hosts were confirmed exited. This cleanup belongs to the neutral benchmark harness; it is not evidence for competitors' fixture cleanup. Hasgard's worker-death and signal-resistant descendant cleanup are tested separately in its real process tests and nested native Playwright runs.`,
  ""
)
await writeFile(output, lines.join("\n"))
