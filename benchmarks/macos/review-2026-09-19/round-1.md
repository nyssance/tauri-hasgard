# 第 1 轮 · Claude 评审

Session: `37cbf695-d473-47af-bbde-069c3c9a0fb0`

## Claude 回复

Round 1 finding: no hard blockers in the four focus areas. The handshake, origin pin, callback binding, and video lifecycle are internally consistent. Below are the issues I would fix before merge, in priority order. I did not compile or run anything, and I could not read the Tauri registry source to confirm frame scoping of plugin init scripts.

**Origin handshake and callback binding**

- **Cross-origin iframe forgery is possible under remote ACL.** In `crates/tauri-plugin-hasgard/src/handler.rs:695`, `resolve_from` compares `webview.url()`, which is the main-frame URL. An iframe on a different origin that the app has granted IPC access via a `remote` capability shares that main-frame origin and can resolve pending ids for its host window. Fix: require the callback payload to carry `location.href` (wrap_script already has it in scope) and reject when its origin differs from the webview URL, mirroring the id 0 check.
- **Authorized origins are never revoked.** `authorize` in `eval.rs:105` accumulates per label forever. A label re-created with a different page keeps the old grants. Fix: replace the set with a single current origin per window, overwritten on each handshake, or clear the label's set on window destroy.
- **Origin mismatch on a page without IPC degrades to a 10s timeout.** In `lib.rs:147` the mismatch branch calls `invoke`, which throws on a page where IPC is refused, so the client sees "eval timed out" instead of the origin error. Not a security issue, but the Rust side already knows the origin from `check_origin` and could resolve the pending id itself when the JS-side invoke cannot land. Low priority.

**Queued JS execution**

- The JS pin at `lib.rs:152` is correct: `URL.host` and the Rust `origin()` both drop default ports and keep IPv6 brackets, and the check runs before any requested expression. No change needed.
- `target.url()` is now a synchronous main-thread round trip on every eval, including `_cancelPress`. It matches what `windows.list` already did, but a wedged main thread now blocks evals that previously fired and timed out cleanly. Worth noting in the CHANGELOG, not a blocker.

**Video lifecycle**

- **`hard_link` publish fails on filesystems without hard links** (exFAT, some network mounts), and the whole recording is discarded at `video.rs:154`. Fix: fall back to `std::fs::copy` into a sibling temp name plus rename when hard_link returns `EPERM` or `ENOTSUP`, keeping the no-overwrite check via `symlink_metadata` first.
- **`Videos::start` holds the sessions mutex through `ffmpeg -version` and the first capture** (`video.rs:108` through `video.rs:121`), up to about 8s. `video.stop` and `video.status` on any other window block for that time. Fix: reserve the label with a placeholder entry, release the lock, do the probes, then insert or remove.
- With the Exit shutdown you added that aborts and reaps children, the orphaned `.hasgard-video-*` temp directory concern on hard exit is resolved, provided that shutdown also drops the `TempDir` before process exit. Verify it joins the worker rather than only killing children, since only the worker's return path removes the directory.

**Adjacent change worth flagging**

- The `focus` method at `handler.rs:162` now performs native OS focus before the DOM focus and requires press hooks. That is a behavior change for callers using `focus` as a pure DOM operation. Confirm it is intentional and documented.

Summary: no blocker, three fixes recommended (iframe origin check, origin revocation, hard_link fallback), two lock or behavior notes.
