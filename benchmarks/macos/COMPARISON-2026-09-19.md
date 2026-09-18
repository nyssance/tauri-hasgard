# Vendor 对比复核 · 2026-09-19

比较范围：本地 [tauri-pilot](/Users/ny/Projects/ALwith/Vendor/tauri-pilot/)
`662e74e` 和 [tauri-playwright](/Users/ny/Projects/ALwith/Vendor/tauri-playwright/)
`7e50bff1905ad8d5e6a52fb40e6439e0dbcbe6e6`，Hasgard 基线 `9b6174b`。
未刷新 Vendor，未重跑性能对比，也未在本机启动 GUI 或键盘压力测试。

## 已完成的差距修复

| 范围     | 实现与证据                                                                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 来源绑定 | 原生页面 Finished 后通过 Tauri ACL 握手；窗口最新一次性令牌、原生来源与请求随机令牌共同校验。Started/Destroyed 撤销授权并失败 pending，JS 执行前再检查顶层帧与来源，禁止跨来源 navigate。 |
| 场景入口 | CLI 与 MCP 共用 TOML runner、截止时间及步骤结果；拒绝未知字段和缺失必填值；storage-get 区分空串与缺失，MCP 失败提供结构化报告。                                                           |
| 原生视频 | macOS 按应用自己的 native window ID 采集真实 compositor 帧并由 ffmpeg 编码 MP4；限制时长与帧率，明确权限/编码错误，原子不覆盖发布，退出取消并等待子进程及并发 stop。                      |
| radio    | 重复 check 保持选中；拒绝非 checkbox/radio 和直接取消 radio，仅改变状态时发送 input/change。                                                                                              |
| socket   | 按路径 device/inode/type 清理自身 socket，保留替换对象；移除进程 umask 变更，保留 0600 与 UID 检查。                                                                                      |
| 动作录制 | 未录制时 stop 报错；有效空录制仍成功；JSON 与 shell 导出保留每步窗口作用域。                                                                                                              |
| Windows  | DOM focus 前激活 native WebView；正确识别 WebView2 URL；缺失 JSON-RPC result 不再作为 null 成功；原生 E2E 改为必过项。                                                                    |
| CI       | 三次原生失败即停止，任务有时间上限；启动失败保存进程诊断；视频成功与权限失败分别保存证据。                                                                                                |

实现：[插件源码](../../crates/tauri-plugin-hasgard/src/)、
[桥接源码](../../crates/tauri-plugin-hasgard/js/)、
[CLI/MCP](../../crates/tauri-hasgard-cli/src/)、
[原生客户端](../../packages/playwright/src/)、
[真实应用测试](../../examples/fixture-app/e2e/)。

## 验证与边界

本地 Rust 360 项、TypeScript 131 项、桥接 JavaScript 126 项通过；
Clippy warnings-as-errors、类型、格式和共享协议检查通过。
真实 ffmpeg 对生成 PNG 的编码测试通过；该测试不捕获桌面。

远程运行 [35380717261](https://github.com/nyssance/tauri-hasgard/actions/runs/35380717261)：
macOS Apple Silicon 原生 73 项通过；Windows x64 原生 56 项通过、17 项平台限定跳过；
Linux x64 原生 63 项通过、10 项平台限定跳过。
该运行的 Windows 单元测试也已通过。耗时主要在编译及 Linux 原生生命周期用例，
不是新的键盘压力循环。最新提交正在 CI 复核。

macOS 仅支持 Apple Silicon。Windows ARM64 只有编译检查，不等于原生运行验证。
视频只支持 macOS，需要 ffmpeg、屏幕录制权限及支持硬链接的输出文件系统；
其他平台显式不支持。视频测试通过可能是成功捕获，也可能是明确的权限拒绝，
必须结合测试附件中的 captured 字段判断。历史本机键盘未归因失败本轮未复测，记录保留。

## 双模型讨论

Claude Session：`37cbf695-d473-47af-bbde-069c3c9a0fb0`。
已完成六轮实质交流：[第一轮](review-2026-09-19/round-1.md)、
[第二轮](review-2026-09-19/round-2.md)、[第三轮](review-2026-09-19/round-3.md)、
[第四轮](review-2026-09-19/round-4.md)、[第五轮](review-2026-09-19/round-5.md)、
[第六轮](review-2026-09-19/round-6.md)。

落实了 iframe 回调伪造、旧握手竞态、退出清理、取消读取 nonce 的 panic 风险；
明确拒绝会覆盖目标的 copy/rename 回退，并保留 storage.get 查询与场景断言的不同语义。
目前实现没有剩余异议；最终共识等待完整平台矩阵。100% 的分母遵循 HTML 原标准，
表示讨论共识和注明范围内的最佳，不表示全部平台能力覆盖或全球性能排名。

## 发布

0.5.0 发布准备中；当前公开版本仍为 0.4.1。本文件不把准备中的版本记为已发布。
