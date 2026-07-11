# ADR-0001: 问答中断采用 AG-UI interrupt terminal model,SDK 侧保持 pause model

日期:2026-07-11
状态:已采纳

## 背景

AskUserQuestion / 工具权限审批原先走 pause model:问题挂起时 AG-UI run 不结束
(平台 run `requires_action` + `pendingUserAction=question`),原 SSE 保持打开,
回答走独立的 `POST /agent/reply` → `approval_resolved` 命令 → worker 内
`resolveQuestion` 解开挂起的 promise,继续在同一条 run 上流。

代价:resume 端点要对 requires_action 特判 409、前端刷新后要靠
`pendingQuestionRepliedConversations` 标记 + 手动 `resumeRun` 重连 + 删除卡在
running 的旧占位消息 + 409 退避重试,一整套跨组件的重连机器;历史加载还要把
消息状态归一化成 running 才能让待答 UI 接管。

AG-UI 协议自 0.0.57 起内建 interrupt terminal model:run 以
`RUN_FINISHED{outcome:{type:"interrupt",interrupts:[...]}}` 结束,答复作为新
run 的 `RunAgentInput.resume[]` 传入。`packages/react-ag-ui` 已实现完整客户端
(`submitInterruptResponses` 等)。

## 决策

**AG-UI 表现层采用 terminal model;worker/SDK 内部保持 pause model。**

- claude adapter 在问题挂起时向事件流发 `RUN_FINISHED{interrupt}`(interrupt
  带 id/reason/toolCallId/metadata.questions),结束当前 AG-UI run。SDK 的
  `canUseTool` promise 照旧挂起——claude SDK 不支持终止进程后凭 resume 注入
  tool result,平台 run 与 worker 必须保活。
- 答复 = `POST /agent/run` 携带 `resume[]`:server 校验后把新 SSE 附接到活跃
  run 的 handle,经 `approval_resolved`(新增 `resumeRunId`)下发;adapter 解开
  挂起前先以 `resumeRunId` 发 `RUN_STARTED`,续接事件归属新 AG-UI run。
- AskUserQuestion 与权限请求共用 per-thread 串行队列:一次只有一个 open
  interrupt(一个 RUN_FINISHED 只能发一次)。
- server 持久化保持「一条平台 run = 一条 assistant 消息」:聚合 wrapper 在
  RUN_STARTED(续接)前留存已产出 parts,build 时前置拼接;跨段
  TOOL_CALL_RESULT 补进留存段。局部保存保留 requires-action 状态
  (取消/出错时终局原因覆盖)。
- `POST /agent/reply` 端点删除;resume 端点对 requires_action 不再 409
  (防御性返回当前累积快照)。`conversation.pendingUserAction` 保留,作为
  轮询/侧边栏的状态缓存。

## 后果

- 前端重连机器整体删除(标记、手动 resumeRun、删占位消息、409 重试、
  历史加载状态归一化);刷新即普通历史加载,回答即普通新 run。
- 待答判定统一为消息 `requires-action`(reason interrupt)+
  `metadata.custom.agui.interrupts`,回答走
  `unstable_submitInterruptResponses`。
- 平台 run 状态机(requires_action ↔ running、pendingUserAction 通道)不变;
  事件与状态走同一条上行通道,adapter 先发 interrupt 收尾再置 pendingAction,
  FIFO 保证局部保存带上 interrupts。
- 已知边界:run 在问答挂起中被 stop 时,存活页面的待答卡片要等重新加载才会
  消失(与迁移前一致);resume[] 目前只接受 `status:"resolved"`(取消语义由
  问题选项自身承载,如权限的「拒绝」)。
