# 前端工程 Code Review — 文件组织 / 组件划分 / hooks 划分

- 评审日期：2026-06-11
- 评审范围：`git diff main...HEAD -- apps/web`（分支 `feat/agent-runtime-phase4-docker-http`，前端约 2500 行新增 / 1900 行删除）
- 评审方式：7 个独立 finder 角度（3 正确性 + 3 清理 + 1 层次）→ 13 个候选 → 逐项验证（CONFIRMED / PLAUSIBLE / REFUTED）→ 保留 10 项

## 总体结论

本次 `thread.tsx`（-1200 行）与 `MyRuntimeProvider.tsx`（-340 行）大拆分质量不错：

- 删除行为审计确认旧逻辑（clipboard polyfill、thread archive 事件、action bar、run duration、tool batching 等）全部在新文件中有对应落点，没有丢失行为。
- 类型迁移到 `@agework/shared` 干净，`apps/web/src/api/*.ts` 没有留下重复的本地类型定义。
- 新建 `utils/validation.ts` 正确收敛了 login.tsx / account.tsx 的重复校验 schema，且符合既有 `src/utils/` 归位约定。

问题集中在三块：runtime 层绕过了 SDK 的正式扩展点（#4、#5）、hooks 归属规则不一致（#6）、两个小的行为回归（#1、#2）。

## 一、正确性 / 行为回归

### 1. 连接立即失败时用户看不到任何错误 ⚠️ PLAUSIBLE

`apps/web/src/lib/runtime/agent-run-interceptor.ts:178`

`RUN_ERROR` 只有在 `runStarted=true`（即收到过 `RUN_STARTED`）时才被转成可见的聊天气泡。如果后端宕机或 401 导致 SSE 在 `RUN_STARTED` 之前就报错，事件被原样透传，下游没有任何 toast / 错误气泡兜底，UI 停在无反馈的加载态。

**建议**：`runStarted=false` 的 `RUN_ERROR` 也走 `visibleRunErrorEvents` 转换（或至少触发一个全局错误提示）。

### 2. 停止运行后侧边栏可能"卡在 running"更久 ⚠️ PLAUSIBLE

`apps/web/src/hooks/use-threads.ts:84`

旧代码在 `useStopThreadRun` 成功后有一次 1500ms 延迟的二次 `invalidateQueries(['threads'])`，用来兜底后端 runStatus 的最终一致性。本次删除后，立即 refetch 可能用服务端仍为 `running` 的旧值覆盖 `markThreadRunIdleInCache` 的乐观更新，要等 `useThreads` 下一次 5s 轮询才纠正（之前约 1.5s 内自愈）。

**建议**：恢复延迟二次 invalidate，或让后端在 stopRun 响应前保证状态落盘。

### 3. auth config 引入 5 分钟陈旧窗口 ℹ️ PLAUSIBLE（可能是有意的）

`apps/web/src/router.tsx:24`

旧的 `beforeLoad` 每次导航都直接 `await authApi.config()`；现在改为 `queryClient.fetchQuery` + 5 分钟 `staleTime`。管理员切换 `authRequired` / `appName` 后，持续在 SPA 内导航的客户端最长 5 分钟感知不到。属于行为变化，如是有意的性能优化建议在代码注释中说明。

## 二、运行时层次（altitude）

### 4. `instance.run` 被整体 monkey-patch，而非使用 `agent.use(middleware)` 🔧 PLAUSIBLE

`apps/web/src/lib/runtime/use-thread-agent-runtime.ts:58`

已安装的 `@ag-ui/client@0.0.53` 明确暴露 `AbstractAgent.use(...middlewares)` 和 `abstract class Middleware { run(input, next): Observable<BaseEvent> }`，签名与 `interceptRunEvents(input, events)` 几乎一一对应（内置示例：`FilterToolCallsMiddleware`、`BackwardCompatibility_0_0_45`）。

当前手写覆盖 `instance.run` 的代价：

- 绕过中间件链（`apply` / `processApplyEvents` / subscribers），任何直接调用 `agent.run()` / `agent.runAgent()` 的新路径（resume 流程、admin 工具、测试）会静默丢失 gap 状态跟踪和 RUN_ERROR 可视化。
- remoteId 初始化、query invalidation、事件拦截全部耦合进一个闭包，未来的横切关注点（重试、遥测、额外 header 逻辑）只能继续往里堆。
- 上游 `HttpAgent` 内部（`clone()` / `connectAgent()` / `abortRun()`）若假定 `run` 保持基类语义，升级时有脆弱性。

**建议**：把 `interceptRunEvents` 改写为真正的 `Middleware` 并通过 `agent.use()` 注册。

### 5. 动态 auth header 靠在 run() 覆盖内突变 `instance.headers` 实现 🔧 PLAUSIBLE

`apps/web/src/lib/runtime/use-thread-agent-runtime.ts:60`

`HttpAgent` 提供了 `protected requestInit(input: RunAgentInput): RequestInit` 作为文档化的每请求定制点。当前实现是在 run() 覆盖顶部读取 `useAuthStore.getState().token` 并副作用式重写共享的 `instance.headers` —— 它能工作仅仅因为 run() 恰好已被覆盖（与 #4 人为耦合）。

**建议**：用一个小的 `HttpAgent` 子类覆盖 `requestInit` 注入 token，使 header 注入与 run 逻辑解耦、可独立测试。

## 三、文件组织 / hooks 划分

### 6. hooks 归属规则不一致 📁 CONFIRMED

- `src/lib/runtime/use-thread-agent-runtime.ts` —— 该目录中唯一的 React hook，其余（`agent-run-interceptor.ts`、`thread-list-adapter.ts`、`thread-message.ts`、`thread-history-provider.tsx`）都是纯模块 / adapter / provider。
- `src/hooks/use-thread-run-status-monitor.ts`、`src/hooks/use-threads.ts` —— 同样是线程运行态相关的 hooks，却在另一个目录。

两个目录都没有 README 或注释说明放置规则，下一个 thread/runtime 相关 hook 的归属是 50/50 猜测。

**建议**（二选一并写进 CLAUDE.md 或目录 README）：

- 方案 A：`lib/runtime/` 只放非 hook 的 adapter / 纯模块，`use-thread-agent-runtime.ts` 移入 `hooks/`；
- 方案 B：所有 thread-runtime hooks 集中到 `lib/runtime/`。

### 7. 测试文件按"评审轮次"命名，且 normalizeHeaders 测的是本地副本 📁 CONFIRMED

`apps/web/src/__tests__/code-review-fixes.test.ts:5`

文件中 5 个被测对象有 4 个正确地从真实模块导入（`copyToClipboard`、`usernameSchema` / `passwordSchema` / `validationMessage`、`createThreadListAdapter`），但 `normalizeHeaders` 是内联重新实现的本地副本（第 5-16 行），未从任何生产模块导入——生产实现回归时这个测试照样通过，产生虚假信心。

**建议**：按被测单元拆分命名（如 `thread-list-adapter.test.ts`、`validation.test.ts`），`normalizeHeaders` 改为导入真实实现（若尚未导出则先导出）。

## 四、组件划分

### 8. `BranchPicker` 定义在 user-message.tsx 却被 assistant-message.tsx 跨模块引用 🧩 CONFIRMED

`apps/web/src/components/assistant-ui/user-message.tsx:21`

`BranchPicker` 是角色无关的原语包装（仅渲染 prev/next/count），却定义在 `user-message.tsx` 并被 `assistant-message.tsx:42` 导入，造成两个消息模块单向耦合：重构 `user-message.tsx` 会牵连 `assistant-message.tsx`。

**建议**：移到中立共享文件（`thread-utils.ts` 或独立 `branch-picker.tsx`）。

### 9. 复制按钮逻辑重复，且重造了上游原语 🧩 CONFIRMED

`apps/web/src/components/assistant-ui/assistant-message.tsx:269` / `user-message.tsx:51`

`AssistantCopyButton` 与 `UserCopyButton` 是同一套 `useState(copied)` + `handleCopy` + `copyToClipboard` + 2s 重置实现，仅文本提取不同（assistant 侧通过 `getProcessTitleTextParts` 过滤 process-title parts）。同时 `@assistant-ui/react` 本身提供 `ActionBarPrimitive.Copy`（含 `copiedDuration` / `isCopied` 状态）。

**建议**：抽 `useCopyMessageText(parts)` 共享 hook，或直接改用 `ActionBarPrimitive.Copy`。

另有一项较弱的候选保留备查：`EditComposer` 位于 `user-message.tsx` 而非 `thread-composer.tsx`。验证认为它只用于编辑用户消息、样式也按用户气泡定制，就地放置可辩护，维护成本主要是 import 语义略显别扭，不强制修改。

## 五、效率

### 10. 每次切换线程都全量重拉线程列表 ⚡ CONFIRMED

`apps/web/src/components/MyRuntimeProvider.tsx:40`

`adapter` 通过 `useMemo(() => createThreadListAdapter(...), [qc, urlThreadId])` 创建，`urlThreadId` 在每次 `/` ↔ `/t/$threadId` 导航时变化 → adapter 引用变化 → assistant-ui 的 `__internal_setOptions` 检测到 `adapterChanged`，重置 `_loadThreadsPromise` 并重新执行 `adapter.list()` → 每次打开/切换线程多发一次 `GET /api/v1/threads`，与 `useThreads()` 的 react-query 轮询完全重复。

`urlThreadId` 仅在 `onThreadArchived` 回调内部使用（`if (threadId !== urlThreadId) return`）。

**建议**：像 `navigateRef` 一样改用 ref 在回调内读取 `urlThreadId`，让 adapter 只依赖 `qc`（甚至零依赖），改动极小。

## 已驳回的候选（供参考）

| 候选 | 驳回理由 |
| --- | --- |
| `pendingTimersRef` 仅在卸载时清理，agent useMemo 重建时旧 timer 可能用旧 qc 触发 | 不可达：`qc` 是模块级单例 `queryClient`，`aui` 在单次挂载内由 tap 保持稳定，agent 不会在挂载期内重建 |
| `use-thread-run-status-monitor` 的空列表守卫与旧 `!threadsData` 检查语义不同 | 状态机完全等价：两者在"未加载"与"已加载但为空"两种情况下收敛到相同行为，无可观察差异 |

## 修复优先级建议

1. **小改动高收益**：#1（RUN_ERROR 兜底）、#10（adapter 依赖改 ref）、#2（恢复延迟 invalidate）。
2. **可合并为一个重构任务**：#4 + #5（middleware / requestInit 化）。
3. **约定类**：#6（hooks 归属规则定下来并写进文档）、#7、#8、#9 顺手做。
4. **确认意图即可**：#3（auth config 缓存是否有意）。
