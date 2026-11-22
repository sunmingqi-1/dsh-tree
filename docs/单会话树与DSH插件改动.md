# 单会话学习树与 DSH 插件改动

设计讨论稿，2026-11-20。核对版本为本机 DSH Desktop 0.2.2-rc.5，文中源码位置使用相邻的 deepseek-harness 工作区。范围是新建学习树。旧 fork 学习树的迁移另议。

## 一棵树怎样运行

第一轮提问创建根节点。每次从已结束的回答继续，在原 session 追加一个子 turn，划词追问额外记录原文位置。同一张卡片可以产生多个孩子。点击卡片仅选择阅读位置，发送时才确定新的执行路径。卡片聚合该轮的提问、流式消息、工具活动和回答，日志保留原生事件粒度。

假设物理写入顺序是 A、B、C、D，父关系是 A→B、A→C、B→D。对 D 的一次模型调用，参照行为是普通 DSH 具有 A→B 历史、收到 D 的提问后，在相同设置和工具环境下组装的请求。比较对象是请求消息、工具定义和上下文处理；生成的自然语言无须逐字一致。右侧阅读 A→B→D 的原始对话。查看 C 或在另一窗口点击 A，都不能改变正在生成的 D。

## 官方运行链与改动归属

包名以下省略 @deepseek-ai/ 前缀。dsh-base 装配共享服务，dsh-web-app 加入桌面所用的 Web 界面和会话控制器。preset 为会话选择工具和 Agent 子插件。推荐扩展默认驱动，使已有的模型调用、工具执行、流式回复和提问交互继续走官方链路。

| 部位 | 现有行为与建议 |
| --- | --- |
| dsh-api-session-controller | prompt 以 sessionId 找到 Agent，按 requestId 去重，将消息交给 followup 或 steer。给新一轮发送增加稳定的父位置，经过客户端和宿主协议一起传递。验证父节点属于此树且有稳定结束边界。重复交付同一请求只能产生一个节点。运行中插话归当前轮；树上的新分支是新的排队提问。 |
| dsh-agent、dsh-agent-loop | 前者拥有 Agent 和收件箱契约，后者打开 turn、领取排队输入、准备每次模型请求。当前顺序是先写 turn/start，再领取该轮提问。树模式需要在打开轮次时就绑定已经接收的请求与父位置，使 pre-step、自动压缩、流式响应及工具回调均属于正确路径。首版建议同一棵树串行执行，排队项独立保存父位置。接口类型改动落在实际拥有该类型的包。 |
| dsh-session | 全树保留一份按全局 seq 追加的事件流，从持久父关系派生路径。提供按节点和历史边界读取的模型消息、请求头、运行上下文与历史工具定义。现有 surface（模型可见的有序消息）只有一个当前值。祖先的有效历史可共享；子分支上的替换不能改写兄弟分支或祖先快照。 |
| dsh-session-persistence、格式目录及 dsh-session 的恢复 | 事件读入会校验类型，Session.fromRestore 还会按顺序应用 surface 变更。正式登记树语义，并让恢复逐条重建父关系和分支上的替换。宿主启动时修复未结束的 turn，合成的结束事件须归原执行轮次。格式版本按最终事件表示和仓库格式规则判定。 |
| dsh-token-meter | 现实现按 Session 缓存，从上次读到的全局序号一直折叠到日志末尾。当前请求的上下文占用、最近一次有效测量、请求头和工具开销须基于同一执行路径。整棵树实际消耗的 token 单独按真实调用累计。 |
| dsh-compaction-basic 及配套包 | 自动压力、溢出后重试、手动压缩都须定位到分支。摘要保留范围、工具调用与结果配对、替换提交前的校验沿用官方规则。需要检查最近回答模型的投影、工具结果裁剪、图片省略和手动命令入口。保留策略和摘要生成器可以复用。 |
| dsh-session-projection 及具体消费者 | 投影注册表可承载从全树日志构建的父子索引。核对每个影响下一次模型请求的消费者，尤其是最近回答模型、上下文计量和会注入请求的任务状态。按作用域决定读取活动路径或读取全会话。列表、统计和全树导航仍可消费全日志。能用新投影实现的行为无需预先修改注册表本身。 |
| dsh-study-tree 与原生 UI | 移除卡片和划词输入准备阶段的 fork，原生输入框发送同一 sessionId 和显式父位置。宿主日志可重建节点，插件存放可丢弃的索引与布局。草稿及引用按卡片区分。把活动路径的 turn 交给原生阅读视图，问题确认和审批按请求、轮次或调用路由。优先复用 ui-conversation 和 ui-chat；如果原生视图缺少传入路径的入口，再补视图接口。 |

实际入口可在工作区的下列文件中定位：

- 装配清单见 [共享宿主](../../deepseek-harness/packages/bundle/base/cordis.patch.yml) 和 [Web 应用](../../deepseek-harness/packages/bundle/web-app/cordis.patch.yml)。
- 发送、开轮和重启见 [会话命令](../../deepseek-harness/packages/api/session-controller/src/commands.ts)、[Agent 循环](../../deepseek-harness/packages/core/agent-loop/src/agent.ts) 和 [Agent 恢复](../../deepseek-harness/packages/core/agent-loop/src/index.ts)。
- 历史派生、读盘校验见 [Session](../../deepseek-harness/packages/core/session/src/index.ts) 和 [存储契约](../../deepseek-harness/packages/session/session-persistence/src/storage-contract.ts)。
- 压缩依据见 [token 计量](../../deepseek-harness/packages/llm/token-meter/src/index.ts)、[摘要范围与写入](../../deepseek-harness/packages/compaction/compaction-basic/src/region.ts) 和 [摘要模型来源](../../deepseek-harness/packages/compaction/compaction-basic/src/answered-route.ts)。
- 插件现状见 [输入框与分支草稿](../src/client/nativeDrafts.ts)、[原生阅读区](../src/client/NativeFrame.tsx) 和 [单轮卡片](../src/client/turnSlice.ts)。

## 存储和分支边界

保留一份顺序写入的原始日志、一套单调增长的 seq 和全 session 唯一的 turn 标识。父位置至少要能识别父 turn 及继承到的历史边界。日志内的工具调用、步骤、原始回答仍只记录一次。中止或失败的轮次需要可重放的终态；能否从某类终态继续，由提交入口按有效历史判定。重发同一请求与用户主动从同一节点再问一次应分开处理。

保留全局 seq 对工具结果、引用、裁剪、压缩和原生展示的意义。A、B、D 在物理文件中未必相连，不能简单截取“开头到 D”，也不能把选出的事件重新编号后交给要求连续 seq 的旧恢复器。可在全日志上建立父子关系与事件索引，以全局 seq 解引用，在路径顺序上计算模型消息和替换范围。热路径可缓存祖先的派生结果，避免每个流式增量都从根回放。

一次自动压缩可以发生在 turn 内的两个步骤之间，手动压缩也可以发生在 turn 之间。应为压缩绑定它开始时的路径位置和实际替换的事件。只有从该位置往后执行的后代才继承替换。连续多次压缩需按路径内的消息顺序解释起止边界。空闲注入也要记录它属于整棵树还是某一条路径。原始回答继续用于界面回看。

JSONL 后端已有每个 session 一个当前追加日志、写锁、解码和损坏尾部修复。建议复用这些能力，把变化集中在事件含义、校验和恢复。文件自身的 Zstandard 压缩与模型的上下文摘要是两个独立机制。

## 全局状态与外部效果

根到选中卡片的路径决定历史消息和该路径的摘要。工作区已经写下的文件、外部工具副作用、当前有效授权仍遵守宿主实际状态。历史请求需能还原当时的系统提示、模型和工具；新请求继续按当前有效设置组装。分支切换不得恢复已被撤销的权限。

另外，dsh-session-log-deepseek 在启用时可向官方 API 发送会话增量日志，这与请求的 messages 是不同字段。若树模式的要求扩展到“整次网络请求都不携带兄弟分支正文”，可对树会话使用已有的 registerExclusion()，与用户的普通会话上传设置独立。见 [官方日志插件说明](../../deepseek-harness/packages/session/session-log-deepseek/README.zh.md)。该选择不影响本地单日志设计。

## 建议的落地顺序

1. 先定义日志中的父位置、请求与轮次的绑定、轮外压缩的归属，以及按路径恢复的 Session 读取接口。
2. 接宿主的 prompt、队列和默认 Agent 循环。使用 A→B、A→C、B→D 检查实际请求只继承父链；同一请求重试不重复开轮。
3. 接 token 计量、自动与手动压缩、溢出重试。覆盖先在 B 压缩再从 A 提问、先在 A 压缩再分叉、同轮多次工具调用和重启恢复。先验证未压缩和已压缩的请求都与等价的线性路径一致。
4. 最后接卡片与右侧原生会话，核对跨卡片草稿、同父多子、后台生成时切换阅读节点、提问与审批定位。旁支上的新增内容不应使当前阅读区重新加载整棵树。
