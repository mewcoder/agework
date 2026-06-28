# NestJS Overview 优先级计划

**Goal:** 对照 NestJS Overview 栏目中的 first steps、controllers、providers、modules、middleware、guards、pipes、interceptors、exception filters、custom decorators，沉淀 `apps/api` 的请求生命周期使用约定和后续优化优先级。

**Scope:** NestJS API (`apps/api`)。本计划关注 Nest HTTP 请求边界和基础构造方式；不重复 `nestjs-fundamentals-priority-plan.md` 中的 lifecycle / ModuleRef / DiscoveryService，也不重复 `nestjs-techniques-priority-plan.md` 中的 queue / cache / schedule。

**Docs:**
- [First steps](https://docs.nestjs.com/first-steps)
- [Controllers](https://docs.nestjs.com/controllers)
- [Providers](https://docs.nestjs.com/providers)
- [Modules](https://docs.nestjs.com/modules)
- [Middleware](https://docs.nestjs.com/middleware)
- [Guards](https://docs.nestjs.com/guards)
- [Pipes](https://docs.nestjs.com/pipes)
- [Interceptors](https://docs.nestjs.com/interceptors)
- [Exception filters](https://docs.nestjs.com/exception-filters)
- [Custom decorators](https://docs.nestjs.com/custom-decorators)

## Current baseline

- `main.ts` 已完成 Nest bootstrap、global prefix、body limit、global `ValidationPipe`、global `ResponseInterceptor`、global `AllExceptionsFilter`、shutdown hooks。
- 模块按 feature module 组织；`AppModule` 只组合 feature module。
- Controller 基本只处理 HTTP I/O，调用 feature service。
- Provider 主要通过 constructor injection 注入；局部已有 custom provider token / `useFactory`。
- Guard 已覆盖全局 JWT、RBAC、worker internal access、auth throttling。
- Pipe 主要是全局 `ValidationPipe({ whitelist: true, transform: true })` + DTO。
- Interceptor 主要是统一 `{ code, data, message }` 响应包装。
- Exception filter 统一错误响应、requestId、日志脱敏。
- Custom decorator 已有 `@CurrentUser()`、`@Public()`、`@Roles()`、`@RawResponse()`、`@Trim()`。
- Middleware 当前通过 `app.use(requestIdMiddleware())` 生成/透传 `x-request-id`，并通过 `app.use(securityHeaders())` 接入 helmet；没有自定义 `NestMiddleware`。

## Request lifecycle policy

默认请求边界按这个顺序理解和落代码：

```text
Middleware
  -> Guard
    -> Pipe
      -> Controller
        -> Service
          -> Repository / lower service
        <- Interceptor
  <- Exception filter
```

角色分工：

| 机制 | 本项目用法 | 不做什么 |
|---|---|---|
| Middleware | HTTP 安全头、requestId、CORS/原始 HTTP 级别处理 | 不读取业务用户、不做权限、不访问 Prisma |
| Guard | 登录态、角色、worker access key、限流 | 不做 DTO 校验、不写业务状态 |
| Pipe | 外部输入转换和验证 | 不查数据库、不做业务权限 |
| Controller | HTTP adapter，接收 DTO/Query/Param，调用 service | 不写业务流程、不直接 Prisma |
| Provider / Service | 业务用例编排和领域能力 | 不知道 Express response，除非是明确的 SSE/raw response 边界 |
| Interceptor | 统一响应 envelope、日志/trace、跨切面包装 | 不吞掉业务异常、不改变业务语义 |
| Exception filter | 统一错误 envelope、requestId、错误日志 | 不做业务补偿、不暴露敏感错误 |
| Custom decorator | 封装元数据和 request 提取 | 不隐藏复杂业务逻辑 |

## P0 - 请求边界必须收稳

### 1. Controller 输入边界收口

**Status:** Done (2026-06-28)

**Objective:** 所有外部输入都走 DTO / pipe / typed param，减少 controller 内裸 `string` query 和手动解析。

**Docs:** [Controllers](https://docs.nestjs.com/controllers), [Pipes](https://docs.nestjs.com/pipes)

**Why now:**
- 当前大部分 body/query 已使用 DTO。
- 仍有部分 admin/list/query 入口直接接 `@Query("pageNo") pageNo?: string`、`@Query("status") status?: string` 这类裸字符串，容易让分页、枚举、多选 query 的解析逻辑分散。

**Tasks:**
- 盘点所有 `@Query("...")`、`@Param("...")` 裸字符串入口。
- 为分页、状态过滤、多选 query 建立轻量 DTO。
- 对 `pageNo`、`pageSize`、limit、timeout、waitMs 等数字 query 使用 `@Type(() => Number)` + `IsInt` / `Min` / `Max`。
- 对多选 query 统一兼容逗号分隔和重复 key 数组，避免每个 controller 自己解析。

**Likely paths:**
- `apps/api/src/runs/admin/admin-run.controller.ts`
- `apps/api/src/runtime/admin/admin-runtime.controller.ts`
- `apps/api/src/workspaces/admin/admin-workspace.controller.ts`
- `apps/api/src/users/admin/admin-user.controller.ts`
- `apps/api/src/worker-host/command.controller.ts`
- `apps/api/src/**/dto/*.ts`

**Verification:**
- DTO 单测覆盖非法数字、越界分页、未知 status、多选 query。
- Controller 单测只验证传入 service 的 typed 参数。

**Completed:**
- 新增通用 query value decorator 与分页 DTO。
- 为 admin run/runtime/users/workspaces、worker command/run params、model provider query 等入口补 DTO / typed param。
- Controller 改为接收 `@Query() DTO` / `@Param() DTO`，移除裸 `@Query("...")` / `@Param("...")` controller 参数。

**Verified with:**
- 相关 DTO / controller 目标 Vitest。
- `./node_modules/.bin/tsc --noEmit`

### 2. Guard / decorator 权限约定固化

**Status:** Done (2026-06-28)

**Objective:** 把 `@Public()`、`@Roles()`、`@CurrentUser()`、worker internal guard 的使用规则写死并测试，防止新 controller 漏权限。

**Docs:** [Guards](https://docs.nestjs.com/guards), [Custom decorators](https://docs.nestjs.com/custom-decorators)

**Why now:**
- 当前全局 `JwtAuthGuard` + `RolesGuard` 已经存在。
- Admin controller 已用 `@Roles("admin")`，worker 回连 endpoint 用 `@Public()` + `WorkerAuthGuard`。
- 这类元数据一旦漏标，影响是安全边界级别。

**Tasks:**
- 增加 route metadata audit 测试：
  - `/admin/**` controller 必须有 `@Roles("admin")` 或更严格策略。
  - `/worker/**` controller 必须 `@Public()` 且必须有 `WorkerAuthGuard`。
  - 普通业务 controller 不允许随意 `@Public()`。
- 给 `@Public()`、`@Roles()`、`@RawResponse()` 的 metadata key 使用集中命名规范，避免字符串重复。
- 对 `@CurrentUser()` 保持只做 request.user 提取，不做额外业务判断。

**Likely paths:**
- `apps/api/src/auth/decorators/*.ts`
- `apps/api/src/auth/guards/*.ts`
- `apps/api/src/worker-host/*.controller.ts`
- `apps/api/src/**/admin/*.controller.ts`
- `apps/api/src/common/api-route-convention.spec.ts`

**Verification:**
- 反射测试覆盖 admin/worker/public route metadata。
- guard 单测覆盖 `super_admin` 包含 admin 权限、缺失 user 被拒绝。

**Completed:**
- 在 `apps/api/src/common/api-route-convention.spec.ts` 增加 route metadata audit。
- 覆盖 admin controller 必须 `@Roles("admin")`、worker controller 必须 `@Public()` + `WorkerAuthGuard`、普通 controller 禁止 class-level `@Public()`、method-level `@Public()` 仅允许白名单 route。

**Verified with:**
- `./node_modules/.bin/vitest run src/common/api-route-convention.spec.ts`
- `./node_modules/.bin/tsc --noEmit`

### 3. Raw response / SSE 边界白名单

**Status:** Done (2026-06-28)

**Objective:** 明确哪些 endpoint 可以绕过统一 response envelope，避免 `@Res()` 和 `@RawResponse()` 扩散。

**Docs:** [Controllers](https://docs.nestjs.com/controllers), [Interceptors](https://docs.nestjs.com/interceptors), [Custom decorators](https://docs.nestjs.com/custom-decorators)

**Why now:**
- 当前 `ResponseInterceptor` 默认包装 API 响应。
- SSE 和 worker internal API 需要 raw response，这是合理例外，但需要白名单化。

**Tasks:**
- 列出允许 raw response 的 endpoint：
  - agent run/resume SSE
  - worker internal command/config/event endpoint
  - 未来 file download / stream endpoint
- 对新增 `@Res()` 使用增加 review gate：必须解释为什么不能用普通 return。
- `@RawResponse()` 只表达 response envelope 跳过，不承载权限语义。

**Likely paths:**
- `apps/api/src/common/interceptors/response.interceptor.ts`
- `apps/api/src/common/decorators/raw-response.decorator.ts`
- `apps/api/src/conversations/agent/agent.controller.ts`
- `apps/api/src/worker-host/*.controller.ts`

**Verification:**
- 单测覆盖普通 response 被包装、raw response 不包装。
- 代码约定测试扫描 `@Res()` / `@RawResponse()` 出现位置。

**Completed:**
- 在 `apps/api/src/common/api-route-convention.spec.ts` 增加 raw response / `@Res()` 白名单测试。
- 固化 `@RawResponse()` 只允许 worker owner/run internal route；非 passthrough `@Res()` 只允许 agent run/resume SSE；`@Res({ passthrough: true })` 只允许 auth cookie route。

**Verified with:**
- `./node_modules/.bin/vitest run src/common/api-route-convention.spec.ts`
- `./node_modules/.bin/tsc --noEmit`

## P1 - 横切能力和错误语义

### 4. Exception filter 错误契约强化

**Status:** Done (2026-06-28)

**Objective:** 统一错误 envelope、requestId、日志级别、敏感信息隐藏，并让业务错误语义更稳定。

**Doc:** [Exception filters](https://docs.nestjs.com/exception-filters)

**Tasks:**
- 明确外部错误返回字段：`code`、`data: null`、`message`、`requestId`。
- 对 auth/login 等安全敏感接口继续保持错误收敛。
- 对 400/401/404/403/429/5xx 的日志级别保持文档化。
- 评估是否增加内部 `reasonCode`，只写日志，不返回给普通用户。

**Likely paths:**
- `apps/api/src/common/filters/http-exception.filter.ts`
- `apps/api/src/common/logging.ts`
- `apps/api/src/users/credentials/login-failed.exception.ts`
- `apps/api/src/auth/**`

**Verification:**
- filter 单测覆盖 string/object/array validation error。
- 日志脱敏单测覆盖 token、password、apiKey、cookie。

**Completed:**
- `AllExceptionsFilter` 对未知 5xx 统一返回 `Internal server error`，不向客户端暴露内部 `Error.message`。
- requestId 读取统一走 `common/request-id.ts`。
- 日志脱敏补齐敏感字符串片段：`password=...`、`token=...`、`apiKey=...`、`cookie=...`、`authorization=Bearer ...`。
- 增加 filter / logging 单测覆盖 validation error、requestId、headersSent、日志级别、5xx 脱敏。

**Verified with:**
- `./node_modules/.bin/vitest run src/common/filters/http-exception.filter.spec.ts src/common/logging.spec.ts`
- `./node_modules/.bin/tsc --noEmit`

### 5. Interceptor 责任边界

**Status:** Done (2026-06-28)

**Objective:** 保持 interceptor 做跨切面包装，不把业务流程塞进 interceptor。

**Doc:** [Interceptors](https://docs.nestjs.com/interceptors)

**Tasks:**
- 当前 `ResponseInterceptor` 保持单一职责：普通 API 响应 envelope。
- 如果后续增加 request timing / trace interceptor，必须保证不改变业务返回语义。
- 不在 interceptor 中直接访问 Prisma 或修改业务状态。

**Likely paths:**
- `apps/api/src/common/interceptors/response.interceptor.ts`
- `apps/api/src/main.ts`

**Verification:**
- interceptor 单测覆盖 undefined data、raw route、普通 route。

**Completed:**
- 增加 `ResponseInterceptor` 边界测试：保留 falsy data、class/method-level `@RawResponse()` passthrough、普通 handler 包装、异常不被吞掉或重映射。

**Verified with:**
- `./node_modules/.bin/vitest run src/common/interceptors/response.interceptor.spec.ts`
- `./node_modules/.bin/tsc --noEmit`

### 6. Middleware 使用边界

**Status:** Done for requestId middleware (2026-06-28)

**Objective:** 中间件只处理 HTTP 级别横切能力，避免和 guard/service 混淆。

**Doc:** [Middleware](https://docs.nestjs.com/middleware)

**Current decision:**
- 当前 `securityHeaders()` 通过 `app.use()` 接入即可，不需要为了形式改成 `NestMiddleware`。

**Potential next tasks:**
- 增加 requestId middleware：请求进入时生成/透传 `x-request-id`，让成功和失败响应、日志都能复用同一个 id。
- CORS / CSP / security headers 按 path 细化时，再评估 middleware consumer。
- 不在 middleware 里做用户认证；认证继续由 guard 负责。

**Likely paths:**
- `apps/api/src/main.ts`
- `apps/api/src/common/security-headers.ts`
- `apps/api/src/common/request-id.*`

**Verification:**
- 请求进入即有 requestId，错误 filter 复用同一值。
- SSE / worker route 不被安全头或 CSP 误伤。

**Completed:**
- 新增 `common/request-id.ts`：统一 `REQUEST_ID_HEADER`、header 解析、requestId 生成/透传、Express middleware。
- `main.ts` 在 security headers 前注册 `requestIdMiddleware()`。
- Exception filter 复用同一 requestId 解析逻辑。

**Verified with:**
- `./node_modules/.bin/vitest run src/common/request-id.spec.ts src/common/filters/http-exception.filter.spec.ts`
- `./node_modules/.bin/tsc --noEmit`

## P2 - 模块和 Provider 组织持续治理

### 7. Module 边界和 exports 审计

**Objective:** 确保 module 只 export 根 service 或明确 public API，不把 repository/internal provider 暴露给其他 module。

**Docs:** [Modules](https://docs.nestjs.com/modules), [Providers](https://docs.nestjs.com/providers)

**Tasks:**
- 审计所有 `exports`，确认是否符合项目后端架构规则。
- 默认只 export feature root service。
- Runtime / Runs 这类组合模块当前有多个 export，需逐项写明理由。
- 不通过 module export 暴露 repository 给跨模块调用。

**Likely paths:**
- `apps/api/src/**/*.module.ts`
- `.claude/rules/backend-architecture.md`

**Verification:**
- 代码约定测试扫描跨模块 import repository/internal provider。

### 8. Provider 注入和职责厚度审计

**Objective:** 保持 constructor injection 清晰，避免 service 变成 god service 或 service locator。

**Docs:** [Providers](https://docs.nestjs.com/providers), [Modules](https://docs.nestjs.com/modules)

**Tasks:**
- 审计构造函数依赖数量过多的 service，优先看 `RunService`、`WorkerEventsService`、`WorkspaceService`。
- 依赖多不直接等于要拆；只有稳定子能力明确时才拆 internal provider。
- 禁止用 `ModuleRef` 或 `forwardRef` 掩盖边界问题。

**Likely paths:**
- `apps/api/src/runs/run.service.ts`
- `apps/api/src/runs/worker-events/worker-events.service.ts`
- `apps/api/src/workspaces/workspace.service.ts`
- `apps/api/src/runtime/**`

**Verification:**
- 单测保持围绕公开 service 用例，不测试私有实现细节。

### 9. First steps / bootstrap 简化

**Objective:** 保持 bootstrap 清晰，只做应用级 wiring；避免业务初始化逻辑继续堆进 `main.ts`。

**Doc:** [First steps](https://docs.nestjs.com/first-steps)

**Tasks:**
- `main.ts` 只保留 NestFactory、global middleware/pipes/interceptors/filters/prefix/shutdown/listen。
- 业务启动初始化继续放 `SystemInitService` / lifecycle hook。
- 启动前必须读取的 env 可以保留独立函数，但避免复杂业务逻辑。

**Likely paths:**
- `apps/api/src/main.ts`
- `apps/api/src/system/init/system-init.service.ts`
- `apps/api/src/config/config.service.ts`

**Verification:**
- bootstrap 单测可不做；配置解析和 lifecycle service 单测覆盖即可。

## P3 - 暂不主动引入

### 10. 局部 pipe / 局部 filter / 局部 interceptor 泛滥

**Decision:** 暂不鼓励给每个 route 单独挂 pipe/filter/interceptor。

**Reason:**
- 当前全局 pipe/filter/interceptor 已覆盖主要统一行为。
- 局部挂载会增加阅读成本，只有 file upload、raw stream、特殊错误契约等场景再用。

### 11. 复杂组合 decorator

**Decision:** 暂不引入大型 `applyDecorators()` 组合装饰器。

**Reason:**
- 当前 `@Public()`、`@Roles()`、`@CurrentUser()` 足够清晰。
- 如果未来 admin route 需要固定组合，如 `@AdminRoute()`，必须确保不会隐藏权限细节。

### 12. MiddlewareConsumer 大规模路由配置

**Decision:** 暂不使用复杂 `configure(consumer: MiddlewareConsumer)` 路由矩阵。

**Reason:**
- 当前 HTTP 级中间件少，全局 `app.use()` 更直接。
- 只有 CSP/CORS/request logging 按路由分组变复杂时再考虑。
