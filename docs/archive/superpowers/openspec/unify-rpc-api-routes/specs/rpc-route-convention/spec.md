## ADDED Requirements

### Requirement: RPC 接口使用语义动作路径
所有 RPC 风格接口 SHALL 使用语义明确的动作名作为路径最后一段。

通用操作 SHALL 使用统一动作名：
- `create` — 创建资源
- `remove` — 删除资源
- `update` — 更新资源，包括重命名等局部更新
- `query` — 查询单条资源
- `list` — 查询资源列表

领域专属操作 MAY 使用符合业务语义的动作名，例如 `archive`、`unarchive`、`stop`、`run`、`reply`、`ping`、`approve`、`set-enabled`、`update-password`。

接口 SHALL NOT 混用同义动作名（如 `delete`/`remove`、`rename`/`update`、`get`/`query`）。

#### Scenario: 创建操作使用 create
- **WHEN** 客户端调用创建接口
- **THEN** 路径最后一段 SHALL 为 `create`

#### Scenario: 删除操作使用 remove
- **WHEN** 客户端调用删除接口
- **THEN** 路径最后一段 SHALL 为 `remove`

#### Scenario: 更新操作使用 update
- **WHEN** 客户端调用更新接口
- **THEN** 路径最后一段 SHALL 为 `update`

#### Scenario: 查询单条使用 query
- **WHEN** 客户端调用查询单条接口
- **THEN** 路径最后一段 SHALL 为 `query`

#### Scenario: 查询列表使用 list
- **WHEN** 客户端调用查询列表接口
- **THEN** 路径最后一段 SHALL 为 `list`

### Requirement: 实体 ID 统一使用 `id` 参数并按方法传递
所有需要指定目标实体 ID 的外部 RPC 接口，参数名 SHALL 统一为 `id`。

- GET `query`/`list` 操作 SHALL 通过 URL Query 传递参数：`?id=xxx`
- POST 操作 SHALL 通过请求 Body 传递参数：`{ id: string }`
- 外部 API SHALL NOT 通过 Path 参数传递实体 ID

#### Scenario: 删除操作通过 Body 传递 ID
- **WHEN** 客户端调用 `POST /conversations/remove`
- **THEN** 请求 Body SHALL 包含 `{ id: string }`

#### Scenario: 更新操作通过 Body 传递 ID
- **WHEN** 客户端调用 `POST /conversations/update`
- **THEN** 请求 Body SHALL 包含 `{ id: string }` 和更新字段

#### Scenario: 查询单条通过 URL 参数传递 ID
- **WHEN** 客户端调用 `GET /conversations/query`
- **THEN** 请求 URL 参数 SHALL 包含 `?id=xxx`

#### Scenario: 外部操作不使用 Path 参数传递 ID
- **WHEN** 客户端调用停止对话运行接口
- **THEN** 路径 SHALL 为 `POST /agent/stop`
- **AND** 请求 Body SHALL 包含 `{ id: string }`

**例外**：
- 内部 API（`/internal/*`）保持现有 Path 参数方式

### Requirement: 外部 API 统一使用 GET 和 POST
所有外部 API（非 `/internal/*`）SHALL 仅使用 `@Get()` 和 `@Post()` 装饰器。

- `@Get()` — 用于无副作用的查询操作（`list`、`query`），参数通过 URL 参数传递
- `@Post()` — 用于有副作用的操作（`create`、`remove`、`update`、`archive`、`unarchive`、`stop`），参数通过 Body 传递

#### Scenario: 查询列表使用 GET
- **WHEN** 客户端调用 `GET /conversations/list`
- **THEN** 后端 SHALL 使用 `@Get()` 装饰器

#### Scenario: 删除操作使用 POST
- **WHEN** 客户端调用 `POST /conversations/remove`
- **THEN** 后端 SHALL 使用 `@Post()` 装饰器

### Requirement: Admin 路由统一使用 `/admin` 前缀并组织为独立 Controller 文件
所有 Admin 专用路由 SHALL 使用 `/admin` URL 前缀，并放在独立的 Controller 文件中，文件位于对应模块的 `admin/` 子目录下。

#### Scenario: Admin Controller 文件结构
- **WHEN** 查看 Admin 路由对应的 Controller 文件
- **THEN** 文件 SHALL 位于 `admin/` 子目录下（如 `model-providers/admin/admin-model-provider.controller.ts`）

#### Scenario: Admin 路由前缀
- **WHEN** 查看 Admin 路由
- **THEN** 路径 SHALL 以 `admin/` 开头（如 `/admin/model-providers/list`）

#### Scenario: User Admin 路由前缀
- **WHEN** 查看用户管理路由
- **THEN** 路径 SHALL 以 `/admin/users/` 开头（如 `POST /admin/users/create`）

### Requirement: 操作类接口统一返回结果结构
所有操作类接口（`create`、`remove`、`update`、`archive`、`unarchive`、`stop`）SHALL 返回统一的结果结构。

- 成功时返回 `{ success: true }` 或操作后的完整实体对象
- 失败时抛出对应的 HTTP 异常

#### Scenario: 删除操作返回成功状态
- **WHEN** 客户端调用 `POST /conversations/remove` 成功
- **THEN** 响应 SHALL 包含 `{ success: true }`

#### Scenario: 创建操作返回完整实体
- **WHEN** 客户端调用 `POST /conversations/create` 成功
- **THEN** 响应 SHALL 返回创建的完整 Conversation 实体

### Requirement: 列表接口统一返回 `{ list, total }` 结构
所有 `list` 类接口 SHALL 返回统一的列表响应结构。

- 非分页列表 SHALL 返回 `ListResponse<T>`：`{ list: T[]; total?: number }`
- 分页列表 SHALL 返回 `PaginatedListResponse<T>`：`{ list: T[]; total: number; pageNo: number; pageSize: number }`
- 列表字段 SHALL 统一命名为 `list`，SHALL NOT 使用 `items`、`conversations` 等命名
- 分页查询参数 SHALL 统一命名为 `pageNo` 和 `pageSize`，SHALL NOT 使用 `page`、`pageNum` 等命名

共享类型定义在 `packages/shared/src/common/index.ts`。

#### Scenario: 非分页列表返回 `{ list, total }`
- **WHEN** 客户端调用 `GET /workspaces/list`
- **THEN** 响应 SHALL 包含 `{ list: WorkspaceResponse[]; total: number }`

#### Scenario: 分页列表返回 `{ list, total, pageNo, pageSize }`
- **WHEN** 客户端调用 `GET /admin/runs/list?pageNo=2&pageSize=20`
- **THEN** 响应 SHALL 包含 `{ list: AdminRunResponse[]; total: number; pageNo: 2; pageSize: 20 }`

#### Scenario: 列表字段统一命名
- **WHEN** 客户端调用任何 `list` 接口
- **THEN** 响应中的列表字段 SHALL 命名为 `list`，SHALL NOT 使用 `items` 或其他名称
