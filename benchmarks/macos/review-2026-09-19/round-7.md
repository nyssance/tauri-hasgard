# 第 7 轮 · Claude 评审

Session: `37cbf695-d473-47af-bbde-069c3c9a0fb0`

## Codex 提交讨论的问题

第7轮收尾：0.5.0候选Rust三平台、TypeScript、mac原生和Windows原生通过，Linux两架构前一修复提交各63项通过，候选还在跑；Windows ARM编译通过。mac视频附件确实captured:true/23639bytes/1frame/1ms，原用例立即stop只验证编码首帧；现用例改为等待1秒自动完成，断言frames>1、duration>=1000，等待其远程结果。另发现窗口销毁后nativeID会失效，已在Destroyed取消该窗口视频，abort+stop+worker锁join；单元验证只取消settings保留main，Exit全部取消。本地Rust新增此用例后361项，TS131、bridge126通过；Clippy通过。源码已冻结，只有验证/记录/发布剩余。
请复核最后两个补强是否足够，明确本轮代码范围是否达成100%设计与实现共识，以及最终HTML可否在候选CI全绿且多帧附件通过后标100%。保留mac-only视频、mac AppleSilicon-only、WindowsARM编译-only、本机keyboard历史未复测、未重跑性能这些边界；不把100写成全球排名或覆盖率。若仍有实质阻塞项请具体说明。无需工具，250字以内。

## Claude 回复

**两项补强复核：足够。**

- 视频用例改为等待 1 秒自动完成并断言 frames>1、duration>=1000，正好补上第 6 轮的盲点 2，避免单帧 mp4 被算作成功。等远程附件出来后，记录帧数与时长即可。
- Destroyed 取消该窗口视频，abort、stop、持 worker 锁 join，与退出路径共用同一清理，避免 nativeID 失效后的悬挂 worker。单元只取消 settings 保留 main 与 Exit 全部取消这两个断言正确覆盖了作用域。

**设计与实现共识：达成。** 七轮讨论内，来源握手与 nonce 绑定、pending 取消语义、视频生命周期、退出与销毁清理、单协议 runner、严格 TOML、storage.get 查询语义，我均已同意，没有未收回的异议，也没有剩余实质阻塞项。源码冻结后只剩验证、记录与发布。

**最终 HTML 标 100% 的条件：** 0.5.0 候选提交在 Linux 两架构全绿，且多帧视频附件 frames>1、duration>=1000 远程通过。在此之前只写“候选运行中”。

**必须保留的边界：** 视频 mac-only、mac 仅 Apple Silicon、Windows ARM 仅编译、本机 keyboard 历史未复测且未归因、性能未重跑并标注来源 commit 与日期。顶部一句话声明 100% 指讨论共识，不是全球排名或覆盖率。

候选绿后可标。
