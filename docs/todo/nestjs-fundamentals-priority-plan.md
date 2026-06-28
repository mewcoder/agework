# NestJS Fundamentals 优先级 TODO

**Goal:** 对照 NestJS 官方 Fundamentals，把当前 `apps/api` 已用、未用但可能需要、暂时不建议引入的 Nest 容器与架构基础能力按优先级沉淀下来。

**Scope:** NestJS API (`apps/api`)。本 TODO 关注 Nest 基础机制：module/provider/DI/lifecycle/testing/execution context 等，不覆盖 Techniques 里的队列、缓存、调度、HTTP module 等功能型模块。

**Current baseline:**
- 已有标准 feature module、controller、service、repository 组织。
- 已有 custom provider token：`RUN_EXECUTORS`、`RUNTIME_PROVIDERS`、`SANDBOX_ENGINES`、`OPENSANDBOX_CLIENT`。
- 已用 `ExecutionContext`、`ArgumentsHost`、`Reflector` 构建 guard/interceptor/filter/decorator。
- 已用 `OnModuleInit`、`OnApplicationBootstrap`、`OnModuleDestroy`，并已在 `main.ts` 开启 `app.enableShutdownHooks()`。
- 未使用 `forwardRef`、`ModuleRef`、`LazyModuleLoader`、request scope、`DiscoveryService`。

## P0 - 优先研究 / 最贴近当前 run-runtime-worker 风险

### 1. Lifecycle shutdown / graceful cleanup

**Status:** Done (2026-06-28)

落点与决策：
- **run 状态走「恢复后处理」**，shutdown 期不写 DB。`RunRecoveryService.recoverInterruptedRuns()`（启动时跑）
  已完整地清残留 active run 的进程/容器、标 run/conversation 为 error、恢复孤儿/stale runtime 资源。
- 给 3 个持有状态的 provider 加 `OnApplicationShutdown`（最佳努力、不阻塞）：
  - `LocalRunExecutor`：SIGTERM 所有在途子进程，避免孤儿（fork 的 worker 不随 API pid 退出）。
  - `WorkerCommandQueue`：drain 所有 long-poll waiter（timer 未 unref，会拖住退出）+ 清队列。
  - `LiveRunRegistry`：清所有超时 timer（已 unref 不阻塞，但避免 shutdown 中误触发 timeout sink）。
- **sandbox 持久容器不动**：故意留给重启恢复（孤儿容器由 RunRecoveryService 清，符合「重启清而非复用」）。
- `WorkerEventService` 的 completedRuns timer 已 unref、无害，不处理；Prisma 仍用既有 `OnModuleDestroy`。
- 单测覆盖三个 hook（local.executor / command-queue / live-run.registry spec）；SIGTERM 全链路留手动验证。

**Objective:** 在现有 lifecycle hook 基础上，补齐应用退出时的 run、worker、sandbox、timer、waiter 清理策略。

**Nest doc:** [Lifecycle events](https://docs.nestjs.com/fundamentals/lifecycle-events)

**Why now:**
- 当前已经开启 `app.enableShutdownHooks()`。
- `PrismaService` 已实现 `OnModuleDestroy`，但 active run、local worker process、sandbox runtime、command queue waiter、timeout timer 等还需要明确退出语义。
- 这和 run/runtime/worker 架构可靠性直接相关。

**Tasks:**
- 盘点退出时需要处理的资源：
  - active local worker process
  - sandbox runtime / persistent worker
  - live run timeout timer
  - worker command long-poll waiter
  - run event finalization / interrupted recovery marker
- 决策使用 `BeforeApplicationShutdown`、`OnApplicationShutdown`，还是现有 service cleanup 方法组合。
- 定义 shutdown 超时和 best-effort 策略。
- 明确 SIGTERM/SIGINT 下 run 状态如何落库：interrupted、error、cancelled 或恢复后处理。

**Likely paths:**
- `apps/api/src/main.ts`
- `apps/api/src/prisma/prisma.service.ts`
- `apps/api/src/run/run.module.ts`
- `apps/api/src/run/live-run/live-run.registry.ts`
- `apps/api/src/run/execution/local.executor.ts`
- `apps/api/src/run/execution/sandbox.executor.ts`
- `apps/api/src/worker-host/command-queue.ts`
- `apps/api/src/runtime/sandbox/sandbox-instance.service.ts`

**Verification:**
- 单测覆盖 cleanup 方法被调用。
- 精准集成测试或手动验证 SIGTERM 下 Prisma disconnect、worker cleanup、timer cleanup。
- 重启后 `RunRecoveryService` 能恢复或收敛中断 run。

### 2. TestingModule wiring tests

**Status:** Done (2026-06-28)

**Objective:** 保持大部分单测直接 new service 的速度，只给高风险 Nest DI wiring 补少量 `@nestjs/testing` 测试。

**Nest doc:** [Testing](https://docs.nestjs.com/fundamentals/testing)

**Why now:**
- 当前 provider token 和 `useFactory` 数量增加。
- 直接 new service 能测业务逻辑，但测不到 module imports/exports/provider token wiring。
- `RunsModule`、`RuntimeModule`、`AuthModule` 这类模块一旦 wiring 错，运行期才暴露。

**Tasks:**
- 为高风险 module 增加最小 wiring test：
  - `RuntimeModule`：`SANDBOX_ENGINES`、`RUNTIME_PROVIDERS`、`OPENSANDBOX_CLIENT`
  - `RunsModule`：`RUN_EXECUTORS`、`RunExecutorRegistry`、`RunService`
  - `AuthModule`：`APP_GUARD`、`JwtModule`、`ThrottlerModule`
- 测试只验证 DI 能 compile、关键 provider 可 resolve、exports 可被下游 module 使用。
- 不把所有 service 单测改成 TestingModule，避免测试变慢和样板化。

**Likely paths:**
- `apps/api/src/runtime/runtime.module.ts`
- `apps/api/src/run/run.module.ts`
- `apps/api/src/auth/auth.module.ts`
- `apps/api/src/**/*.spec.ts`

**Verification:**
- `Test.createTestingModule(...).compile()` 能发现缺失 provider / token。
- mock 外部重资源，如 Prisma、OpenSandbox、worker execution。

**Completed:**
- 新增 `apps/api/src/runtime/runtime.module.spec.ts`，覆盖 `SANDBOX_ENGINES`、`RUNTIME_PROVIDERS`、`OPENSANDBOX_CLIENT`、`RuntimeService` / `RuntimeProviderRegistry` export。
- 新增 `apps/api/src/run/run.module.spec.ts`，覆盖 `RUN_EXECUTORS`、`RunExecutorRegistry`、`RunService` export，并验证 `RunsModule.onModuleInit()` 的 startup wiring。
- 新增 `apps/api/src/auth/auth.module.spec.ts`，覆盖 `APP_GUARD` 全局 guard、`JwtModule`、`ThrottlerModule`、`AuthService` export。

**Verified with:**
- `./node_modules/.bin/vitest run src/runtime/runtime.module.spec.ts src/run/run.module.spec.ts src/auth/auth.module.spec.ts`
- `./node_modules/.bin/tsc --noEmit`

## P1 - DI 规范和可维护性

### 3. Custom provider token 规范化

**Objective:** 统一 custom provider token 的命名、位置、数组 provider 约束和测试习惯。

**Nest doc:** [Custom providers](https://docs.nestjs.com/fundamentals/custom-providers)

**Why now:**
- 当前已经有多个 token registry / array provider。
- 这些 token 是 runtime / run 可扩展性的核心，值得形成规则，避免后续 provider 增加时变乱。

**Tasks:**
- 约定 token 命名：全大写常量、按 owner 放置、避免字符串散落。
- 约定 array provider 的顺序是否有意义；如果有，写清排序规则。
- 在 registry 中检测重复 `runtimeType` / `executor type` / `engine type`。
- 给每个 token provider 增加 focused unit test。

**Likely paths:**
- `apps/api/src/run/execution/executor.registry.ts`
- `apps/api/src/runtime/providers/provider-registry.ts`
- `apps/api/src/runtime/sandbox/sandbox-engine.ts`
- `apps/api/src/runtime/runtime.module.ts`
- `apps/api/src/run/run.module.ts`

**Verification:**
- 单测覆盖重复 provider 被拒绝。
- 单测覆盖未知 provider type 给出清晰错误。

### 4. Async providers

**Objective:** 仅当外部 client 初始化需要异步握手、健康检查或配置校验时，再引入 async provider。

**Nest doc:** [Async providers](https://docs.nestjs.com/fundamentals/async-providers)

**Current decision:**
- 当前 `useFactory` 基本同步，保持简单即可。

**Trigger:**
- OpenSandbox client、数据库 adapter、模型 provider SDK client 需要启动时异步初始化。
- 启动期必须验证外部依赖可用性。

**Tasks when triggered:**
- 评估 async provider 是否会拖慢启动。
- 给外部依赖失败定义 fail-fast 或 degraded mode。
- 避免在 provider factory 里执行过重业务逻辑。

### 5. Dynamic modules

**Objective:** 只有当模块需要可配置复用时，再抽 dynamic module。

**Nest doc:** [Dynamic modules](https://docs.nestjs.com/fundamentals/dynamic-modules)

**Current decision:**
- 当前业务 module 是单应用内部 feature module，不需要自建 dynamic module。

**Trigger:**
- `runtime`、`worker-host`、`config` 要抽成可复用 package。
- 同一个 module 需要在不同 app 中用不同 provider 配置。

**Tasks when triggered:**
- 设计 `forRoot` / `forRootAsync` 输入类型。
- 避免 dynamic module 隐藏模块边界和跨模块依赖。

## P2 - 条件触发 / 谨慎使用

### 6. Injection scopes

**Objective:** 默认继续使用 singleton scope，避免 request scope 带来性能和隐式依赖成本。

**Nest doc:** [Injection scopes](https://docs.nestjs.com/fundamentals/injection-scopes)

**Current decision:**
- 当前通过 `@CurrentUser()` 显式把 user/request 信息传入 service，更清楚。
- 不建议为了方便读取 request 而引入 request-scoped provider。

**Trigger:**
- 明确存在 per-request provider 状态，且不能通过显式参数表达。

### 7. ModuleRef

**Objective:** 暂不引入运行期 service locator，继续使用显式 DI 和 registry。

**Nest doc:** [Module reference](https://docs.nestjs.com/fundamentals/module-ref)

**Current decision:**
- 当前 `RuntimeProviderRegistry`、`RunExecutorRegistry` 比 `ModuleRef.get()` 更可读。

**Trigger:**
- 确实需要运行期按 token/class 动态解析 provider，且 registry 无法表达。

**Guardrail:**
- 不用 `ModuleRef` 绕过模块边界。
- 不用 `ModuleRef` 解决循环依赖；循环依赖应重画边界。

### 8. DiscoveryService

**Objective:** provider 数量明显变多、手动 registry 维护成本升高时，再考虑自动发现。

**Nest doc:** [Discovery service](https://docs.nestjs.com/fundamentals/discovery-service)

**Current decision:**
- 当前手动 registry 更简单、更显式。

**Trigger:**
- agent adapter、runtime provider、sandbox engine、event handler 进入插件化阶段。
- 新 provider 需要通过 decorator metadata 自动注册。

**Tasks when triggered:**
- 设计 provider decorator 和 metadata schema。
- 增加重复注册、缺失 metadata、排序稳定性的测试。

## P3 - 暂时不建议投入

### 9. Lazy-loading modules

**Nest doc:** [Lazy-loading modules](https://docs.nestjs.com/fundamentals/lazy-loading-modules)

**Decision:** 暂不使用。

**Reason:**
- 当前没有明显启动慢到需要 lazy load 的重模块。
- lazy loading 会让依赖路径更隐式，不适合当前优先追求模块边界清晰的阶段。

**Trigger:**
- admin/dev/heavy SDK 模块显著拖慢启动，且只在少数路径使用。

### 10. Platform agnosticism

**Nest doc:** [Platform agnosticism](https://docs.nestjs.com/fundamentals/platform-agnosticism)

**Decision:** 暂不投入 Express/Fastify 无关化。

**Reason:**
- 当前明确使用 Express `Response`、body parser、手写 SSE。
- 为平台无关抽象付出的代码复杂度暂时没有收益。

### 11. Circular dependency / forwardRef

**Nest doc:** [Circular dependency](https://docs.nestjs.com/fundamentals/circular-dependency)

**Decision:** 了解机制，但项目内继续禁止 `forwardRef` 作为常规解法。

**Reason:**
- 项目后端规则已要求避免循环依赖。
- 出现循环依赖时应通过 domain event、向下抽 owner、上提 use-case 编排、下沉共享概念等方式重画边界。

**Verification:**
- 代码检索中不应出现 `forwardRef`。
