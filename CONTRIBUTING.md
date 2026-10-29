# Contributing

Keep the plugin, CLI, MCP server, and Playwright fixture on one JSON-RPC contract. Missing applications, windows, selectors, transports, or capabilities must fail explicitly. Read [AGENTS.md](AGENTS.md) before making changes.

## Run the example

Use Rust 1.95+, Node.js 24+, Bun, and the native Tauri build dependencies for your OS. macOS requires Apple Silicon. Use Bun Canary for `bun lint`.

From the repository root:

```sh
bun install --frozen-lockfile
bun run build
bun run test:e2e
```

This builds the CLI and debug fixture app, launches real native windows, and runs Playwright. Linux needs a display; CI uses `xvfb-run --auto-servernum bun run test:e2e`. macOS video tests also require ffmpeg and the appropriate capture permission.

The [fixture setup](examples/fixture-app/e2e/fixtures.ts) launches a prebuilt executable with a unique endpoint. [Native tests](examples/fixture-app/e2e/tests) cover multi-window isolation, unequal content heights, dialogs, keyboard input, screenshots, and process cleanup.

## Check changes

Run the checks relevant to your change; CI runs the full set:

```sh
bun run protocol:check
bun run format:check
bun run typecheck
bun lint --max-warnings=0
bun run ts7-lint
bun run test
bun test crates/tauri-plugin-hasgard/js/*.test.mjs
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-features --locked
```

For protocol changes, update the shared definitions and run `bun run protocol:sync`, then check all public clients. Native behavior changes require the real E2E suite; bridge and transport unit tests alone are insufficient. Use `bun run test:e2e:stress` for native focus and keyboard changes.

Formatting uses `bun fmt` and `cargo fmt`; type checking uses `bun check`. TypeScript emits package declarations during `bun run build`.

## Dependencies and releases

`fab u` (alias `fab upgrade`) upgrades Bun workspaces and Rust dependencies, including major versions, and refreshes both lockfiles. It requires Fabric (`uv tool install fabric`) and cargo-edit (`cargo install cargo-edit`). Review the resulting changes before committing.

Follow [the release checklist](docs/releasing.md) for publishing. Preserve upstream notices in [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
