# JSON-RPC protocol

Hasgard uses JSON-RPC 2.0 over a platform-native byte stream. Every request and response is one UTF-8 JSON object followed by `\n`.

```json
{"jsonrpc":"2.0","id":1,"method":"snapshot","params":{"window":"main","interactive":true}}
{"jsonrpc":"2.0","id":1,"result":{"elements":[]}}
```

Response IDs are authoritative: clients must support multiple in-flight requests and may not assume response order.

## Transport

- macOS/Linux: private Unix socket. A managed test supplies `TAURI_HASGARD_SOCKET`; otherwise the plugin derives a path from the Tauri application identifier.
- Windows: named pipe. A managed test supplies the full named-pipe path through the same environment variable.

## Window routing

`params.window` is a Tauri webview label. Public Playwright APIs always send it. Low-level CLI calls without one target `main`; a missing `main` is an error.

## Snapshot

Snapshot elements contain:

```ts
interface SnapshotElement {
  ref: string
  role: string
  depth: number
  name?: string
  value?: string
  checked?: boolean
  disabled?: boolean
}
```

Refs are valid until the next snapshot in that webview. The Playwright client therefore holds a per-window lock across `snapshot → unique match → action`; this sequence may not interleave with another semantic action in the same window.
