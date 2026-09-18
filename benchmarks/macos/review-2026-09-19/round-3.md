# 第 3 轮 · Claude 评审

Session: `37cbf695-d473-47af-bbde-069c3c9a0fb0`

## Codex 提交讨论的问题

第3轮：已按第2轮修复。每窗口handshakes map值为(random UUIDv4, expected origin)。Finished生成新nonce覆盖旧值，eval JS再次比较payload.url来源且限制topframe，ACL回调中校验最新token+nativeURL再消费token；Started与Destroyed均清空授权、hello、snapshot并失败pending（普通-32603非-32002）。测试覆盖旧nonce、错窗口、错origin、重复nonce和销毁失败pending。你说B页早期可在A授权收到eval：我们原本host URL+JSorigin双检查已避免执行，现Started撤销再强化。
视频改为 sessions HashMap<label, Arc<Session>>；Session worker是Mutex<Option<JoinHandle>>；start在短锁内注册线程，释放全局锁，再等ready channel（ffmpeg version+首帧成功）才返回。stop克隆Session后释放全局锁，持worker锁take/join，join后释放锁按Arc身份移除。shutdown先在短锁内closed=true并drain，所有abort标志置true，再逐个持worker锁take/join。因此并发stop的join也在shutdown等待范围内，closed禁止再start。子进程均有deadline和abort轮询，kill+wait；不伪称对不可杀死内核进程有绝对墙钟保证。
Rust上一版359项、TS131项已通过，最新修改正在检查；mac/windows新CI运行中；Linux较慢。请复核剩余实质阻塞项，并评估MCP TOML共享runner/严格字段/storage-get空串正确/缺失值错误设计，最多300字。无需工具。

## Claude 回复

**握手与 nonce：同意，无阻塞项。** Finished 覆盖旧 nonce、Started/Destroyed 清空并以 -32603 失败 pending、回调校验最新 token 加原生 URL 后才消费，这三者合起来封闭了我第 2 轮提出的两个窗口。剩下一个小点：Finished 覆盖 nonce 时，若旧 hello 的回调恰好在覆盖前一刻已通过校验并消费，新 hello 会再次授权同一 origin，结果幂等，可接受。

**视频生命周期：同意，无阻塞项。** 短锁注册加 ready channel、stop 按 Arc 身份移除、shutdown 先 closed 再全量 abort 再 join，这个顺序正确。两点确认，不算阻塞：

1. start 等待 ready channel 时若客户端断开，spawn_blocking 仍会跑完并注册 session，之后只能靠 stop 或 shutdown 回收。这是可接受的，但 status 应能看到它。
2. 不对不可杀内核态进程做墙钟承诺是正确的表述，文档里写清即可。

**MCP TOML 设计评估**

- **共享 runner：** 同意。CLI、MCP、Playwright 共用一个 JSON-RPC 执行路径符合 AGENTS.md 的单协议规则，也避免三处漂移。
- **严格字段：** 同意。未知键直接报错，而不是忽略，与“不加静默回退”一致。要求错误里指出是哪个键和哪一步。
- **storage.get 空串为正确值、缺失键为错误：** 同意。空串是合法存储值，把它和缺失混为一谈会丢失信息。缺失应是明确的错误码而非 null，否则调用方无法区分“键存在但为 null 字符串”。建议错误码固定，且不用 -32002，避免 waitForWindow 误重试。
- 一个需要决定的点：storage.get 在窗口尚未握手时会返回 -32002，与“缺失键错误”是两类失败，TOML 步骤应只对前者重试。

**结论：** 本轮未发现必须修复的实质阻塞项。等 Linux CI 结果即可。
