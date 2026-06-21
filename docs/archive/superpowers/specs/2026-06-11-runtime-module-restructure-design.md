# Runtime 模块重构设计 — runs/ + runtime/ 合并与分层

> **前置文档**：
> - `docs/superpowers/specs/2026-06-10-agent-runtime-infrastructure-design-v2.md` — 总体架构设计
> - `docs/superpowers/specs/2026-06-10-agent-runtime-phase3-worker-process-design.md` — Phase 3 实现
> - `docs/superpowers/specs/2026-06-10-agent-runtime-phase4-docker-http-design.md` — Phase 4 实现

## 背景与目标

Phase 3/4 完成后，`apps/api/src/runs/` 与 `apps/api/src/runtime/` 之间出现了边界模糊和循环依赖：

- `RunsModule` 与 `RuntimeModule` 互相 `forwardRef`。
- `DockerProvider` 放在 `runs/`，却依赖 `runtime/` 的 `RuntimeTokenService`、`ControlQueue`。
- `RuntimeController`（`runtime/`）反过来依赖 `runs/` 的 `RunEventBus`、`RunService`、`DockerProvider`。
- `RunService` 身兼 DB repository 和内存 `runConfigRegistry`（仅供 Docker provider 使用）两种角色。
- `AgentController.run()` 承担了过多编排职责（创建 Run、注册 EventBus context、启动 provider、注册 RunRegistry、SSE 生命周期管理等），文件超过 300 行。

本次重构的目标：

1. 把"如何运行 Run"（provider、内部 worker API、运行时状态）整体收进单一的 `runtime/` 模块。
2. 消除模块间循环依赖，依赖方向变为单向：`agent/` → `runtime/` → `threads/`。
3. `RunService` 只保留 DB CRUD 职责，内存态拆分为独立 service。
4. `AgentController` 瘦身为参数解析 + RunConfig 构建 + 调用 `runtime/` 门面 service，不再直接操作 `RunRegistry` / `RuntimeProviderRegistry` / `RunEventBus`。

## 范围

**本期做**：
- ✅ 合并 `apps/api/src/runs/` 与 `apps/api/src/runtime/` 为单一 `apps/api/src/runtime/` 模块，按 `domain/` `providers/` `internal-api/` 分子目录
- ✅ 拆分 `RunService` 的内存 `runConfigRegistry` 为独立的 `RunConfigStore`
- ✅ 新增 `RunLauncherService`，承接 `AgentController` 中的运行编排逻辑
- ✅ 调整 `AppModule` 及相关 import 路径
- ✅ 迁移现有 spec 文件，补充 `RunConfigStore` 的测试

**本期不做**：
- 🚫 改变 `@agework/protocol` 中的接口定义（`RuntimeProvider` / `RuntimeTransport` / `RunConfig` 等不变）
- 🚫 改变 `apps/worker` 实现
- 🚫 改变数据库 schema
- 🚫 改变现有业务行为 / API 响应格式（纯内部结构重构）

## 目标结构

```
apps/api/src/runtime/
├── domain/
│   ├── run.service.ts            # Run 表 CRUD（去掉 runConfigRegistry）
│   ├── run.service.spec.ts
│   ├── run-registry.service.ts   # 内存 handle 注册表
│   ├── run-registry.service.spec.ts
│   ├── run-event-bus.service.ts  # 上行事件处理（run.status/heartbeat/agui.event）
│   └── run-event-bus.service.spec.ts
├── providers/
│   ├── runtime-provider.registry.ts
│   ├── runtime-provider.registry.spec.ts
│   ├── local-process-provider.service.ts
│   ├── local-process-provider.service.spec.ts
│   ├── docker-provider.service.ts
│   ├── run-config-store.service.ts       # 新增：内存 RunConfig 暂存
│   ├── run-config-store.service.spec.ts  # 新增
│   └── provider-helpers.ts               # HeartbeatWatchdog / nextControlEnvelope / publishWorkerErrorStatus
├── internal-api/
│   ├── runtime.controller.ts     # /internal/runs/*，仅供 worker 调用
│   ├── runtime-auth.guard.ts
│   ├── runtime-token.service.ts
│   ├── runtime-token.service.spec.ts
│   ├── control-queue.service.ts
│   └── control-queue.service.spec.ts
├── run.controller.ts              # /runs/admin/list（管理端列表）
├── run-launcher.service.ts        # 新增：运行编排门面
└── runtime.module.ts
```

`apps/api/src/agent/` 保持现有文件集合不变（`agent.controller.ts`、`agent.service.ts`、`run-aggregator.ts`、`title.service.ts`、`agent-trace-logger.ts` 及其 spec），仅 `agent.controller.ts` 内容瘦身、`agent.module.ts` 的 import 从 `RunsModule` 改为 `RuntimeModule`。

## 1. `RunConfigStore`（新增）

从 `RunService` 中拆出的纯内存 Map，职责单一：

```ts
// runtime/providers/run-config-store.service.ts
@Injectable()
export class RunConfigStore {
  private readonly configs = new Map<string, RunConfig>();

  register(runId: string, config: RunConfig): void;
  get(runId: string): RunConfig | undefined;
  unregister(runId: string): void;
}
```

使用方：
- `DockerProvider.start()` → `register()`
- `DockerProvider.cleanup()` → `unregister()`
- `RuntimeController.getRunConfig()` → `get()`

`RunService` 删除 `registerRunConfig` / `getRunConfig` / `unregisterRunConfig` 三个方法及对应内存字段，只保留 Run 表 CRUD（`create` / `markRunning` / `markCancelling` / ... / `listAdmin`）。

## 2. `RunLauncherService`（新增）

承接 `AgentController` 中与"运行一个 Run"相关的编排逻辑，是 `runtime/` 模块对外的主要入口：

```ts
// runtime/run-launcher.service.ts
@Injectable()
export class RunLauncherService {
  constructor(
    private readonly runService: RunService,
    private readonly runRegistry: RunRegistry,
    private readonly runEventBus: RunEventBus,
    private readonly runtimeProviderRegistry: RuntimeProviderRegistry,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 创建 Run 记录、注册 EventBus context、选择并启动 provider、
   * 注册 RunRegistry、绑定 SSE 关闭回调。
   * 失败时负责回滚（markError / unregisterContext / 结束 SSE）。
   */
  async start(params: {
    runId: string;
    threadId: string;
    projectId: string;
    userId: string;
    agentType: string;
    runConfig: RunConfig;
    res: Response;
    aggregator: RunAggregator;
    saveRun: (complete: boolean) => void;
    onAgentResumeId?: (resumeId: string) => void;
  }): Promise<void>;

  /** question-answer 端点：找到 thread 的 active run handle，下发 approval_resolved control */
  sendApprovalResolved(threadId: string, answers: Record<string, string | string[]>): void;

  /** stop 端点：标记 cancelling/finished 并下发 cancel control（或在无 handle 时直接收尾） */
  async stop(threadId: string, currentRunStatus: string): Promise<void>;
}
```

`AgentController` 中三个端点改为：

- `POST /agent/run`：解析参数、`agentService.buildRunConfig()`、设置 SSE headers、`threadService.saveUserMessage` / `setRunStatus`、`titleService.maybeGenerate`，最后调用 `runLauncher.start(...)`。
- `POST /agent/threads/:threadId/question-answer`：直接调用 `runLauncher.sendApprovalResolved(threadId, body.answers)`。
- `POST /agent/threads/:threadId/stop`：直接调用 `runLauncher.stop(threadId, thread.runStatus)`。

`res.on("close")` 的处理（把 `handle.res` 和 `ctx.res` 置空）下沉到 `RunLauncherService.start()` 内部。

## 3. 模块依赖与 `runtime.module.ts`

```ts
@Module({
  imports: [ThreadModule, JwtModule.register({ secret: ... })],
  controllers: [RunController, RuntimeController],
  providers: [
    // domain
    RunService, RunRegistry, RunEventBus,
    // providers
    RunConfigStore, LocalProcessProvider, DockerProvider, RuntimeProviderRegistry,
    // internal-api
    RuntimeTokenService, RuntimeAuthGuard, ControlQueue,
    // facade
    RunLauncherService,
  ],
  exports: [RunService, RunLauncherService],
})
export class RuntimeModule implements OnModuleInit {
  // onModuleInit 中的 recoverOrphanRuns() 逻辑原样保留（来自原 RunsModule）
}
```

`AgentModule` 的 `imports` 从 `[ThreadModule, RunsModule]` 改为 `[ThreadModule, RuntimeModule]`，`AppModule` 中移除对 `RunsModule` 的注册（如果存在单独注册）。不再需要任何 `forwardRef`。

## 4. 迁移步骤概览

1. 创建 `runtime/domain/`、`runtime/providers/`、`runtime/internal-api/` 目录，`git mv` 现有文件到新位置（含 spec）。
2. 新建 `RunConfigStore` 及其 spec；从 `RunService` 中删除相关方法和字段，更新 `DockerProvider` / `RuntimeController` 的依赖注入。
3. 新建 `RunLauncherService`，把 `AgentController.run()` / `answerQuestion()` / `stop()` 中的编排逻辑迁移过去；`AgentController` 瘦身。
4. 合并 `runtime.module.ts`，删除 `runs.module.ts`，调整 `AgentModule` 及 `AppModule` 的 import。
5. 修正所有受影响文件的相对 import 路径（`../runs/...` → `../runtime/domain/...` 等）。
6. 运行 `pnpm typecheck`、`pnpm test:api`，确认行为不变。

## 测试策略

- 现有 spec 随源文件迁移，仅调整 import 路径，断言逻辑不变。
- `run.service.spec.ts` 中关于 `runConfigRegistry` 的用例迁移到新的 `run-config-store.service.spec.ts`。
- `RunLauncherService` 新增 spec，覆盖：正常 start 流程、provider.start 抛错时的回滚（markError + unregisterContext + 结束 SSE）、`sendApprovalResolved` 找不到 handle 时的 NotFoundException、`stop` 在有/无 active handle 两种路径。
- 不新增端到端/集成测试，依赖现有 `pnpm test:api` 覆盖回归。
