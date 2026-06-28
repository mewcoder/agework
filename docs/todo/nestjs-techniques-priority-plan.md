# NestJS Techniques 优先级 TODO

**Goal:** 对照 NestJS 官方 Techniques，把当前 `apps/api` 已用、未用但可能需要、暂时不建议引入的能力按优先级沉淀下来，作为后续后端演进入口。

**Scope:** NestJS API (`apps/api`)。本 TODO 只做技术路线优先级，不要求一次性引入所有 Nest 官方模块。

**Current baseline:**
- 已有自研 `ConfigService`：`dotenv + env getter + DB-backed system settings + 内存 cache`。
- 已有全局 `ValidationPipe`、异常过滤器、响应拦截器、JWT guard、RBAC guard、auth throttling。
- 已有 Prisma、EventEmitter、ServeStatic、手写 SSE、内存 worker command queue、run timeout timer。
- 未使用 `@nestjs/config`、`@nestjs/bullmq`、`@nestjs/schedule`、`@nestjs/cache-manager`、`@nestjs/axios`。

## P0 - 优先研究 / 最可能影响架构可靠性

### 1. Queues / BullMQ

**Objective:** 评估是否用持久化队列替代或增强当前内存 `WorkerCommandQueue`。

**Nest doc:** [Queues](https://docs.nestjs.com/techniques/queues)

**Why now:**
- 当前 worker command queue 是内存态。
- 代码已有单 worker per owner 假设；多 worker 并发轮询同一 owner 时存在漏消息风险。
- API 重启、多实例部署、worker 多副本、ack/retry/lease 都会放大这个问题。

**Tasks:**
- 梳理当前 worker command lifecycle：enqueue、poll、timeout、cleanup、record sent。
- 决策使用 Redis/BullMQ、DB durable queue，还是先修内存 queue 的 lease/ack。
- 明确消息语义：at-most-once、at-least-once、幂等 key、重试上限、死信处理。
- 给 worker command 加消费确认或可恢复状态。

**Likely paths:**
- `apps/api/src/worker-host/command-queue.ts`
- `apps/api/src/worker-host/command-dispatcher.service.ts`
- `apps/api/src/worker-host/command.controller.ts`
- `apps/api/src/runs/execution/sandbox.executor.ts`
- `apps/worker/src/transport/http.ts`

**Verification:**
- 单测覆盖多 worker / 多 poller 不漏消息。
- 单测覆盖 API 重启后的恢复策略。
- 单测覆盖重复投递时 worker/run 处理幂等。

### 2. 启动期配置校验

**Objective:** 保留自研 `ConfigService`，补齐 env schema validation 和生产 fail-fast。

**Nest doc:** [Configuration](https://docs.nestjs.com/techniques/configuration)

**Why now:**
- 当前配置体系贴合后台系统设置，不需要简单替换为官方 `@nestjs/config`。
- 但生产 secret、数据库 URL、sandbox、runtime allow list 等配置应在启动时统一校验。

**Tasks:**
- 定义 `AGEWORK_*` env schema。
- 校验生产环境必须配置安全 JWT secret、setup token、database URL 等关键项。
- 校验数值范围、枚举值、URL 格式、逗号列表格式。
- 把校验错误做成清晰的启动错误信息。

**Likely paths:**
- `apps/api/src/config/config.service.ts`
- `apps/api/src/config/registry/env-key.ts`
- `apps/api/src/config/registry/defaults.ts`
- `apps/api/.env.example`
- `scripts/init.mjs`

**Verification:**
- 单测覆盖缺失 secret、非法 runtime type、非法 timeout、非法 URL。
- 生产配置错误时启动前 fail fast。

### 3. Task Scheduling

**Objective:** 用标准调度能力承载全局巡检类任务，而不是继续散落 `setTimeout`。

**Nest doc:** [Task scheduling](https://docs.nestjs.com/techniques/task-scheduling)

**Why now:**
- 当前已有 per-run timeout timer。
- 后续 stale run recovery、runtime GC、日志清理、provider 健康扫描都更像周期任务。

**Tasks:**
- 盘点需要周期执行的任务：stale run recovery、runtime idle GC、runtime orphan cleanup、日志清理。
- 决策是否引入 `@nestjs/schedule`。
- 给每个任务定义锁策略，避免多实例重复执行。
- 给任务执行结果加结构化日志。

**Likely paths:**
- `apps/api/src/runs/live-runs/live-run.registry.ts`
- `apps/api/src/runs/recovery/run-recovery.service.ts`
- `apps/api/src/runtime/instances/lifecycle.use-case.ts`
- `apps/api/src/runtime/sandbox/sandbox-instance.service.ts`

**Verification:**
- 单测覆盖任务触发逻辑。
- 多实例部署前必须有分布式锁或幂等保护。

## P1 - 生产排障和性能体验

### 4. Logger / 结构化日志

**Objective:** 在现有 Nest Logger + 脱敏工具基础上，评估统一结构化 logger。

**Nest doc:** [Logger](https://docs.nestjs.com/techniques/logger)

**Tasks:**
- 统一 requestId、userId、runId、conversationId、runtimeInstanceId 字段。
- 评估 Nest custom logger、pino、winston。
- 保留敏感字段脱敏规则。
- 明确 debug/log/warn/error 在开发和生产的输出策略。

**Likely paths:**
- `apps/api/src/common/logging.ts`
- `apps/api/src/common/filters/http-exception.filter.ts`
- `apps/api/src/main.ts`

**Verification:**
- 单测覆盖 secret/token/password/apiKey 不进入日志。
- 请求失败日志包含 requestId。

### 5. HTTP Module / outbound client 统一化

**Objective:** 当外部 HTTP 请求增多时，统一超时、重试、错误映射、日志和 trace。

**Nest doc:** [HTTP module](https://docs.nestjs.com/techniques/http-module)

**Tasks:**
- 盘点现有 `fetch` 调用：model provider ping、OpenSandbox、worker-host 相关请求。
- 决策继续原生 `fetch` + wrapper，还是引入 `@nestjs/axios`。
- 统一 timeout、retry、abort、错误分类。
- 为外部请求增加脱敏日志。

**Likely paths:**
- `apps/api/src/model-providers/model-provider.service.ts`
- `apps/api/src/runtime/sandbox/opensandbox-client.ts`
- `apps/worker/src/transport/http.ts`

**Verification:**
- 单测覆盖超时、非 2xx、网络错误、敏感 header 脱敏。

### 6. Caching

**Objective:** 只对读多写少、可失效的数据引入缓存；不要重复缓存已有系统设置。

**Nest doc:** [Caching](https://docs.nestjs.com/techniques/caching)

**Tasks:**
- 识别候选缓存：provider models list、provider system-info、admin stats、runtime policy。
- 明确 TTL 和主动失效点。
- 决策内存 cache、Nest CacheModule，还是 Redis cache。
- 不优先缓存 `ConfigService` 的系统设置，当前已有 DB + 内存 cache。

**Likely paths:**
- `apps/api/src/model-providers/model-provider.service.ts`
- `apps/api/src/runtime/admin/admin-runtime.controller.ts`
- `apps/api/src/config/config.service.ts`

**Verification:**
- 单测覆盖缓存命中、失效、配置更新后的刷新。

## P2 - 条件触发 / 有需求再做

### 7. Compression

**Objective:** 大 JSON 响应变多时再启用压缩，SSE 路径谨慎处理。

**Nest doc:** [Compression](https://docs.nestjs.com/techniques/compression)

**Trigger:**
- admin run events、conversation messages、日志查询等响应体明显变大。

**Tasks:**
- 评估只压缩普通 JSON 响应。
- 排除或验证 SSE 路径，避免影响流式刷新。

### 8. Versioning

**Objective:** 只有当需要同时维护 v1/v2 行为时，再用 Nest 官方 versioning。

**Nest doc:** [Versioning](https://docs.nestjs.com/techniques/versioning)

**Current decision:**
- 当前已有 `/api/v1` 路径约定，短期够用。

**Trigger:**
- 出现破坏性 API 变更，且必须长期兼容旧客户端。

### 9. Serialization

**Objective:** 返回模型出现大量敏感字段、角色差异字段时，再考虑标准序列化。

**Nest doc:** [Serialization](https://docs.nestjs.com/techniques/serialization)

**Current decision:**
- 当前主要靠 DTO、手动返回结构、全局 `ResponseInterceptor`。

**Trigger:**
- 多个接口重复隐藏字段，或同一实体按角色返回不同字段。

## P3 - 暂时不建议投入

### 10. 官方 `@Sse()`

**Nest doc:** [Server-Sent Events](https://docs.nestjs.com/techniques/server-sent-events)

**Decision:** 暂不替换当前手写 SSE。

**Reason:**
- 当前需要 `@Res()`、断线接管、替换 response、AG-UI 事件流和 snapshot/event 两种模式。

### 11. Cookies / Session

**Nest docs:**
- [Cookies](https://docs.nestjs.com/techniques/cookies)
- [Session](https://docs.nestjs.com/techniques/session)

**Decision:** 当前 JWT bearer 模型先保持。

**Trigger:**
- 决定改为 HttpOnly cookie 登录态，或引入服务端 session/refresh token。

### 12. File upload / Streaming files

**Nest docs:**
- [File upload](https://docs.nestjs.com/techniques/file-upload)
- [Streaming files](https://docs.nestjs.com/techniques/streaming-files)

**Decision:** 暂不投入。

**Trigger:**
- 出现附件上传、artifact 下载、日志下载、导出文件等真实需求。

### 13. Fastify

**Nest doc:** [Performance / Fastify](https://docs.nestjs.com/techniques/performance)

**Decision:** 暂不迁移。

**Reason:**
- 当前 Express + 手写 SSE + body parser 路径稳定，迁移收益不明显。

### 14. MVC / MongoDB

**Nest docs:**
- [MVC](https://docs.nestjs.com/techniques/mvc)
- [MongoDB](https://docs.nestjs.com/techniques/mongodb)

**Decision:** 不适合当前架构。

**Reason:**
- 当前是 React/Vite 前端 + Nest API + Prisma，不需要 Nest MVC 或 MongoDB/Mongoose。

