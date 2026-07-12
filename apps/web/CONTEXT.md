# apps/web 领域词汇

前端(React 19 + Vite + zustand + react-query + assistant-ui/AG-UI)的领域术语。命名 issue、重构提案、测试时用这里的词,不要漂移到同义词。

## RunSession

**run 生命周期在前端的唯一归属**。概念模块,由三个文件组成(都在 `src/stores/`,同一 `run-session-` 前缀):

- `run-session-store.ts` — zustand store:取消/引导标记、排队输入、完成提示、答题标记等会话态。
- `run-session-status-rules.ts` — 纯规则:快照 status → runStatus / 展示状态的解释。
- `run-session-resume.ts` — resume 数据流(见下)。

**约束:RunSession 不碰 aui**(assistant-ui runtime)。它只管数据与状态;aui 接线放 `src/lib/runtime/`。不要为了省一层把 aui 引用塞进 RunSession——这条边界是刻意的。

## resume 数据流

「刷新页面后续接一个进行中的 run」的唯一实现:`openResumeStream(conversationId, qc, options)`(`run-session-resume.ts`)。fetch `/agent/resume` SSE + 帧解析 + 快照归一化 + 流结束时 runStatus 回填,全部内聚在这一个 async generator 里。入口是 `lib/runtime/thread-history-adapter.ts` 的 `resume()` 薄 aui 接线,不允许再长出第二份数据流实现。

## 问答中断(interrupt)

问答走 AG-UI interrupt terminal model(决策见 [server run ADR-0001](../server/src/run/docs/adr/0001-question-interrupt-terminal-model.md)):问题挂起时 AG-UI run 以 `requires-action`(reason interrupt)结束,interrupts 存在消息 `metadata.custom.agui.interrupts`;回答 = 携带 `resume[]` 的新 run。

- 待答判定:`thread-utils.ts` 的 `isAwaitingAnswerStatus` + `findPendingQuestionPart`,不再有独立的重连/标记机制。
- 提交:`unstable_submitInterruptResponses`,经 `lib/runtime/interrupt-runtime-registry.ts` 按 conversationId 取到所属 runtime(useRemoteThreadListRuntime 会包掉 per-thread runtime,unstable 扩展方法拿不到,registry 是这条缝的唯一过桥)。
- 刷新页面 = 普通历史加载;答完 = 普通新 run。没有 409 特判、没有手动重连。

## runStatus 唯一写入面

`["conversations", ...]` react-query 缓存的写入只走 `src/lib/conversations-cache.ts` 导出的语义操作(合并轮询状态 / 应用运行态 patch / 乐观写+延迟校准 / 插入新会话)。**禁止在别处直接 `setQueryData` 这份缓存**——resume 收拢前 thread-history-adapter 私藏过一份写入实现,别再出现第二次。

「终态 outcome → 会话运行态」的**推导规则**同样只有一份:`run-session-status-rules.ts` 的 `conversationStateFromRunFinished` / `RUN_STARTED_CONVERSATION_STATE` / `runStatusFromSnapshot`,live(agent-middleware)与 resume 都从这里取 patch,交给 `setConversationRunState` 写入。**问答/工具审批挂起 = running + pendingUserAction=question**(镜像后端 run-status.policy:requires_action 不投影 runStatus)——前端任何路径不得为 interrupt outcome 写 idle,否则乐观写会和轮询互相翻转;run 启动(含答题 resume run)写 running 并清掉待答标记。middleware 不允许再出现 inline 状态映射。

stop 场景的时序语义见 [ADR-0001](docs/adr/0001-stop-optimistic-status-delayed-revalidate.md)。

## aui 接线层

`src/lib/runtime/`:agent middleware、history adapter、答题重连 hook 等一切需要触碰 assistant-ui runtime 的胶水。允许够 aui 的私有 API(`__internal_getRuntime` 等),但业务数据流必须委托给 RunSession,不在接线层内联。

消息 metadata 的 `custom.agui` 嵌套形状归 `@assistant-ui/react-ag-ui` 所有:写经 `withAgUiCustomMetadata`、读经 `readAgUiCustomMetadata`,web 里不允许手写这层嵌套(形状断言只活在包的契约测试 `agui-custom-metadata.spec.ts` 里)。
