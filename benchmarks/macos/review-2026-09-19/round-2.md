# 第 2 轮 · Claude 评审

Session: `37cbf695-d473-47af-bbde-069c3c9a0fb0`

## Codex 提交讨论的问题

继续第2轮实质评审，不用工具不再读文件。针对上一轮：我拒绝hard_link失败时copy+rename回退，因为目标竞态会覆盖既有文件；保留显式不支持错误并文档化。视频Session新增abort AtomicBool，所有capture/encode子进程20ms轮询，ChildGuard kill+wait，Exit先全量abort再join。来源保护新增随机UUIDv4每请求nonce，绑定window+原生URLorigin+nonce，错误nonce不能消费pending；hello私有随机nonce，仅top frame发送，销毁窗口撤销授权并失败pending。允许来源从集合改为每窗口一个当前origin。自报location.href不能提供安全性，所以不用它替代native校验。
实际CI指出mac文档初始化时hello未建立；现在去掉document-start hello，改Tauri on_page_load Finished后eval topframe hello通过ACL回调授权。初始about:blank和无授权返回专用RPC -32002；Playwright waitForWindow仅对这个码做deadline内重试，其他错误立即传播。Windows此前focus/url两个失败已经消失，本轮只有首个fixture startup竞态和旧unit错误地接受缺失result。后者已改为拒绝。Linux尚在CI。
请针对这些设计给明确是否同意，以及剩余必须修复的具体问题；不要笼统要求更多测试。重点检查nonce/导航、退出清理。300字以内。

## Claude 回复

**同意的设计**

- 拒绝 copy+rename 回退，保留显式不支持错误：同意。目标竞态确实会覆盖文件，文档化即可。
- 每请求 UUIDv4 nonce 绑定 window+原生 origin，错误 nonce 不能消费 pending：同意，且比我上轮提议的自报 href 更强。
- hello 改为 `on_page_load` Finished 后由 Rust 主动 eval 顶层帧，私有随机 nonce：同意。这也顺带消除了 CI 观测到的 document-start 时序问题。
- 每窗口单一当前 origin，窗口销毁撤销并 fail pending：同意。
- 专用 `-32002` 加 Playwright 仅对此码重试：同意，其他错误立即传播是正确边界。

**仍需修复**

1. **hello 与 on_page_load 的重入竞态。** 页面 A 触发 Finished，Rust 发出 hello(nonce₁)；页面随即导航到 B，Finished 再次触发发出 hello(nonce₂)。若 nonce₁ 的回调在 nonce₂ 已发出后才到达，必须被拒绝。要求：每窗口只保留最新未消费的 hello nonce，且回调校验 nonce 与 `webview.url()` origin 同时匹配。

2. **hello 之后、eval 之前的导航。** 单一 origin 在 hello 成功后设为 A；页面导航到同 origin 路径不重置授权，这没问题。但导航到 B 时，在 B 的 Finished 之前存在“授权仍为 A，页面已是 B”的窗口。`check_origin` 读原生 URL 会拒绝，JS 内 pin 也会拒绝，这是安全的；但要确认 Started（非 Finished）时就清空当前 origin 并 fail 未决 pending，否则 B 页早期脚本可在 A 授权下收到 eval。

3. **退出清理顺序。** Exit 先全量 abort 再 join 正确，但 `Session::drop` 仍会自行 join。若 Exit 与 `video.stop` 并发，同一 worker 只能被一处 take。确保 abort 标志由 worker 在 `recv_timeout` 每次唤醒和每个 20ms 轮询点检查，并且 join 有上限，否则 encode 被 kill 后 `run_bounded` 返回 Err 是即时的，但 `screencapture` 卡在权限对话框时 kill 可能不立即生效。

4. **pending 在窗口销毁时的错误码。** fail pending 应返回明确错误而非超时，且不应是 `-32002`，否则 Playwright 会对已销毁窗口重试到 deadline。

无其他阻塞项。
