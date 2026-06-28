# 账户与登录安全优先级 TODO

**Goal:** 在只支持“用户名 + 密码”、不做邮箱的前提下，把当前账号、登录、会话和权限体系从“可用的简化实现”推进到可维护、可审计、可逐步增强的安全基线。

**Scope:** NestJS API (`apps/api`)、Web 登录态 (`apps/web`)、共享 auth/user API 类型 (`packages/shared`)。本计划只定义实施优先级，不要求一次性重写认证体系。

**Current baseline:**
- 已有用户名密码登录、bcrypt hash、JWT、全局 `JwtAuthGuard`、`RolesGuard`、`sessionVersion` token 失效、用户审批、临时密码、强制改密。
- 主要缺口是公共入口防滥用、首次初始化保护、登录错误收敛、服务端会话生命周期、权限矩阵和审计。

## 实施状态（2026-06 更新）

P0 全部完成，P1 完成核心项（5/6/8），P2 与 CSRF 经评估不做。详见下文各节标记。

| 项 | 状态 | 实际落点 |
|---|---|---|
| P0-1 限流 | ✅ | `auth/guards/auth-throttler.ts`（IP + IP+用户名双桶） |
| P0-2 登录错误收敛 | ✅ | `users/credentials/login-failed.exception.ts` |
| P0-3 setup 初始密钥 | ✅ | `AGEWORK_PRIVATE_ADMIN_INIT_KEY`（仅生产强制） |
| P0-4 Helmet | ✅ | `common/security-headers.ts` |
| P1-5 session/refresh token | ✅ | `auth/session/`（混合方案：access Bearer + refresh HttpOnly cookie） |
| P1-6 RBAC 矩阵+归属测试 | ✅ | `docs/architecture/rbac-matrix.md` + 4 处 spec |
| P1-7 CORS | ⏭️ 撤销 | 同源架构，不开 CORS 即最安全；曾实现护栏后回滚 |
| P1-8 密码长度边界 | ✅ | 设密码 8–64 字符（NIST 对齐） |
| P2-9 审计日志 | ⏭️ 暂不做 | — |
| P2-10 入库密钥加密 | ⏭️ 暂不做 | — |
| Conditional-11 CSRF | ⏭️ 不触发 | 混合方案状态变更走 Bearer，不靠 cookie，无需 CSRF |

## Nest Security Menu 取舍

| Nest 文档项 | 优先级 | 本项目决策 |
|---|---:|---|
| [Rate limiting](https://docs.nestjs.com/security/rate-limiting) | P0 | ✅ 已做。保护登录、注册、setup、改密，防爆破和撞库。 |
| [Authentication](https://docs.nestjs.com/security/authentication) | P0/P1 | ✅ 已做错误收敛、setup 保护、服务端 session/refresh token。 |
| [Authorization](https://docs.nestjs.com/security/authorization) | P1 | ✅ 保持 RBAC，不上 CASL/ABAC；补权限矩阵和资源归属测试。 |
| [Helmet](https://docs.nestjs.com/security/helmet) | P0 | ✅ 低成本默认安全头（CSP 暂关，留待 SPA/SSE 策略）。 |
| [Encryption and Hashing](https://docs.nestjs.com/security/encryption-and-hashing) | P1/P2 | ✅ P1 修密码长度边界；⏭️ P2 入库密钥加密暂不做。 |
| [CORS](https://docs.nestjs.com/security/cors) | P1 | ⏭️ 不做。前端与 API 始终同源（dev 代理/prod 同 host），不开 CORS 即最安全。 |
| [CSRF Protection](https://docs.nestjs.com/security/csrf) | 条件触发 | ⏭️ 不触发。混合方案状态变更走 Bearer header，不靠 cookie 自动携带。 |

## P0 - 先关外部攻击面

### 1. Auth endpoints 限流 ✅

**Objective:** 给高风险公开接口加限流，覆盖未知用户名和已知用户名。

**Nest doc:** [Rate limiting](https://docs.nestjs.com/security/rate-limiting)

**Tasks:**
- 引入 `@nestjs/throttler`。
- 对 `/auth/login`、`/auth/register`、`/auth/setup`、`/auth/update-password` 设置更严格限流。
- tracker 至少包含 IP；登录接口最好组合 IP + normalized username。
- 不存在用户也要计入限流桶，避免枚举和爆破绕过。

**Likely paths:**
- `apps/api/src/auth/auth.module.ts`
- `apps/api/src/auth/auth.controller.ts`
- `apps/api/src/auth/guards/*`
- `apps/api/src/users/user.service.ts`

**Verification:**
- 单测覆盖登录多次失败触发 429。
- 单测覆盖不存在用户名也触发限流。

### 2. 登录错误收敛

**Objective:** 公共登录接口不泄露“用户不存在 / 待审批 / 已停用 / 临时密码过期”等状态细节。

**Nest doc:** [Authentication](https://docs.nestjs.com/security/authentication)

**Tasks:**
- `/auth/login` 外部统一返回“用户名或密码错误”或“登录失败”。
- 内部保留具体原因用于审计日志和管理员视图。
- 不改变管理员后台用户列表里的状态展示。

**Likely paths:**
- `apps/api/src/users/user.service.ts`
- `apps/api/src/auth/auth.service.ts`
- `apps/api/src/common/filters/http-exception.filter.ts`

**Verification:**
- 单测覆盖不存在用户、密码错误、待审批、停用账号在登录接口返回同类错误。

### 3. 保护首次 setup

**Objective:** 防止生产环境首次启动时，公开 `/auth/setup` 被抢先创建 super admin。

**Nest doc:** [Authentication](https://docs.nestjs.com/security/authentication)

**Tasks:**
- 生产环境要求 bootstrap token，或只允许本机/桌面初始化。
- setup 创建 super admin 需要处理并发竞态。
- 文档化初始化方式。

**Likely paths:**
- `apps/api/src/auth/auth.controller.ts`
- `apps/api/src/auth/auth.service.ts`
- `apps/api/src/users/user.service.ts`
- `scripts/init.mjs`

**Verification:**
- 无 bootstrap token 时生产 setup 被拒绝。
- setup 已完成后重复请求仍被拒绝。

### 4. Helmet 默认安全头

**Objective:** 为 API/静态前端启用基础 HTTP 安全头。

**Nest doc:** [Helmet](https://docs.nestjs.com/security/helmet)

**Tasks:**
- 引入 `helmet`。
- 在 `main.ts` 初始化 early middleware。
- 如果影响本地静态资源、SSE、下载等，再按路径微调配置。

**Likely paths:**
- `apps/api/src/main.ts`
- `apps/api/package.json`

**Verification:**
- 精准单测或轻量集成检查关键 header。

## P1 - 会话和权限成体系

### 5. 服务端 session / refresh token 设计与落地

**Objective:** 解决 7 天 bearer token + localStorage 持久化带来的失窃窗口和无法服务端 logout/revoke 的问题。

**Nest doc:** [Authentication](https://docs.nestjs.com/security/authentication)

**Tasks:**
- access token 改短时效，例如 15-30 分钟。
- 新增服务端 session/refresh token 表，只存 refresh token hash。
- 登录创建 session；refresh 轮换 refresh token；logout revoke 当前 session。
- 改密、重置密码、禁用/删除用户时撤销相关 session。
- 决策 token 传输方式：
  - 若继续 Authorization bearer：CSRF 暂缓，但 XSS 风险仍要靠 CSP/前端安全控制。
  - 若改 HttpOnly cookie：必须补 CSRF。

**Likely paths:**
- `apps/api/prisma/schema.prisma`
- `apps/api/src/auth/**`
- `apps/api/src/users/**`
- `apps/web/src/stores/auth-store.ts`
- `apps/web/src/lib/http.ts`
- `packages/shared/src/api/auth.ts`

**Verification:**
- refresh token 轮换测试。
- logout 后旧 refresh token 不可用。
- 改密/禁用后旧 access/session 不可继续访问。

### 6. RBAC 权限矩阵和资源归属测试

**Objective:** 不引入 CASL/ABAC，先把现有角色模型写清楚并用测试锁住。

**Nest doc:** [Authorization](https://docs.nestjs.com/security/authorization)

**Tasks:**
- 写清 `super_admin / admin / user` 能做哪些动作。
- admin 只能管理普通用户；不能管理 admin/super_admin。
- user 只能访问自己的 workspace/conversation/run。
- admin 面板接口统一 `@Roles("admin")`，资源接口统一从 `@CurrentUser()` 传 `userId` 到 service。

**Likely paths:**
- `apps/api/src/auth/guards/roles.guard.ts`
- `apps/api/src/users/user.service.ts`
- `apps/api/src/workspaces/**`
- `apps/api/src/conversations/**`
- `apps/api/src/runs/**`

**Verification:**
- 单测覆盖越权访问他人 workspace/conversation 被拒绝或查不到。
- 单测覆盖 admin 不能重置 admin/super_admin 密码。

### 7. CORS 策略明确化

**Objective:** 明确 API 允许哪些来源访问，避免部署时误开全域。

**Nest doc:** [CORS](https://docs.nestjs.com/security/cors)

**Tasks:**
- 生产默认同源。
- 开发允许 Vite dev server。
- 桌面壳如需特殊 origin，显式配置。
- 配置来自 env，不在代码里散落。

**Likely paths:**
- `apps/api/src/main.ts`
- `apps/api/src/config/**`
- `apps/api/.env.example`

**Verification:**
- 配置解析单测。
- 允许/拒绝 origin 的轻量测试。

### 8. 密码 hash 边界

**Objective:** 当前 bcrypt cost 10 可以先保留，但要处理 bcrypt 72 bytes 限制，并规划 Argon2id。

**Nest doc:** [Encryption and Hashing](https://docs.nestjs.com/security/encryption-and-hashing)

**Tasks:**
- 对密码按 UTF-8 byte length 校验 bcrypt 限制，或切换 Argon2id。
- 密码策略保持用户友好：长度、常见弱密码 blocklist 优先，不做过度复杂规则。
- 临时密码继续用高熵随机生成。

**Likely paths:**
- `apps/api/src/users/password-hasher.service.ts`
- `apps/api/src/users/user-credentials.ts`
- `apps/web/src/utils/validation.ts`

**Verification:**
- 单测覆盖超长多字节密码。
- 单测覆盖弱密码拒绝和临时密码生成。

## P2 - 审计与敏感数据保护

### 9. 安全审计日志

**Objective:** 为登录、失败、锁定、改密、重置、禁用、删除、权限拒绝提供可追踪事件。

**Nest doc:** [Authentication](https://docs.nestjs.com/security/authentication), [Authorization](https://docs.nestjs.com/security/authorization)

**Tasks:**
- 记录 action、actorUserId、targetUserId、IP、userAgent、result、reasonCode、requestId。
- 不记录明文密码、token、api key。
- 可先写结构化日志，后续再入库。

**Likely paths:**
- `apps/api/src/auth/**`
- `apps/api/src/users/**`
- `apps/api/src/common/logging.ts`

**Verification:**
- 单测覆盖敏感字段不会进入日志 payload。

### 10. 入库密钥加密

**Objective:** 保护 `ModelProvider.apiKey` 等长期密钥，避免数据库泄露后直接可用。

**Nest doc:** [Encryption and Hashing](https://docs.nestjs.com/security/encryption-and-hashing)

**Tasks:**
- 引入 server-side encryption key。
- 新增密钥加密/解密服务。
- 写入时加密，使用时解密。
- 考虑已有 dev.db 兼容或明确 pre-launch 不迁移。

**Likely paths:**
- `apps/api/src/model-providers/**`
- `apps/api/src/config/**`
- `apps/api/prisma/schema.prisma`

**Verification:**
- 单测覆盖数据库保存值不是明文。
- 单测覆盖读取后业务仍拿到原始 key。

## Conditional - Cookie 后才做 CSRF

### 11. CSRF Protection

**Trigger:** 只有当 session/refresh token 改成 HttpOnly cookie 自动携带时才执行。

**Nest doc:** [CSRF Protection](https://docs.nestjs.com/security/csrf)

**Tasks:**
- 引入 `cookie-parser` 和 `csrf-csrf`。
- 对状态变更请求要求 CSRF token。
- 登录/refresh/logout 流程定义 token 获取和刷新方式。

**Verification:**
- 无 CSRF token 的 POST/PUT/DELETE 被拒绝。
- 带合法 CSRF token 的请求通过。

## 暂不做

| 项 | 原因 |
|---|---|
| CASL / ABAC | 当前没有 workspace 共享、组织、项目级角色；先用 RBAC + 资源归属。 |
| OAuth / 第三方登录 | 当前明确只做用户名密码。 |
| 邮箱验证 / 忘记密码邮件 | 当前明确不做邮箱；忘记密码走管理员重置。 |
| MFA / 2FA | 可作为以后增强，不是当前最短板。 |
| 全面 Express session middleware | 如果采用 JWT + refresh token 表，不一定需要。 |

## 推荐实施顺序

1. P0-1 `@nestjs/throttler` 限流。
2. P0-2 登录错误收敛。
3. P0-3 setup bootstrap 保护。
4. P0-4 Helmet。
5. P1-5 服务端 session/refresh token。
6. P1-6 RBAC 权限矩阵和资源归属测试。
7. P1-7 CORS 策略。
8. P1-8 密码 hash 边界。
9. P2-9 审计日志。
10. P2-10 入库密钥加密。
11. Conditional-11 cookie 化后补 CSRF。
