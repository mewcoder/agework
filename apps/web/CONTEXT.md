# apps/web 领域词汇

前端(React 19 + Vite + zustand + react-query + assistant-ui/AG-UI)的领域术语。命名 issue、重构提案、测试时用这里的词,不要漂移到同义词。

## RunSession

**run 生命周期在前端的唯一归属**。概念模块,由三个文件组成(都在 `src/stores/`,同一 `run-session-` 前缀):

- `run-session-store.ts` — zustand store:取消/引导标记、排队输入、完成提示、答题标记等会话态。
- `run-session-status-rules.ts` — 纯规则:快照 status → runStatus / 展示状态的解释。
- `run-session-resume.ts` — resume 数据流(见下)。

**约束:RunSession 不碰 aui**(assistant-ui runtime)。它只管数据与状态;aui 接线放 `src/lib/runtime/`。不要为了省一层把 aui 引用塞进 RunSession——这条边界是刻意的。

## resume 数据流

「续接一个进行中的 run」的唯一实现:`openResumeStream(conversationId, qc, options)`(`run-session-resume.ts`)。fetch `/agent/resume` SSE + 帧解析 + 快照归一化 + 流结束时 runStatus 回填,全部内聚在这一个 async generator 里。

两个入口都是**薄 aui 接线**,不允许再长出第二份数据流实现:

- 刷新续接:`lib/runtime/thread-history-adapter.ts` 的 `resume()`(默认模式,409=requires_action,不重试)。
- 答题重连:`lib/runtime/use-resume-after-question-reply.ts`(`retryOn409` 模式,409=后端还在处理 reply,退避重试)。

同一个 409 在两个入口语义不同——这是 `retryOn409` 选项存在的原因,不是可以合并的重复。

## runStatus 唯一写入面

`["conversations", ...]` react-query 缓存的写入只走 `src/lib/conversations-cache.ts` 导出的语义操作(合并轮询状态 / 设置运行状态 / 乐观写+延迟校准 / 插入新会话)。**禁止在别处直接 `setQueryData` 这份缓存**——resume 收拢前 thread-history-adapter 私藏过一份写入实现,别再出现第二次。

stop 场景的时序语义见 [ADR-0001](docs/adr/0001-stop-optimistic-status-delayed-revalidate.md)。

## aui 接线层

`src/lib/runtime/`:agent middleware、history adapter、答题重连 hook 等一切需要触碰 assistant-ui runtime 的胶水。允许够 aui 的私有 API(`__internal_getRuntime` 等),但业务数据流必须委托给 RunSession,不在接线层内联。
