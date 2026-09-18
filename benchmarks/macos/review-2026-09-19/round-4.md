# 第 4 轮 · Claude 评审

Session: `37cbf695-d473-47af-bbde-069c3c9a0fb0`

## Codex 提交讨论的问题

第4轮讨论范围和对比结论：不会声称全球最好或全维度领先。对比只对应本地Vendor pilot662e74e和playwright7e50bff，未刷新、未重做性能测试。已完成radio幂等/socket inode清理与umask/录制状态及多窗口作用域/来源绑定/MCP scenario及storage-get/mac原生视频。Windows从allow_failure改为required，mac仅Apple Silicon；Windows ARM只编译检查，不冒充运行。视频仅mac native compositor，不加浏览器伪造回退。
对第3轮建议有一处不同意：storage-get原始RPC应保留found:false（可查询语义），TOML断言缺失key由runner标记Failed并带步骤名错误，MCP isError且结构化report，CLI非零退出；不需要为本地断言新增RPC错误码，也不在有副作用步骤自动重试。用户可显式wait，fixture启动只重试-32002。未知TOML字段由serde给行列/字段名，validate_step错误加入step编号及name。请确认是否同意这种契约，并从原生视频只支持mac、未重跑性能、历史本机keyboard失败未重现的情况下，讨论HTML100%能否代表本次代码能力范围内的最佳共识；严格区分共识和实验覆盖，300字以内，不用工具。

## Claude 回复

**storage.get 契约：同意，收回第 3 轮建议。** 原始 RPC 返回 `found:false` 保留查询语义，缺失键由 TOML runner 在断言层标记 Failed 并带步骤名，MCP 用 `isError` 加结构化 report，CLI 非零退出。这比新增错误码更清晰，也让“查询”和“断言”各归其位。不对有副作用步骤自动重试、fixture 启动只重试 -32002，这条边界正确。serde 行列加 step 编号与 name 的错误信息足够定位。

**对比结论的措辞：同意只对应两个固定 commit，不刷新、不重跑性能。** 这是诚实表述。文档里应写明 commit 哈希和日期，并注明性能数字来自旧运行。

**HTML 100% 能否代表本次代码能力范围内的最佳共识：**

区分两层。

共识层，指本轮四轮评审内 reviewer 与作者都已认可的设计：来源握手与 nonce 绑定、pending 失败语义、视频生命周期与退出清理、单协议共享 runner、严格 TOML 字段、storage.get 查询语义。这些是设计共识，不是实验结果，可以写“评审一致同意”。

实验覆盖层，只能写已跑过的内容：Rust 单元 359 项、TS 131 项、mac 与 Windows 的新 CI 结果。以下不能进入“100%”的表述：

- 原生视频仅 mac，Linux 与 Windows 没有等价路径，属于明确不支持，而非已验证。
- 性能未重跑，任何百分比只能标注来源 commit 与日期。
- 历史本机 keyboard 失败未重现，只能写“本轮未重现”，不能写“已修复”。
- Linux CI 尚未完成，握手改动在 Linux webkit2gtk 上仍属未验证。
- Windows ARM 只有编译检查。

因此结论是：HTML 100% 可以作为“本轮改动在已运行矩阵上的通过率”，不能作为“代码能力范围内全部覆盖”。建议标题改为“已运行矩阵通过率”，并把上述五项列为明确的未覆盖项。这样共识和实验覆盖分开，不夸大也不低估。
