# Agent / Run / Runtime / Worker 分层整理方案

> 唯一目标：职责清晰 + 层次清晰。其余都是手段。  
> 这不是 DDD 重构，也不是把每个动作拆成独立 use case。轻量、集中、好读即可。

## 0. 关键结论

默认采用 **低风险路线 Y**：

```text
先用目录 + facade service + import 规则整理边界。
第一轮只做目录和 service 边界整理：run 相关文件迁到 runs/，runtime 保留执行环境相关文件。
暂不强拆 RunModule / RuntimeModule。
暂不改 worker event 回流 transport。
暂不引入 RuntimeWorkerHooks / RuntimeHooksRegistry。
```

原因：当前最痛的是文件分散、职责不清，而不是 Nest module 级别的编译期强隔离。强拆成两个 Nest module 会迫使我们重做事件回流端口反转，这是本方案里风险最高的一刀，不应该作为第一轮默认动作。

## 1. 判断标准

落任何一刀前问两句，两句都过才动：

1. **职责清晰**：这块代码是谁的活，能一句话说清吗？
2. **层次清晰**：上层是不是只调下层门面，而不是伸手 import 下层内部实现？

本轮不追求理论最纯的 module 隔离。先追求：

```text
AgentService -> RunService -> RuntimeService -> RuntimeProvider -> Worker
```

## 2. 分层定义

### Agent 层

只负责组装 agent 运行参数。

职责：

- 解析 `agentType`
- 解析 `modelProviderId` / `model`
- 处理 permission 默认值
- 处理 agent session / resume 参数
- 产出 placement-free 的 `AgentSpec`
- 调 `RunService.start`

不负责：

- 不创建 Run 记录
- 不管理 SSE
- 不处理 worker envelope
- 不组装完整 `RunConfig`
- 不碰 runtime placement
- 不 import runtime providers

### Run 层

负责一次 run 的生命周期。

职责：

- 创建 Run 记录
- 设置 conversation active run 状态
- 保存 user message
- 触发标题生成
- 调 `RuntimeService.resolvePlacement`
- 组装 `RunConfig`
- 调 `RuntimeService.startWorker`
- stop / resume stream / approval reply
- 处理 worker envelope
- 更新 run status
- 聚合 assistant message
- 写 RunEvent / raw log
- 推 SSE

不负责：

- 不知道 worker 是 fork 还是 container
- 不知道 docker / opensandbox 细节
- 不直接调用 Claude/Codex adapter SDK

### Runtime 层

负责执行环境和 worker 管理。

职责：

- runtime placement
- runtime path / host path / mount target
- local worker 启动
- sandbox worker 启动
- control 下发
- heartbeat
- provider cleanup
- runtime resource lifecycle
- internal runtime access / config / control queue

不负责：

- 不保存 conversation message
- 不生成标题
- 不聚合 assistant-ui content
- 不写业务语义 RunEvent
- 不知道 agent 选择逻辑

### Worker 层

执行进程，不是业务控制层。

职责：

- 拉取 `RunConfig`
- 创建 Claude/Codex adapter
- 执行 adapter run
- 处理 cancel / approval / user_message control
- 上报 `agui.event`
- 上报 `run.status`
- 上报 heartbeat

不负责：

- 不访问 Prisma
- 不知道用户权限
- 不决定 placement
- 不判断 model provider 是否可用
- 不 import `apps/api`

## 3. 主调用链

启动 run：

```text
AgentController
  -> AgentService.run()
    -> RunService.start()
      -> RuntimeService.resolvePlacement()
      -> RunConfigAssembler.assemble()
      -> RuntimeService.startWorker()
        -> RuntimeProvider.start()
          -> apps/worker
```

停止 run：

```text
AgentController
  -> AgentService.stop()
    -> RunService.stop()
      -> RuntimeService.cancel()
        -> RuntimeProvider.cancel()
          -> worker control
```

worker 事件回流，本轮保持现状，不改 transport：

```text
apps/worker
  -> Runtime internal API / IPC
    -> RunEnvelopeProcessor
      -> RunRepository / RunMessageAggregator / RunEventRecorder / SSE
```

说明：这条回流现在是 `runtime provider/internal -> RunEnvelopeProcessor`。在一个 Nest module / 组合 module 内，它不会制造 Nest module 循环。第一轮先不动它，避免引入高风险行为变化。

## 4. 目标目录结构

一个模块一个集中 Service，复杂协作者按角色收进子目录。目录先拆清楚，Nest module 第一轮明确仍由现有 `RuntimeModule` 作为组合 module 统一组装并导出 `RunService` / `RuntimeService`，`AgentModule` 继续 import `RuntimeModule`。不把 module 强隔离作为第一轮目标。

```text
apps/api/src/
  agent/
    agent.module.ts
    agent.controller.ts
    agent.service.ts
    agent-spec.builder.ts
    agent-permission-options.ts
    dto/

  runs/
    run.service.ts
    run-config.assembler.ts
    run-service.types.ts
    run.repository.ts
    run-recovery.use-case.ts
    title.service.ts             # 原 agent/title.service；标题由 RunService.start 触发

    execution/
      run-envelope.processor.ts
      run-execution-status.handler.ts
      run-lifecycle.policy.ts
      run-message.aggregator.ts
      run-usage.mapper.ts
      run-active.store.ts

    events/
      run-event-recorder.ts
      run-event-query.ts
      run-event-facts.ts
      run-event-normalizer.ts
      raw-event-log.writer.ts

    admin/
      admin-run.controller.ts

  runtime/
    runtime.module.ts
    runtime.service.ts
    runtime-placement.policy.ts

    providers/
      runtime-provider-registry.ts
      runtime-provider.token.ts
      local-runtime-provider.ts
      sandbox-runtime-provider.ts
      sandbox-engine/
        index.ts
        docker-sandbox-engine.ts
        opensandbox-sandbox-engine.ts

    resources/
      runtime-resource-lifecycle.use-case.ts
      workspace-runtime.repository.ts

    internal/
      runtime-internal.controller.ts
      runtime-runtime.controller.ts
      runtime-workspace.controller.ts
      runtime-control-queue.ts
      runtime-config-store.ts
      runtime-internal-access.service.ts
      runtime-internal-auth.guard.ts

    admin/
      admin-runtime.controller.ts
```

规则：

- 根目录只放门面 service、types、repository 这类高频入口。
- 有状态、成团协作者才进子目录。
- 不为了“分层好看”制造单文件目录。
- 不拆 `start-run.use-case.ts` / `stop-run.use-case.ts` 这类小文件。
- **第一轮不新增 `runs/run.module.ts`**：`runs/` 只是目录边界，由现有 `RuntimeModule` 作组合 module 统一组装。看到 `runs/` 没有 module 文件是有意为之——别照目录补一个，那会把你推向 §8 的 X 路线（拆 module → 必须做端口反转）。

## 5. Service 职责集中

### AgentService

```ts
class AgentService {
  run(input): Promise<void>;
  resumeStream(input): Promise<void>;
  reply(input): Promise<void>;
  stop(input): Promise<void>;
}
```

内部做：

- 从 request body / conversation 解析 agent 配置
- `AgentSpecBuilder.build()` 产出 `AgentSpec`
- 组 `StartRunInput`
- 调 `RunService`

### RunService

```ts
class RunService {
  start(input: StartRunInput): Promise<void>;
  stop(conversationId, options?): Promise<boolean>;
  resumeStream(conversationId, stream): Promise<void>;
  resolveApproval(conversationId, answers): Promise<void>;
}
```

内部组合：

- `RunConfigAssembler`
- `RunRepository`
- `RunActiveStore`
- `RunMessageAggregator`
- `RunEventRecorder`
- `RuntimeService`

**入站管线组件（与 RunService 平级，不塞进 RunService）**：

- `RunEnvelopeProcessor`
- `RunExecutionStatusHandler`
- `RawEventLogWriter`

它们是 worker event 回流这条入站链路的组件，本轮仍由 runtime provider / internal controller 按现有路径调用，并与出站侧的 `RunService` 共享 `RunActiveStore`、`RunRepository`、`RunMessageAggregator` 等协作者。出站（start/stop）归 RunService，入站（envelope 处理）归这组——同属 `runs/` 层，只是职责一进一出。

`RunEventRecorder` 是**出入站共享的记录器**：所以它既在 `RunService` 内部组合里、也被入站组件用——`RunService` 用它记出站事实（run created / message accepted），processor 用它记入站事实（status / agui / control trace）。这就是它在列表里、而 `RawEventLogWriter`（只入站写 raw/agui 日志）不在的原因。

### RuntimeService

```ts
class RuntimeService {
  resolvePlacement(input): RuntimePlacement;
  startWorker(runConfig, placement, onReady?): RuntimeHandle;
  sendControl(handle, control): void;
  cancel(handle): void;
  cleanup(runId): void;
  heartbeat(runId): void;
}
```

内部组合：

- `RuntimePlacementPolicy`
- `RuntimeProviderRegistry`
- `RuntimeConfigStore`
- `RuntimeControlQueue`
- `RuntimeInternalAccessService`

`heartbeatWorkspace` / `heartbeatRuntimeResource` / resource lifecycle 可以继续留在 `resources/` 子服务里，`RuntimeService` 需要时委托。

`RuntimeConfigStore` / `RuntimeControlQueue` / `RuntimeInternalAccessService` 都在 `runtime/internal/`。**`RuntimeService`（也在 `runtime/`）import 它们是同层内部访问，合法**；§6 "runs 不可 import runtime/internal" 约束的是 `runs/` 层——`RunService` 只能经 `RuntimeService` facade 间接用到这些，不得直接 import `runtime/internal/**`。即：**internal 只对 RuntimeService 与同层 controller 开放，对 runs 关闭。**

## 6. Import 规则

第一轮靠 import 规则保证边界，而不是靠强拆 Nest module。

```text
agent 可 import:
  runs/run.service
  shared types
  model-provider / conversation 等业务 service

agent 不可 import:
  runtime/**
  runs/execution/**
  runs/events/**

runs 可 import:
  runtime/runtime.service
  shared protocol types
  conversation service 或后续收窄 gateway

runs 不可 import:
  runtime/providers/**
  runtime/internal/**

runtime 可 import:
  shared protocol types
  config service
  runtime 自己的 providers/resources/internal

runtime 第一轮允许内部 provider/internal 调用 runs/execution/run-envelope.processor
  这是现有事件回流路径，暂不改 transport

worker 不可 import:
  apps/api/**

adapters 不可 import:
  apps/api/**
  apps/worker/**
```

建议在整理稳定后用 `dependency-cruiser` 或 eslint `no-restricted-imports` 卡住这些规则。第一轮可以先人工执行，等目录迁移完成后再上 CI 规则。

## 7. 迁移步骤：默认低风险路线 Y

### Step A — 目录搬迁

把现有 run 生命周期相关文件从 `runtime/core` 搬到 `runs/`：

```text
runtime/core/run-execution -> runs/execution
runtime/core/runs          -> runs/
runtime/core/run-events    -> runs/events
```

只做 `git mv` + import 更新，不改逻辑。

验证：

```bash
pnpm --filter api typecheck
```

必要时跑相关精准测试。按项目约定，不自动跑 build/lint/e2e。

### Step B — 劈开 RunConfig 组装

先把当前 `AgentRunConfigBuilder` 拆出两个明确职责：

```text
agent/agent-spec.builder.ts
  只解析 agent/model/permission/session，产出 AgentSpec

runs/run-config.assembler.ts
  接收 AgentSpec + placement + run/conversation/workspace 信息，产出 RunConfig
```

这样后续 `RunService.start` 可以直接使用 `AgentSpec + RuntimeService.resolvePlacement + RunConfigAssembler`，不用先建一个空壳再返工。若为了降低过渡风险，可以临时保留旧 `AgentRunConfigBuilder.buildRunConfig` 的兼容 shim，等 Step E 收薄 agent 层后再删除。

### Step C — 建 RuntimeService 门面

把 runtime 对上层需要暴露的能力收进 `RuntimeService`：

- `resolvePlacement`
- `startWorker`
- `sendControl`
- `cancel`
- `cleanup`
- `heartbeat`

`RunService` 只调 `RuntimeService`，不直接调 provider / registry / sandbox engine。

**Step C 验收**：本步只把 provider/placement/control 等能力**包一层 facade**，`RuntimeService` 可先直接转调现有 `RuntimeProviderRegistry`/`RuntimePlacementPolicy`。调用方暂不切——`RunRunner`/`AgentRunHandler` 继续走旧路径；到 Step D 才把 `RunService` 接到 `RuntimeService`。所以 Step C 完成时 `RuntimeService` 可以"还没有上层调用者"，这是预期的。

### Step D — 建 RunService 门面，并吸收 run 编排

`RunService` 不是 `RunRunner` 的简单改名。它要同时吸收两部分能力：

```text
1. 现 RunRunner 的对外能力：
   start / stop / resumeStream / resolveApproval

2. 现 AgentRunHandler.run 里属于 run 编排的部分：
   runtime/isolation 校验
   placement 计算
   RunConfig 组装
   activeRunStatus 并发守卫
   user message 持久化
   RunMessageAggregator 创建
   saveRun 闭包
   onAgentSessionId 回调 / agent session 回写（conversationService.setAgentSessionId）
   TitleService 触发
   调 RuntimeService.startWorker
```

完成后，外部模块只依赖 `RunService`，不再 deep import `RunRunner` / `RunActiveStore` / `RunEnvelopeProcessor`。

**保护（别顺手把入站也搬进来）**：`RunService.start` 只承接**出站启动编排**（上面列的两部分）。**不要接管 `RunEnvelopeProcessor.publish` 这条入站路径**——worker event 回流仍由 `provider/internal controller → RunEnvelopeProcessor` 不变。吸收的是"怎么把 run 起起来"，不是"怎么处理回流事件"。

### Step E — 收薄 Agent 层

`AgentService` / 原 `AgentRunHandler` 只做：

```text
请求解析
conversation/workspace 信息读取
AgentSpec 构造
StartRunInput 构造
调用 RunService.start
```

删除 agent 层里的：

- placement 计算
- `RunMessageAggregator` 创建
- `saveRun` 闭包拼装
- run 状态更新
- runtime provider 调用
- 标题生成触发；`TitleService` 随触发点迁到 `runs/title.service.ts`，由 `RunService.start` 调用

这些都回到 Run 层或 Runtime 层。

### Step F — 上 import 规则

当 A-E 稳定后，上 dependency-cruiser / eslint 规则，禁止重新 deep import。

## 8. 可选强隔离路线 X

只有在默认路线 Y 完成后，仍然明确需要 Nest module 级强隔离，才考虑 X。

X 的目标：

```text
runs/ 拆成 RunModule
runtime/ 拆成 RuntimeModule
RunModule import RuntimeModule
RuntimeModule 不 import RunModule
```

这会要求重做 worker 事件回流端口反转，例如：

```text
RunService.start 注册 RuntimeWorkerHooks
RuntimeProvider / RuntimeInternalController 只调 RuntimeHooksRegistry
RuntimeHooksRegistry 再回调 Run 层 hooks
```

这条路线风险更高，因为会改到：

- local IPC worker event path
- HTTP internal worker event path
- worker exit error path
- heartbeat timeout path
- terminal status / cleanup / unregister 顺序

升级到 X 的触发条件：

1. Y 完成后，import 规则仍无法阻止边界持续腐化；
2. runtime provider 需要独立复用或替换；
3. 事件回流路径已有足够测试覆盖；
4. 团队明确接受修改 worker event transport 的行为风险。

本轮不做 X。

## 9. 不做什么

- 不引入完整 DDD 目录。
- 不把每个动作拆成一个 use case 文件。
- 不为了 DI 纯洁度添加一堆 interface/token/provider。
- 不改 worker/adapters 的部署边界。
- 不改协议字段。
- 不做 RuntimeWorkerHooks / RuntimeHooksRegistry。
- 不把 `RuntimeProvider` / `RuntimeHandle` / `RuntimePlacement` 从 shared 迁出，除非未来走强隔离路线 X。
- 不做事件审计订阅化。

## 10. 评审关注点

希望评审重点看：

1. 低风险路线 Y 是否已经满足“职责清晰 + 层次清晰”。
2. `AgentService -> RunService -> RuntimeService` 这条主链是否足够直观。
3. 哪些文件应进入 `runs/`，哪些应留在 `runtime/`。
4. import 规则是否足够约束边界。
5. 是否真的需要未来路线 X，还是 Y 已经够用。
