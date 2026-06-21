# 后端架构审查报告

- 日期：2026-06-11
- 范围：`apps/api/src`（含与 `apps/worker`、`@agework/shared/protocol` 的边界）
- 基线：`pnpm typecheck` 通过；`pnpm test`（api）14 个测试文件 57 个用例全部通过
- 当前分支：`feat/agent-runtime-phase4-docker-http`（runtime 模块重构进行中）

---

## 一、架构现状总览

```
apps/api/src/
├── main.ts                  # bootstrap：bodyParser/ValidationPipe/Interceptor/Filter/globalPrefix
├── app.module.ts            # 根模块 + ServeStatic 前端托管
├── common/                  # ResponseInterceptor / AllExceptionsFilter
├── config/                  # 自写 ConfigService（@Global）
├── prisma/                  # PrismaService（@Global）
├── auth/                    # JWT 登录 + APP_GUARD 全局守卫 + @Public/@Roles
├── users/                   # 用户管理（admin）
├── projects/                # 项目 CRUD + git clone + workspace 目录
├── workspaces/              # Workspace 实体（仅 create，一个方法）
├── threads/                 # 会话 + 消息持久化（assistant-ui format）
├── model-configs/           # 模型配置 CRUD + 连通性测试（含 admin controller）
├── system/                  # 系统信息
├── agent/                   # AG-UI 入口：AgentController.run → SSE
│   ├── agent.service.ts     # 实际是 RunConfig 构建器
│   ├── run-aggregator.ts    # AG-UI 事件 → assistant-ui 消息快照
│   ├── title.service.ts     # LLM 标题生成
│   └── agent-trace-logger.ts
└── runtime/                 # ★ 本次重构核心：run 生命周期
    ├── run-launcher.service.ts      # facade：start/stop/sendApprovalResolved
    ├── admin-run.controller.ts      # GET /runs/admin/list
    ├── domain/                      # RunService(DB) / RunRegistry(内存) / RunEventBus(事件分发+SSE)
    ├── providers/                   # LocalProcessProvider(IPC) / DockerProvider(HTTP) / Registry / RunConfigStore
    └── internal-api/                # /internal/runs/* worker 回调 + RuntimeTokenService + ControlQueue
```

依赖方向：`agent → runtime → threads`，`runtime/domain → agent/run-aggregator`（仅类型，见 P1-6）。

### 做得好的地方

- **runtime/ 分层重构方向正确**：domain（状态）/ providers（执行环境）/ internal-api（worker 通信）/ facade（RunLauncherService）职责清楚，比重构前 runs/+runtime/ 混置好得多。
- **测试基线健康**：runtime 核心组件（event-bus、registry、launcher、providers、control-queue、token）都有 spec，57 个用例全绿。
- **`provider-helpers.ts` 抽取 HeartbeatWatchdog** 供 local/docker 共用，避免逻辑漂移，注释明确。
- **认证模式标准**：APP_GUARD 全局 JwtAuthGuard + `@Public()` 白名单 + `@Roles()` + RolesGuard，是 NestJS 推荐做法。
- **资源隔离一致**：ThreadService / ProjectService 所有查询都带 `userId` 所有权过滤（`projectOwnerWhere`）。
- **统一响应结构**：ResponseInterceptor（`{code,data,message}`）+ AllExceptionsFilter 配套。
- **monorepo 类型共享**：`@agework/shared/protocol` 定义 Envelope/RunConfig/RuntimeProvider，api/worker 两端共用。

---

## 二、问题清单（按优先级）

### P0 — 疑似 bug，建议立即验证修复

#### P0-1 `/internal/runs/*` 会被全局 JwtAuthGuard 拦截（生产环境 worker 无法回调）

`AuthModule` 通过 `APP_GUARD` 注册的全局 `JwtAuthGuard` 先于 `RuntimeController` 上的 controller 级 `RuntimeAuthGuard` 执行，而 `RuntimeController` 没有 `@Public()`：

- worker 携带的 runtime token（payload `{runId, scope}`，同一 JWT_SECRET 签发）能通过 `jwtService.verify`，但 payload 没有 `sub`/`sessionVersion`，`jwt-auth.guard.ts:58` 的用户查询和 `:70` 的 sessionVersion 比对都会失败 → **401**。
- 目前开发模式 `DEV_AUTH_DISABLED=true` 直接放行，掩盖了这个问题；一旦按 `init:prod` 启用登录验证，Docker HTTP transport 的所有上报（config 拉取 / events / controls 轮询）都会被拒。

建议：
1. 给 `RuntimeController` 加 `@Public()`，安全完全交给自身的 `RuntimeAuthGuard`（已做 runId 与 token 匹配校验，是合理的）。
2. 同时把 runtime token 与用户 token 区分开：独立 secret，或签发时加 `audience: "runtime"` 并在两个 guard 中分别校验，避免「一种 secret 两种语义」的 token 混用面。

#### P0-2 Docker worker 默认 API base 缺少全局前缀 `/api/v1`

- `main.ts:53` 对所有路由设置了 global prefix（默认 `api/v1`，配 ctx 后是 `<ctx>/api/v1`），`RuntimeController` 也在其下。
- worker 端 `apps/worker/src/http-transport.ts:42` 拼的是 `${apiBase}/internal/runs/...`；
- 而 `DockerProvider.getApiBaseUrl()`（`docker-provider.service.ts:186`）默认返回 `http://host.docker.internal:3000` —— **不含 `/api/v1`**，worker 实际请求 `http://host.docker.internal:3000/internal/runs/:id`，会 404（且可能被 ServeStatic 兜住返回 HTML）。

除非环境里总是手工把 `PLATFORM_API_BASE` 配成带前缀的完整地址，否则 Docker 链路默认配置下不可用。建议：
1. `getApiBaseUrl()` 默认值统一拼上 context + `/api/v1`；
2. 把 main.ts / app.module.ts 重复的 `normalizePath/joinPaths`（见 P1-9）抽成共享 util，DockerProvider 复用同一份路径计算，避免三处漂移。

#### P0-3 孤儿 run 恢复只覆盖 local provider，且实现位置不当

`RuntimeModule.onModuleInit → recoverOrphanRuns`（`runtime.module.ts:70`）：

- 按 `runtimeId.split(":")` 解析 `pid:token` —— 这是 LocalProcessProvider 的私有编码格式泄漏到了模块层；Docker 的 runtimeId 是 containerId（不含 `:`），**孤儿容器不会被停止**，会一直跑到心跳无人接收。
- `process.kill(pid)` 没有校验 startToken，重启后 PID 复用时可能误杀无关进程（概率低但存在）。
- 模块类里写业务逻辑不符合 Nest 习惯（module 应只做组装）。

建议：在 `RuntimeProvider` 接口上加 `stopByRuntimeId(runtimeId)`（或 `recover()`），各 provider 自己实现清理；新建 `RunRecoveryService` 承载编排逻辑，`RuntimeModule.onModuleInit` 只调用它。

---

### P1 — 架构与分层问题

#### P1-1 全局 ValidationPipe 形同虚设：没有任何 DTO class

`main.ts:50` 配了 `ValidationPipe({ whitelist: true, transform: true })`，`class-validator`/`class-transformer` 也在依赖里，但全仓库**没有一个 DTO class**——所有 `@Body()` 用内联匿名类型，`agent.controller.ts:35` 甚至是 `body: any`。ValidationPipe 对非 class 类型不做任何校验，等于后端输入校验整体缺失（例如 `users/create` 的 `role` 字符串、`threads/rename` 的 `status` 都未约束）。

建议：为所有变更型端点补 DTO class（`create-thread.dto.ts` 等，每个模块一个 `dto/` 目录），用 `@IsString()/@IsIn()/@MaxLength()` 等声明约束；service 里的手工校验（如 `normalizeName`）可逐步上移到 DTO。`agent/run` 的 body 至少先定义 interface 替换 `any`。

#### P1-2 AgentController.run() 过胖（~160 行业务编排写在 controller 里）

`agent.controller.ts:33-192` 做了：用户消息持久化、agentType/resume 解析、标题触发、forwardedProps 组装、RunConfig 构建、SSE 头设置、saveRun 闭包构造、launcher 调用。Controller 应只做「解析请求 + 委派」。

建议：把 33-192 的编排逻辑下沉为 `AgentRunService`（或直接并入 `RunLauncherService.start` 的前置步骤），controller 压缩到 ~30 行。`saveRun` 闭包和 `RunAggregator` 的创建也应随之下沉——它们本质是 run 生命周期的一部分（见 P1-6）。

#### P1-3 AgentService 名实不符

`agent.service.ts` 唯一职责是把 modelConfig 翻译成 worker 的 `RunConfig`，叫 `AgentService` 容易被当成「agent 执行服务」。建议改名 `RunConfigBuilder`（或 `RunConfigService`），文件随之改名；如果采纳 P1-2 新建 `AgentRunService`，正好让命名各归其位。

#### P1-4 runtime → agent 的反向依赖：RunAggregator 位置不对

`runtime/domain/run-event-bus.service.ts:7` 和 `run-registry.service.ts:4` type-import 了 `agent/run-aggregator`。虽然只是类型，但依赖箭头应该是 `agent → runtime`，不应反向。RunAggregator 是「AG-UI 事件 → 消息快照」的聚合器，被 runtime 的事件管线消费，更属于 runtime 域。

建议：把 `run-aggregator.ts` 移到 `runtime/domain/`（或最小代价：在 runtime 里定义 `interface MessageAggregator { handle(evt); build(complete) }`，RunAggregator 实现它，runtime 只依赖接口）。

#### P1-5 JwtModule 重复注册 + secret 硬编码两处

`auth.module.ts:14` 和 `runtime.module.ts:35` 各自 `JwtModule.register({ secret: process.env.JWT_SECRET ?? "agework-dev-secret" })`，fallback 字符串硬编码两份；且 runtime token 与用户 token 同 secret（见 P0-1 的混用风险）。

建议：secret 读取收敛到 ConfigService（一个 `getJwtSecret()`，生产缺失时 fail fast，见 P3-2）；两个模块通过 `JwtModule.registerAsync` + ConfigService 注入；runtime token 用独立 secret 或 audience。

#### P1-6 env 读取散落各处

`process.env` 直读出现在 main.ts、app.module.ts、auth.module.ts、runtime.module.ts、docker-provider.service.ts、config.service.ts、model-config.service.ts 等处。已有自写 ConfigService 但只覆盖 workspace/appName/providerType。

建议：把 `PORT`、`JWT_SECRET`、`API_BODY_LIMIT`、`APP_CONTEXT`、`PLATFORM_API_BASE`、`AGEWORK_WORKER_IMAGE`、`SERVE_FRONTEND` 全部收口到 ConfigService（getter 形式即可，不必引入 @nestjs/config）。好处：默认值只写一次、可测试、P0-2 这类「两处默认值不一致」的 bug 不再发生。

#### P1-7 main.ts 与 app.module.ts 重复 60 行路径工具

`normalizePath/joinPaths` 在两个文件里逐字重复。抽到 `common/path.util.ts`，main.ts、app.module.ts、（修 P0-2 时的）DockerProvider 三处共用。

#### P1-8 internal-api 层直接耦合 DockerProvider

`runtime.controller.ts:34` 注入具体的 `DockerProvider` 只为在终态时 `cleanup(runId)`。internal-api 不应知道具体 provider。建议：终态清理统一放进 RunEventBus 的 terminal 分支（它已经处理 unregister），通过 `RuntimeProviderRegistry.resolve(handle.providerType).cleanup(runId)` 调用；HTTP 上报路径就不需要特判了。

---

### P2 — 命名与文件组织

#### P2-1 目录/文件单复数不统一

| 目录 | 文件 | 模块类 |
|---|---|---|
| `threads/` | `thread.controller.ts`（单数） | `ThreadModule` |
| `projects/` | `project.module.ts`（单数） | `ProjectModule` |
| `model-configs/` | `model-config.service.ts`（单数） | `ModelConfigModule` |
| `users/` | `users.controller.ts`（**复数**） | `UsersModule`（**复数**） |

建议统一「目录复数 + 文件/类单数」：`users/user.controller.ts` + `UserModule`。一次性改完，避免新代码两种风格都有样可学。

#### P2-2 `.service.ts` 后缀与类名不对应

`run-registry.service.ts → RunRegistry`、`run-event-bus.service.ts → RunEventBus`、`control-queue.service.ts → ControlQueue`、`docker-provider.service.ts → DockerProvider`，而 `run-launcher.service.ts → RunLauncherService`。另外 `agent-trace-logger.ts` 是 @Injectable 却没有 `.service` 后缀。

两种约定都可以，但要选一种：建议**类名不带 Service 的，文件名也去掉 `.service`**（`run-registry.ts`、`docker-provider.ts`），保留 `.service.ts` 给真正叫 `XxxService` 的类。重命名成本低（重构期正合适）。

#### P2-3 admin 路由三种风格并存

- `GET /runs/admin/list`（resource/admin/action）
- `POST /projects/admin/rename`（resource/admin/action）
- `/admin/model-configs/*`（独立 `AdminModelConfigController` + 类级 `@Roles("admin")`）

model-configs 的做法最清晰（路由前缀即权限边界、controller 级别一次声明）。建议统一为 `/admin/<resource>` 独立 controller：`AdminRunController` 改为 `@Controller("admin/runs")`，projects 的 admin 端点拆出 `AdminProjectController`。

#### P2-4 WorkspaceModule 过于贫血

`workspace.service.ts` 只有一个 `create()`（13 行），无 controller，仅被 ProjectService 使用。作为「未来 workspace 生命周期管理」的占位可以接受，但在它真正长出功能前，也可并入 projects 模块减少一层间接。二选一，不阻塞。

#### P2-5 杂项命名

- `admin-run.controller.ts` 放在 `runtime/` 根目录，与 domain/providers/internal-api 分层并列。如果采纳 P2-3，可建 `runtime/admin/` 或保持现状（facade 层文件不多时可接受）。
- `provider-helpers.ts` 里 `HEARTBEAT_TIMEOUT_SEQ = 999999` 这种魔数 hack 注释已说明，但更稳妥的是让 RunEventBus 暴露「强制终态」入口绕过 seq 去重，而不是赌 seq 不超过 999999。

---

### P3 — 安全加固与健壮性

#### P3-1 模型配置 apiKey 明文入库、admin 接口原样回传

`ModelConfigService.listForAdmin` 返回完整 `config`（含 apiKey）到前端；`desensitizeConfig` 只用于普通用户。建议：admin list 也脱敏（掩码显示），update 支持「未回传敏感字段 = 不修改」的 write-only 语义。静态加密（DB 层）有需求再做。

#### P3-2 生产环境 JWT_SECRET 缺失时静默回退 dev secret

`init:prod` 会写入随机值，但手工部署漏配时会静默用 `"agework-dev-secret"` 跑生产。建议：`NODE_ENV=production`（或 `DEV_AUTH_DISABLED=false`）且无 `JWT_SECRET` 时启动报错。

#### P3-3 缺少基础安全中间件

无 rate limiting、helmet、显式 CORS 配置。`/auth/login` 是 `@Public()`，存在暴力破解面。建议至少给 auth 端点加 `@nestjs/throttler`，全局加 helmet。自托管场景优先级中等。

#### P3-4 `.catch(() => {})` 静默吞错遍布

agent.controller、run-event-bus、run-launcher 等几十处。意图（持久化失败不阻塞流式）是对的，但完全静默会让排障变难。建议封装一个 `swallow(logger, label)` 帮助函数，至少 debug 级记录。

#### P3-5 LLM 直连逻辑重复

`TitleService.generateClaude/generateOpenAI` 与 `ModelConfigService.test` 各自实现 Anthropic/OpenAI HTTP 调用、base url 归一化、config JSON 解析；`AgentService` 又持有一份 required-fields 知识。`"claude" | "codex"` 字面量散落在 thread.service、agent.service、model-config.service、protocol 至少 4 处。

建议：在 `@agework/shared` 导出 `AgentType` 联合类型统一引用；把「modelConfig.config 解析 + 各厂商 HTTP 探测/调用」收敛成一个小模块（如 `model-configs/llm-client.ts`），TitleService 和 test() 共用。

#### P3-6 其他

- `API_BODY_LIMIT` 默认 50mb 偏大（DoS 面），自托管可接受，建议文档注明。
- `RunService.listAdmin` 手工三表查询拼 join——若 Prisma schema 给 Run 建了 relation 可用 `include` 简化；没建 relation 则现状可接受。
- `AgentController.stop()` 里 `findOne` 与 `stop` 之间有窗口期竞态（run 刚好结束），影响仅状态显示，低优先级。

---

## 三、修改路线建议

| 阶段 | 内容 | 工作量 |
|---|---|---|
| **立即（随当前分支）** | P0-1 internal API 加 `@Public()` + runtime token audience；P0-2 Docker apiBase 拼前缀 + 抽 path util（顺带 P1-7）；P0-3 孤儿恢复下沉 provider | 小，且属于 Phase 4 验收范围 |
| **下个迭代** | P1-1 补 DTO（先覆盖 users/projects/threads 变更端点）；P1-2/P1-3 controller 瘦身 + AgentService 改名；P1-5/P1-6 config 收敛 | 中 |
| **一次性整理** | P2-1/P2-2 命名统一（纯重命名，趁重构分支没合并前做完，避免 review 噪音分散） | 小 |
| **渐进** | P1-4 RunAggregator 归位；P2-3 admin 路由统一；P3 各项按需 | 按需 |

## 四、结论

整体架构是健康的：模块划分符合 NestJS feature module 约定，本次 runtime 重构的分层（domain/providers/internal-api/facade）方向正确，测试基线良好。主要风险集中在**Phase 4 的 Docker HTTP 链路在「启用登录验证 + 默认配置」下跑不通**（P0-1、P0-2），建议在分支合并前修复并补一条带 auth 的集成测试。其次是**输入校验整体缺失**（P1-1）和**配置读取散落**（P1-5/P1-6），属于会持续产生新问题的结构性短板，值得尽早收口。命名问题（P2）不影响正确性，但趁重构期一次改完成本最低。
