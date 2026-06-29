# Backend and API Naming Rules

适用于 `apps/api` 的后端命名规则,并覆盖与后端 API 契约直接相关的 `apps/web/src/api`、`apps/web/src/types`、`apps/web/src/store`、`apps/web/src/pages` 命名。

普通功能改动只约束新增代码和触碰到的局部命名;历史文件、目录或 API 的命名收敛放进专项迁移。

## 0. 核心原则

- 默认全部使用单数业务语义。
- 只有两个例外使用复数:
  - HTTP API path 的资源段: `/users`、`/runtimes`、`/model-providers`。
  - 前端 API 文件名: `apps/web/src/api/users.ts`、`runtimes.ts`、`model-providers.ts`。
- 文件名使用 `kebab-case + role suffix`: `user.service.ts`、`model-provider.repository.ts`、`admin-run-query.dto.ts`。
- 类名使用 `PascalCase + role suffix`: `UserService`、`ModelProviderRepository`、`AdminRunListQueryDto`。
- 禁止 `*.use-case.ts` / `XxxUseCase`,避免引入 Clean Architecture / CQRS 风格。
- 内部文件不要滥用 `*.service.ts`;具体职责后缀优先于 service 后缀。

## 1. 单复数矩阵

| 位置 | 规则 | 示例 |
|---|---|---|
| Entity / 类型名 | 单数 PascalCase | `User`、`Runtime`、`Workspace` |
| Backend feature module 目录 | 单数 kebab-case | `apps/api/src/user/`、`runtime/`、`model-provider/` |
| Backend module 根文件核心 | 单数 kebab-case | `user.module.ts`、`runtime.controller.ts` |
| HTTP API path 资源段 | 复数 kebab-case | `/users`、`/runtimes`、`/model-providers` |
| Web API 文件 | 复数 kebab-case | `users.ts` -> `/users` |
| Web Store | 单数 PascalCase 业务名 | `useUserStore.ts`、`useRuntimeStore.ts` |
| Web `types/` 文件 | 单数 PascalCase | `User.ts`、`Runtime.ts` |
| Web 页面文件 | 单数业务语义 | `pages/admin/user.tsx`、`pages/settings/workspace.tsx` |
| 组件 / 普通业务文件 | 单数业务语义 | `user-form.tsx`、`runtime-panel.tsx` |

页面文件就是路由映射,必须使用业务语义单数。即使页面展示列表,也用 `pages/admin/user.tsx`,不要用 `users.tsx` 表达集合。

历史复数目录暂不混进普通改动里重命名,如 `users/`、`workspaces/`、`runs/`、`conversations/`;后续专项命名迁移时再统一。

## 2. Backend 命名

### 2.1 Module 与文件

- 新增 feature module 目录名使用单数业务名: `user/`、`workspace/`、`run/`、`runtime/`。
- 模块根文件名核心使用单数领域名: `user.module.ts`、`user.service.ts`、`user.repository.ts`。
- Admin 文件保持 `admin-<feature>.<role>.ts`: `admin-user.controller.ts`、`admin-user-query.dto.ts`。
- 历史不一致项后续专项迁移时再统一,不要混进无关改动。

### 2.2 方法

- Service 方法默认不带模块名: 在 `UserService` 中写 `create()`、`list()`、`update()`,不写 `createUser()`。
- Controller 方法优先贴合路由语义;同一 Controller 暴露多个读取端点时,可以补对象名,如 `getRunConfig()`、`getRuntimePolicy()`、`queryStatuses()`。
- 只有在同一个类中确实存在多个同类对象时,才在方法名中补对象名。
- `list` 表示列表查询。
- `findBy...` 表示按条件查单个或少量数据,允许返回空。
- `get...` 表示配置、确定存在的值或对外语义已经固定的读取方法。
- `query` 主要用于 HTTP endpoint 名称或专门的 internal query provider,不要和 `find/get/list` 随意混用;query provider 仍由 Root Service 调用,Controller 不直连。
- 同一个模块内同一动作只选一个动词。

### 2.3 删除

- Controller 对外动作用 `remove`: `@Post("remove") remove(...)`。
- Service 可以使用 `delete`,表达业务删除动作。
- Repository 明确区分数据动作: `softDelete`、`delete`、`deleteMany`。
- 归档不是删除,使用 `archive` / `unarchive`。

### 2.4 DTO

- Body DTO 使用 `<Action><Feature>Dto`: `CreateUserDto`、`UpdateWorkspaceDto`。
- Query DTO 使用 `<Feature><Purpose>QueryDto` 或 `Admin<Feature><Purpose>QueryDto`: `ConversationListQueryDto`、`AdminUserListQueryDto`。
- Param / id DTO 使用 `<Feature>IdDto`: `UserIdDto`、`WorkspaceIdDto`。
- DTO 只表示外部输入校验,不要把响应模型命名成 DTO。

### 2.5 Internal provider 后缀

- 具体职责后缀优先于 `service`: `*.policy.ts`、`*.registry.ts`、`*.executor.ts`、`*.handler.ts`。
- `*.service.ts` 留给根 Service、业务 facade,或没有更具体职责名的 Nest provider。
- `Provider` 是 Nest DI 概念,不是推荐类名后缀。`ModelProvider`、`RuntimeProvider` 这类业务术语可以保留;泛泛表示内部实现层时不要叫 `XxxProvider`。
- Root Service 下的一层统一叫 internal provider,但具体文件和类名必须表达职责。
- 避免抽象空词: `helper`、`utils`、`core`。除非它是外部协议、SDK 或现有产品术语。

常用后缀:

| 后缀 | 用途 | 示例 |
|---|---|---|
| `XxxHandler` | 处理入口流程或事件入口 | `WorkerEndpointHandler` |
| `XxxRegistry` | 维护注册表、port 实例映射或多态实现表 | `LiveRunRegistry` |
| `XxxStore` | 模块内状态存储 | `WorkerConfigStore` |
| `XxxDispatcher` | 下发命令、分发消息或投递动作 | `WorkerCommandDispatcher` |
| `XxxPolicy` | 封装策略判断,不做 I/O 编排 | `RuntimePlacementPolicy` |
| `XxxExecutor` | 执行运行单元或任务生命周期 | `LocalRunExecutor` |
| `XxxRepository` | 数据库访问边界 | `WorkspaceRepository` |
| `XxxAdapter` | 外部 SDK、协议或基础设施适配 | `DockerSandboxAdapter` |
| `XxxParser` | 协议 / 文本解析 | `WorkerEventParser` |
| `XxxFactory` | 创建复杂对象或 provider 实例 | `RuntimeTargetFactory` |
| `XxxGuard` | Nest guard | `WorkerAuthGuard` |
| `XxxPort` | 下层基础设施/执行层向上回流的窄反向契约 | `WorkerUpstreamPort` |

Port 命名:

- 新增反向回调契约统一叫 `XxxPort`,接线方法统一叫 `setXxxPort(...)`。
- 不新增 `XxxSink` / `XxxReceiver` / `XxxRecorder` 作为反向回调契约名;历史命名可在专项迁移中收敛。
- `Port` 只表示窄契约类型,不要因此新增 `ports/`、`adapters/` 分层目录。
- Port 仅用于下层基础设施/执行层向上回流;平级业务领域之间的反向需求改 flip / 参数喂 / 上提用例 owner(判定见架构 §2.2 决策链)。

## 3. Web 命名

- `apps/web/src/api/*` 文件使用复数,并和 API path 资源段一致: `users.ts` -> `/users`。
- `apps/web/src/types/*` 实体类型文件使用单数 PascalCase: `User.ts`、`Runtime.ts`。
- Store 使用单数业务名: `useUserStore.ts`、`useRuntimeStore.ts`。
- 页面文件就是路由映射,必须使用业务语义单数: `pages/admin/user.tsx`、`pages/admin/runtime.tsx`、`pages/settings/workspace.tsx`。
- 组件文件、普通业务文件默认使用单数业务语义。

## 4. HTTP API URL 与动作命名

本仓库外部 API 采用 RPC-over-HTTP 风格,不是纯 REST 风格。URL 的复数资源段表达业务 owner,最后一段表达动作。

### 4.1 基本形状

- 外部 API 固定挂在 `/api/v1` 下。
- 外部 API 只使用 `GET` 和 `POST`:
  - `GET` 只做无副作用查询,参数放 URL Query。
  - `POST` 用于创建、更新、删除、状态变更、运行控制等有副作用操作,参数放 Body。
- URL 资源段使用复数 kebab-case: `/users`、`/runtimes`、`/model-providers`。
- URL 使用 `kebab-case`,动作名放在路径最后一段。
- 普通外部 API 不通过 Path 参数传实体 ID,例如不要新增 `/workspaces/:id/update`。
- 内部协议接口和 worker 回调接口可以按协议需要例外,但不要把例外扩散到普通外部 API。

标准形状:

```text
GET  /api/v1/<resources>/list
GET  /api/v1/<resources>/query?id=...
POST /api/v1/<resources>/create
POST /api/v1/<resources>/update
POST /api/v1/<resources>/remove
POST /api/v1/<resources>/<domain-action>
```

Admin 形状:

```text
GET  /api/v1/admin/<resources>/list
GET  /api/v1/admin/<resources>/query?id=...
POST /api/v1/admin/<resources>/update
POST /api/v1/admin/<resources>/remove
```

子资源列表也要保留动作段:

```text
GET /api/v1/conversations/messages/list?conversationId=...
GET /api/v1/admin/runs/events/list?runId=...
GET /api/v1/admin/runtime/resources/list
```

### 4.2 通用动作

| 场景 | 动作 | 示例 |
|---|---|---|
| 创建 | `create` | `POST /workspaces/create` |
| 更新 | `update` | `POST /workspaces/update` |
| 删除 | `remove` | `POST /workspaces/remove` |
| 单条详情 | `query` | `GET /conversations/query?id=...` |
| 列表查询 | `list` | `GET /admin/users/list?pageNo=1&pageSize=20` |

避免同义词混用:

- 删除接口用 `remove`,不要新增 `delete`。
- 更新接口用 `update`,不要新增 `rename`。
- 单条查询用 `query`,不要新增 `get` 作为通用详情动作。
- 列表查询用 `list`,不要用 `all`、`page`、`paging` 表达分页。

### 4.3 领域动作

领域动作允许保留业务语义,不要为了 CRUD 统一而牺牲可读性。当前允许的领域动作包括:

- `archive` / `unarchive`
- `run` / `reply` / `stop`
- `ping`
- `approve`
- `set-enabled`
- `update-password`
- `clear-archived`

读取配置、能力、统计等非实体详情时,可以使用名词型路径,例如 `config`、`capabilities`、`policy`、`stats`、`system-info`。

### 4.4 ID 与参数

- 外部 API 的目标实体 ID 统一命名为 `id`。
- `GET /query` 通过 Query 传 ID: `?id=...`。
- `POST` 操作通过 Body 传 ID: `{ "id": "..." }`。
- 列表过滤参数按业务命名,如 `status`、`agentType`、`runId`。

### 4.5 分页与列表响应

分页参数统一使用:

```text
pageNo=1&pageSize=20
```

不要使用 `page`、`pageNum`、`limit`、`offset` 作为外部 API 参数名。

列表响应统一使用 `@agework/shared` 中的类型:

```ts
type ListResponse<T> = {
  list: T[];
  total?: number;
};

type PaginatedListResponse<T> = {
  list: T[];
  total: number;
  pageNo: number;
  pageSize: number;
};
```

- 非分页列表返回 `{ list, total? }`。
- 分页列表返回 `{ list, total, pageNo, pageSize }`。
- 列表字段必须叫 `list`,不要新增 `items`、`rows` 或按资源名命名的数组字段。
- 是否分页不影响 URL 动作名,都叫 `list`。

### 4.6 返回结构

- `query` 返回完整实体或详情对象。
- `list` 返回 `ListResponse<T>` 或 `PaginatedListResponse<T>`。
- `create` 通常返回创建后的完整实体。
- `update` 通常返回更新后的完整实体。
- `remove`、`archive`、`unarchive`、`stop` 等操作可返回 `{ success: true }` 或操作后的实体,按前端需要选择,但同一资源内保持一致。
- 失败使用 NestJS HTTP exception,不要返回 `{ success: false }` 伪成功响应。

## 5. 新接口检查清单

- 是否只在 URL 资源段和前端 API 文件名使用复数,其余命名都使用业务语义单数?
- URL 最后一段是否是统一动作名或清晰领域动作?
- 查询是否使用 `GET`,操作是否使用 `POST`?
- `GET` 参数是否在 Query,`POST` 参数是否在 Body?
- 目标实体 ID 是否叫 `id`?
- 列表接口是否叫 `list`,分页参数是否是 `pageNo` / `pageSize`?
- 列表响应是否使用 `{ list, total }` 或 `{ list, total, pageNo, pageSize }`?
- Admin 接口是否使用 `/admin/...` 前缀并放在 owner module 的 `admin/` 目录?
- 新增 Controller 是否加入 `apps/api/src/common/api-route-convention.spec.ts` 的路由护栏?

## 6. 已知历史迁移项

- `GET /api/v1/admin/workspaces/all` -> `GET /api/v1/admin/workspaces/list`
- ~~`GET /api/v1/admin/runs/events` -> `GET /api/v1/admin/runs/events/list`~~（已完成 2026-06-28，前后端同步改、无兼容旧端点）
- `GET /api/v1/admin/runtime/resources` -> `GET /api/v1/admin/runtime/resources/list`
- 反向契约改名:`WorkerUpstreamReceiver` / `RunEventReceiver` / `*Sink` / `*Recorder` -> `*Port`(随反向依赖整改一并收敛)
- `RunConversationPort` 是历史 broad port debt:方法数超出新规则,普通改动不继续加方法;后续随 agent-run 用例 owner 上提或 run/conversation 边界收敛拆解。

迁移时优先后端和前端 API client 同步改;如果需要兼容旧调用,短期保留旧 endpoint 并在代码注释中标明移除条件。

## 7. 迁移原则

- 不为命名规则单独做大规模 rename。
- 修改历史模块时,只在当前变更范围内顺手收敛命名。
- 如果历史命名和本规则冲突,以“不扩大 diff、不破坏 import、不制造无关迁移”为优先。
