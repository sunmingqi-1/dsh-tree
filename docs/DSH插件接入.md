# dsh-study-tree 的 DSH 插件接入依据

项目显示名为「学习树」。本文依据同级目录 `deepseek-harness` 的本地源码，版本为 `0.2.2-rc.3`，提交为 `39163dd30f703a79079e2d2446545cff3c453738`。下面区分宿主已有能力和本插件要实现的部分。核对范围为源码、随仓模板及测试用例，实际安装和运行列入[开发计划](开发计划.md)。

## 怎样让 DSH 发现插件

1. 在独立目录制作 Cordis bundle。根清单用 `dsh.bundle.patch` 指向 `./cordis.patch.yml`，补丁用 `insert` 插入一条记录，`id` 和包名都取 `dsh-study-tree`。DSH 的 profile 会把 bundle 纳入启动配置。[架构说明](../../deepseek-harness/docs/architecture.md) · [官方补丁样例](../../deepseek-harness/packages/preset/agent-preset/skills/dsh-doc/templates/decoration/cordis.patch.yml)
2. 同一个包导出 Host 入口 `.` 和浏览器入口 `./client`。清单声明 `dsh.client.platform = "web"`，在 `dsh.client.inject` 中列出页面实际依赖的 DSH 包。Cordis 的 `inject` 声明此侧需要的服务名，两处分别核对。首次联调以精确的 `engines.dsh = "0.2.2-rc.3"` 为目标，其他版本通过验证后再扩范围。[清单样例](../../deepseek-harness/packages/preset/agent-preset/skills/dsh-doc/templates/decoration/package.json) · [兼容判断](../../deepseek-harness/docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.md)
3. 浏览器产物注册与包同名的模块工厂，React 由宿主提供。React Flow、Dagre 和 Markdown 渲染依赖随插件构建；先用最小画布验证第三方依赖、样式和 CSS 资源在宿主中加载。仓内的 `clientBundle` 是构建参考，其相对路径不能作为已发布插件的运行时依赖。[模块工厂样例](../../deepseek-harness/packages/preset/agent-preset/skills/dsh-doc/templates/decoration/client.js) · [构建实现](../../deepseek-harness/packages/client/tsdown.client.ts) · [样式元数据](../../deepseek-harness/docs/upgrade-guide/v0.2.2-rc.2/client-module-metadata/guide.md)
4. 客户端通过原生工作区里的主题或节点项打开学习过程。0.2.0 在 `shell.overlay` 注册画布组件，将画布挂入原生主区域，与宿主自己挂载的会话界面并排。会话选择交给 `ctx.uiWorkspace.openSession`，通过 `ctx.uiSession.adapter.current` 订阅宿主已提交的当前绑定，避免与原生切换竞争。画布随组件卸载释放 DOM 标记、样式、事件监听和引用。[布局契约](../../deepseek-harness/packages/client/ui-layout/README.md) · [原生会话选择](../../deepseek-harness/packages/client/ui-workspace/src/client/navigation.ts) · [会话绑定](../../deepseek-harness/packages/client/ui-session/src/client/index.ts)
5. 打包时包含构建后的两个入口、补丁、中英文展示资料、图标和样式资源。开发验证从 DSH「插件 → 添加插件」选择构建完成的本地项目目录；检查安装结果、页面入口、重启与禁用后的表现。运行本地链接包和检查最终分发包的文件清单是两项独立验收。[随仓开发指南](../../deepseek-harness/packages/preset/agent-preset/skills/dsh-doc/references/plugin-development.md) · [资源与导出](../../deepseek-harness/packages/preset/agent-preset/skills/dsh-doc/references/host-plugin.md)

## 原生目录与对话的复用边界

- **工作区目录。** `ui-workspace` 继续提供工作区、普通会话、搜索和行操作。插件通过 `sidebar.session.row.trailing` 在宿主行内组合层级列表，按根会话工作区聚合学习节点。每组由一个已挂载的学习会话行承载树，适配宿主的行分页。同组内全部学习主题按持久化结构显示，普通会话保留原有操作。仅有学习会话的组隐藏已被树完整覆盖的分页按钮。[工作区说明](../../deepseek-harness/packages/client/ui-workspace/README.md) · [行扩展契约](../../deepseek-harness/packages/client/ui-workspace/src/client/contract/slots.ts)
- **完整原生界面。** 保留宿主的 `main.conversation`，由宿主处理标题、模式、视图页签、对话内容及原生输入区。画布经 Portal 作为相邻列挂入主区域。插件通过宿主的 `data-slot`、`data-row-key` 和 `data-chat-turn` 标记完成布局、问答对应与可见轮次约束。原生输入提交的新消息被记录为子节点，必要时先按当前节点结束序号准备分支。该集成按当前固定的 DSH 版本验证，升级宿主时需复查这些标记及绑定契约。[原生界面](../../deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationMainPanel.tsx) · [原生节点标记](../../deepseek-harness/packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx)
- **卡片原始输入组件。** 0.6.0 通过 SlotRegistry 的 `entries`、`subscribe` 复用实际 `conversation.composer.bar` 及其子注册，在插件命名空间中保留组件、注入、字典和 Store，不重复声明原生 slot。卡片、选区与右侧编辑器使用不同 Session，避免 Lexical 同会话多个 DOM root 冲突。通过原生 header 的 Portal 和 `SessionProvider` 传递已 retain 的会话引用。原生 InputBar 单独挂载不会自动绑定草稿保存；额外复用 `conversation.session` 的 Store 与 `bindDraftPersistence`，根组件绑定 scope 为 `session`，由原生 inputActions 保存编辑状态。该适配依赖固定宿主版本，升级时须复查注册结构、草稿绑定和子控件。[输入区](../../deepseek-harness/packages/client/ui-conversation/src/client/skeleton/InputBar.tsx) · [编辑器单一 root](../../deepseek-harness/packages/client/ui-conversation/src/client/input/editor/ComposerContentEditable.tsx) · [注册表](../../deepseek-harness/packages/client/ui-renderer/src/client/registry.ts)
- **原生起始页。** `conversation.hero.options` 提供「以学习画布开始」。保留原生工作区、模式、模型选择及输入，观察首条带请求 ID 的 `user/message` 建立根节点。继续由宿主执行和保存该轮生成，后续节点仍按父轮结束序号分叉。
- **学习路径与引用。** 插件继续拥有节点 ID、父子关系、请求 ID 和轮次结束序号，并向阅读组件提供正确路径。需核对历史分页、工具调用和详情块的节点归属，保障从祖先回答划词时仍能引用到相应来源。已验证的集成场景及实际覆盖范围见[开发计划](开发计划.md)。

## 会话如何支撑学习树

| 需求 | 本地源码确认的能力 | 插件承担的工作 |
| --- | --- | --- |
| 开始学习 | 客户端 `ctx.sessions.create` 创建会话，可传工作区；`retain` 取得有生命周期的引用 | 选定树、保存根节点映射，在离开时释放引用 |
| 从某轮追问 | `fork({ sessionId, atSeq })` 复制到指定事件，包含该事件。省略边界会取最近的已完成前缀 | 保存所选轮结束事件的真实序号；传入该序号，防止历史节点带入后续回答 |
| 接收回答 | `SessionFace.prompt` 负责提交；返回 accepted 只表示已接收。会话状态提供实时变化，历史可按序号加载 | 关联请求与当前节点，显示流式正文，以持久化的本轮结束记录确认完成；切换节点时继续按原 ID 归档 |
| 重建树和引用 | 普通 fork 是独立会话，宿主不持久化它的来源；会话日志保留继承的前缀 | 单独记录父节点、源轮和选区。按节点路径读取每轮，避免重复展示继承历史 |
| 跨重启保存 | Host 的 `ctx.storageDomain` 可打开带版本和校验的 domain，写入完成后通知调用方 | 设计插件记录、更新冲突处理和恢复逻辑；通过插件自己的 Host 接口供页面读写 |

源码入口：[会话集合](../../deepseek-harness/packages/api/session-controller/src/client/contract/sessions.ts) · [单会话提交与分页](../../deepseek-harness/packages/api/session-controller/src/client/contract/session.ts) · [分叉实现](../../deepseek-harness/packages/api/session-controller/src/commands.ts) · [分叉边界测试](../../deepseek-harness/packages/api/session-controller/tests/session-fork.host.spec.ts) · [普通分叉的来源规则](../../deepseek-harness/docs/upgrade-guide/v0.2.1-rc.3/independent-session-forks/guide.md) · [持久化 domain](../../deepseek-harness/packages/storage/storage-domain/README.md)

## 首次联调要回答的问题

- 全局面板如何为指定会话取得结束序号、已提交正文和实时片段？优先复用公开的会话接口；如需补充轮次索引，在 Host 定义会话投影并向客户端提供结果。用含工具调用的真实一轮验证序号映射与去重。[会话投影](../../deepseek-harness/docs/subsystems/session-projection.md)
- 树记录的读写如何经宿主权限边界暴露给浏览器？以仓内 Host Remote 实现为参考，验证插件自有命名空间、注册与构建方式，并验证禁用时的清理。该接口属于插件待开发内容。[Host Remote 示例](../../deepseek-harness/packages/client/ui-trajectory/src/index.ts)
- 长路径反复 fork 会复制多少前缀，产生多少可见会话？记录时间、日志体积和宿主会话列表表现，再决定是否对连续追问复用同一条会话。
