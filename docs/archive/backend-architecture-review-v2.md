# 后端架构审查报告（第二轮）

- 日期：2026-06-11
- 范围：`apps/api/src`（含与 `apps/worker`、`@agework/shared/protocol` 的边界）
- 基线：`pnpm typecheck` 通过；`pnpm test:api` 26 个测试文件 137 个用例全部通过
- 当前分支：`feat/agent-runtime-phase4-docker-http`
- 前序文档：`docs/backend-architecture-review.md`（第一轮，已被本文档取代）、
  `docs/superpowers/specs/2026-06-11-runtime-module-restructure-design.md`（重构设计）

---

## 一、第一轮整改落实情况

第一轮评审的多数问题已在本分支落实，验证结果如下：

| 第一轮编号 | 内容 | 状态 |
|---|---|---|
| P0-1 | internal API 被全局 JwtAuthGuard 拦截 | ✅ `RuntimeController` 已加 `@Public()`，runtime token 增加 `scope: "runtime"` 校验 |
| P0-2 | Docker apiBase 缺 `/api/v1` 前缀 | ✅ `resolveDockerApiBase()` 已拼 `<APP_CONTEXT>/api/v1`，且抽到 provider-helpers 可注入 env 测试 |
| P0-3 | 孤儿恢复泄漏 local 私有格式 | ✅ 各 provider 实现 `recoverOrphan()`；⚠️ 编排逻辑仍在 `RuntimeModule` 类里（见 P1-4） |
| P1-1 | 无 DTO class | 🔶 threads/projects/users 已补 DTO；model-configs、agent 仍是内联匿名类型（见 P1-3/P1-5） |
| P1-2/P1-3 | AgentController 过胖 / AgentService 名实不符 | ✅ controller 压缩到 48 行；拆出 `AgentRunService` + `RunConfigBuilder` |
| P1-4 | RunAggregator 反向依赖 | ✅ 已移到 `runtime/domain/` |
| P1-5/P1-7 | JWT secret 两处硬编码 / 路径工具重复 | ✅ `getJwtSecret()` 单一来源；`common/path.util.ts` 共享 |
| P1-8 | internal-api 直耦合 DockerProvider | ✅ 改为 `RuntimeProviderRegistry.resolve(handle.providerType)` |
| P2-1/P2-2/P2-3 | 单复数 / `.service` 后缀 / admin 路由 | ✅ 全部统一（`users/user.*`、`run-registry.ts`、`/admin/<resource>` 独立 controller） |
| P2-5 | seq=999999 魔数 hack | ✅ 改为 `RunEventBus.forceErrorStatus()` 显式绕过去重 |
| P3-1 | admin apiKey 脱敏 | ➖ 按产品决策保留原样回显（admin 界面需要回显编辑） |
| P3-2/P3-3 | 生产 JWT fail-fast / helmet/throttler | ❌ 未做（见 P2-6） |
| P3-4/P3-5 | 静默吞错 / LLM 直连重复 | ✅ `common/swallow.ts`；`model-configs/llm-client.ts` 共享，`AgentType` 收入 protocol |

**结论：重构后的模块结构已经达到设计文档目标**——`agent/ → runtime/ → threads/` 单向依赖，无 `forwardRef`；`runtime/` 按 `domain / providers / internal-api / admin` + facade（`RunLauncherService`）分层清晰。文件组织本身没有大问题，本轮焦点转向**运行时正确性和残余的边界问题**。

### 当前结构（确认健康）

```
apps/api/src/
├── common/          # swallow / path.util / ResponseInterceptor / AllExceptionsFilter
├── config/          # ConfigService + getJwtSecret 单一来源
├── prisma/ auth/ users/ projects/ workspaces/ threads/ model-configs/ system/
├── agent/           # 入口编排：AgentController(瘦) → AgentRunService → RunConfigBuilder/TitleService
└── runtime/
    ├── run-launcher.service.ts   # facade：start / stop / sendApprovalResolved
    ├── runtime.module.ts         # 组装 + 孤儿恢复（⚠️ 见 P1-4）
    ├── admin/                    # /admin/runs
    ├── domain/                   # RunService(DB) / RunRegistry(内存) / RunEventBus / RunAggregator
    ├── providers/                # local / docker / registry / run-config-store / provider-helpers
    └── internal-api/             # /internal/runs/* + RuntimeTokenService / RuntimeAuthGuard / ControlQueue
```

---

## 二、问题清单（按优先级）

### P0 — Docker 心跳断链：每个 Docker run 约 60 秒后被自己的 watchdog 杀死

这是本轮发现的最严重问题，证据链完整：

1. `docker-provider.ts:82` — `start()` 时启动 `HeartbeatWatchdog`，起始时间为启动时刻；
2. worker 的心跳通过 `HttpTransport.emit()` 走 `POST /internal/runs/:id/events`（`apps/worker/src/http-transport.ts:54`）；
3. `RuntimeController.postEvent()` 只调用 `runEventBus.publish()` → `handleHeartbeat()` 只更新 DB 的 `lastHeartbeatAt`；
4. **全仓库只有 `local-process-provider.ts:81` 调用过 `heartbeats.beat()`**，Docker 路径上没有任何代码喂狗；
5. 结果：watchdog 在 `HEARTBEAT_TIMEOUT_MS`（60s）后必然触发 → `docker stop` 容器 → `forceErrorStatus` 把 run 标成 error。任何超过 60 秒的 Docker run 都会被误杀。

`docker-provider.spec.ts` 和 `runtime.controller.spec.ts` 都没有覆盖心跳路径，所以测试全绿掩盖了这个问题。

**建议修复**（二选一，推荐前者）：

- 在 `RuntimeController.postEvent()` 识别 `envelope.type === "heartbeat"` 时，经 `RuntimeProviderRegistry.resolve(handle.runtimeHandle.providerType)` 调用 provider 的喂狗入口。需要在 `RuntimeProvider` 接口上加一个 `heartbeat(runId): void`（local 实现为 no-op 或同样喂狗，统一两条路径）。
- 或者把 watchdog 从 provider 上移到 `RunEventBus`（它已是所有上行事件的唯一汇入口，天然能看到两种 transport 的心跳），provider 只保留「超时后如何杀 worker」的回调。这个方案长期更干净，但改动面大一些。

无论哪种方案，**必须补一条 spec**：模拟 Docker run 持续上报心跳超过 60s 仍存活、心跳停止后被清理。

### P1 — 架构与分层

#### P1-1 run 的内存态分裂在两个注册表，清理路径三处分布

同一个 runId 的内存状态同时存在于：

- `RunRegistry.handles`：`{ runtimeHandle, res, aggregator, threadId, stopRequested }`
- `RunEventBus.contexts`：`{ runId, threadId, res, aggregator, saveRun, onAgentResumeId }`

`res / aggregator / threadId` 两份冗余，导致：

- SSE 断开时要在两处置空（`run-launcher.service.ts:126-132` 既改 `handle.res` 又调 `clearResponse`）；
- 终态清理分散三处：`RunEventBus.handleRunStatus` 负责 unregister registry+context，`RuntimeController.postEvent` 负责 Docker 的 `provider.cleanup`，`LocalProcessProvider` 靠 `child.on("exit")` 自清理。`runtime.controller.ts:69` 还得在 publish 前抢先取 handle（「终态后就拿不到了」的注释正说明时序耦合脆弱）。

建议：合并为单一 `RunRegistry` 条目（context 字段并入 `RunHandle`），`RunEventBus` 从 registry 读取；终态时由 `RunEventBus` 统一调 `provider.cleanup(runId)`（provider 实现已幂等），删掉 `RuntimeController` 里的特判和 local 的 exit 特判依赖。这同时消解 P0 修复方案二的大部分改动。

#### P1-2 agent 模块越过 model-configs 边界直查 Prisma，"system:" 知识三处重复

- `agent/run-config-builder.service.ts:72` 和 `agent/title.service.ts:76` 直接 `prisma.modelConfig.findFirst`，绕过 `ModelConfigService`；
- `system:` 前缀常量在三处各定义一份：`model-config.service.ts:23`（`SYSTEM_PREFIX`）、`run-config-builder.service.ts:9`、`title.service.ts:17`（各自的 `ENVIRONMENT_MODEL_CONFIG_PREFIX`）；
- 「某 agentType 需要哪些必填字段」的知识在 `RunConfigBuilder.AGENT_ADAPTER_STRATEGIES` 与 `ModelConfigService.test()` 各有一份。

建议：`ModelConfigService` 暴露一个领域方法（如 `resolveEnabledConfig(agentType, modelConfigId): { config, isEnvironmentConfig }`），`ModelConfigModule` export 后由 `AgentModule` import；`system:` 前缀与判断函数收敛到 `model-configs/`（或 `@agework/shared`）一处导出。这是典型的 feature-module 边界问题：跨模块数据访问应走对方 service，而不是各自持有一份隐性约定。

#### P1-3 主入口 `POST /agent/run` 仍是 `body: any`，错误处理会误导

- `agent.controller.ts:19` / `agent-run.service.ts:25` 的 body 是 `any`，全靠运行时点取。这是系统最核心的入口，至少应定义 `RunAgentInput` interface（AG-UI 协议字段 + `forwardedProps` 形状），有条件再上 DTO 校验。
- `agent-run.service.ts:70-72` 的 `catch {}` 会吞掉**所有**错误（包括 DB 连接失败），然后统一抛出「Thread 必须关联项目」的 BadRequest——排障时极具误导性。应只捕获 NotFound 语义的错误，其余原样上抛。

#### P1-4 孤儿恢复编排仍写在 `RuntimeModule` 类里

`runtime.module.ts:69-117` 约 50 行业务编排（查 active runs → 逐个 recoverOrphan → markError → 清理 thread 状态）。重构设计文档当时标注「原样保留」，作为下一步：抽成 `runtime/domain/run-recovery.service.ts`，module 的 `onModuleInit` 只调用一行。module 类保持纯组装是 Nest 的惯例，也方便给恢复逻辑单独写 spec（目前这段没有测试）。

#### P1-5 DTO 覆盖不均

threads/projects/users 已有规范的 `dto/` 目录，但 `AdminModelConfigController` 的 5 个变更端点（`model-config.controller.ts:36-84`）仍是内联匿名类型，`config: Record<string, string>` 完全未校验。既然 DTO 模式已经立起来了，建议补齐 model-configs，保持「所有变更型端点都有 DTO」的统一规则，避免新代码两种风格都有样可学。

### P2 — 一致性与遗留

#### P2-1 ConfigService 收口未完成

`PORT`、`API_BODY_LIMIT`、`SERVE_FRONTEND` 仍在 `main.ts` / `app.module.ts` 直读 `process.env`。`resolveDockerApiBase` 以参数注入 env 的写法可测试，可接受。剩余几个集中在启动路径，统一收进 `ConfigService` 即可（低成本，顺手做）。

#### P2-2 `ARCHITECTURE.md` 已漂移

- 称 controls 为「long-polling」，实际是 2s 间隔短轮询（`http-transport.ts:150` + `ControlQueue.poll` 立即返回）；
- 引用旧文件名 `runtime-provider-helpers.ts`（现为 `provider-helpers.ts`）、`RunsController`（现为 `AdminRunController`）。

建议合并分支前刷新一遍。顺带决策：如果 cancel 的 2s 最大延迟可接受（目前看可以，docker stop 还有 10s 宽限），就把文档改成「短轮询」；否则把 `pollControls` 改成真 long-poll。

#### P2-3 其他遗留（维持第一轮判断，不阻塞）

- `workspaces/` 仍是贫血模块（一个 13 行的 `create()`），作为占位可接受；
- `Run` 表无 Prisma relation，`RunService.listAdmin` 手工三表 join，可接受；
- `TitleService.scanUserMessages` 全量加载消息逐条 JSON.parse，消息量大时是浪费，小规模可接受；
- RPC 风格路由（`/threads/list`、`POST /threads/delete`）项目内一致，不必改 REST。

### P3 — 安全加固（与第一轮相同，仍未做）

1. **生产 JWT_SECRET 静默回退**：`getJwtSecret()` 在任何环境都会 fallback 到 `"agework-dev-secret"`。建议 `DEV_AUTH_DISABLED !== "true"` 且未配置 `JWT_SECRET` 时启动报错（fail fast）。这是 P3 里唯一建议尽快做的。
2. runtime token 与用户 token 仍共用 secret（已有 `scope` 区分，且双向误用都会被各自 guard 拒绝，残余风险低；要彻底分离可给 runtime token 用独立 secret）。
3. 无 helmet / throttler；`/auth/login` 无速率限制；`API_BODY_LIMIT` 默认 50mb。自托管场景优先级中等。

---

## 三、修改路线建议

| 阶段 | 内容 | 说明 |
|---|---|---|
| **合并前必须** | P0 Docker 心跳喂狗 + 补心跳 spec | Phase 4 验收项，当前 Docker 链路实际不可用（>60s 必死） |
| **合并前建议** | P2-2 刷新 ARCHITECTURE.md；P3-1 JWT fail-fast | 都是小改动 |
| **下个迭代** | P1-1 合并双注册表 + 统一终态清理；P1-2 model-configs 边界收口 | 两者都是结构性的，越晚改触点越多 |
| **顺手做** | P1-3 RunAgentInput 类型 + 修 catch；P1-4 RunRecoveryService;P1-5 model-configs DTO；P2-1 env 收口 | 各自独立，可拆小 PR |

## 四、结论

第一轮指出的结构性问题已基本清零：模块边界单向、runtime 分层名实相符、命名统一、工具函数收口，文件组织形式不需要再动。当前真正的风险只有一个——**Docker 心跳链路断裂导致 Phase 4 主打功能在超过 60 秒的任务上不可用**，且测试盲区恰好盖住了它，必须在合并前修复并补测试。其余问题（双注册表、model-configs 边界、DTO 补齐）属于「会随代码增长持续摩擦」的中等优先级，建议按上表节奏消化。
