# Vendor 对比复核 · 2026-09-19

本轮比较本地 Vendor 的 tauri-pilot（662e74e）与 tauri-playwright
（7e50bff1905ad8d5e6a52fb40e6439e0dbcbe6e6），Hasgard 基线为 9b6174b，
以下修复尚未发布。没有刷新 Vendor，也没有重新运行性能或桌面压力测试。

结论：Hasgard 已具备统一 RPC、CLI、MCP 和原生应用测试客户端，但当前证据
不支持“全面优于这两个项目”。9 月 7 日的共识与性能结果不能代替对新版竞品的验证。

## 本轮修复

| 问题                                                 | 修改与验证                                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 对已选中的 radio 再次 check 会取消选择               | radio 默认保持选中；拒绝非 checkbox/radio 和直接取消 radio；仅状态改变时触发 input/change。桥接单元测试通过，新增真实应用回归用例但本机未运行。 |
| socket 清理比较了内核 socket inode，而非路径 inode   | 使用路径的设备号、inode 和 socket 类型判断；真实 Unix socket 测试验证删除自身、保留替换对象。                                                   |
| socket bind 临时改变进程 umask，影响其他线程创建文件 | 移除进程级 umask 改动，接收连接前设置 0600，保留对端 UID 检查。                                                                                 |
| 未开始录制时 stop 仍成功                             | 共享 RPC 返回明确错误；区分有效的空录制与未录制。                                                                                               |
| 录制丢失窗口作用域，回放可能落到 main                | 保留 window 参数；JSON 回放沿用已有参数转发，shell 导出逐条保留窗口。                                                                           |

实现见 [bridge.js](../../crates/tauri-plugin-hasgard/js/bridge.js)、
[unix.rs](../../crates/tauri-plugin-hasgard/src/server/unix.rs)、
[recorder.rs](../../crates/tauri-plugin-hasgard/src/recorder.rs)、
[CLI](../../crates/tauri-hasgard-cli/src/main.rs)。

## 剩余差距及优先级

| 优先级 | 差距                   | 证据与处理方向                                                                                                                                     |
| ------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | 导航过程中命令来源绑定 | Pilot handler/eval 已检查并固定执行来源。Hasgard 当前 eval 按窗口直接发送，尚无同等来源绑定；需要覆盖导航竞态及回调来源，不应只加 URL 字符串检查。 |
| P1     | 场景执行入口与错误契约 | Pilot 提供 MCP 场景入口、storage-get 场景步骤。Hasgard 已有 CLI TOML runner，但缺上述入口；其必填参数和断言结果仍有空串默认值，应改为显式错误。    |
| P1     | 原生验证仍有缺口       | 历史本机键盘失败未归因、Windows 原生 E2E 允许失败仍需解决。应定向验证、优先 CI，不能用长时间切窗压力测试代替归因。                                 |
| P2     | 原生视频               | tauri-playwright 的 native_capture.rs 提供 ffmpeg 录制。Hasgard 尚无等价视频能力；优先完成可靠性工作后再评估。                                     |

Vendor 源码位置：

- [tauri-pilot](/Users/ny/Projects/ALwith/Vendor/tauri-pilot/)
  的 crates/tauri-plugin-pilot/src/handler.rs、eval.rs、server/unix.rs、
  crates/tauri-pilot-cli/src/scenario.rs 及 MCP 模块。
- [tauri-playwright](/Users/ny/Projects/ALwith/Vendor/tauri-playwright/)
  的 packages/plugin/src/native_capture.rs 与 README.md。

浏览器模拟模式、完整 Playwright Page 外观不是 Hasgard 的补齐目标：
本项目要求每个客户端驱动真实运行的 Tauri 应用，并保持统一协议。
macOS 仍仅支持 Apple Silicon。

## 验证范围

Rust workspace 352 项通过，桥接 JavaScript 126 项、TypeScript 客户端 129 项通过；
Clippy（warnings as errors）、类型检查、协议同步检查通过。
新增 radio 原生应用测试用例未在本机运行。
以上单元测试不代表原生端到端验证，不构成新的双模型共识或新发布记录。
