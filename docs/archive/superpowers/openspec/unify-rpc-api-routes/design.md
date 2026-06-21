## Context

当前后端 API 采用 RPC-over-HTTP 风格，但缺乏统一的命名和结构约定。不同 Controller 之间的接口风格差异明显：

- **动词不统一**：`create`、`delete`、`remove`、`rename`、`archive`、`unarchive` 混用
- **ID 传递方式混乱**：Query 参数、Body 参数、Path 参数三种方式并存
- **HTTP 方法单一**：外部 API 仅使用 `@Get()` 和 `@Post()`，但内部 API 使用 `@Get()`、`@Post()`、`@Delete()`
- **Admin 路由组织不一致**：有的放在同一文件，有的单独文件

这些不一致增加了前端调用成本、文档维护难度和新人理解门槛。

## Goals / Non-Goals

**Goals:**
- 建立一套清晰的 RPC 接口命名规范
- 统一所有外部 API 的 URL 路径、HTTP 方法和参数传递方式
- 统一 Admin 路由的组织方式
- 保持内部 API（`/internal/*`）不变，避免影响 worker 通信

**Non-Goals:**
- 不改变内部 API（`/internal/*`）的风格
- 不引入新的中间件或装饰器
- 不改变业务逻辑，仅调整接口契约
- 不迁移到纯 REST 风格

## Decisions

### Decision 1: RPC 动词按语义命名

**选择**：RPC 路径最后一段使用语义明确的动作名。通用 CRUD 和查询操作使用统一动作名；领域专属操作允许使用符合业务语义的动作名。

| 操作类型 | 动词 | 示例 |
|---------|------|------|
| 创建 | `create` | `POST /conversations/create` |
| 删除 | `remove` | `POST /conversations/remove` |
| 更新 | `update` | `POST /conversations/update` |
| 查询单条 | `query` | `GET /conversations/query` |
| 查询列表 | `list` | `GET /conversations/list` |
| 归档 | `archive` | `POST /conversations/archive` |
| 取消归档 | `unarchive` | `POST /conversations/unarchive` |
| 停止/中断 | `stop` | `POST /agent/stop` |
| 运行 | `run` | `POST /agent/run` |
| 回复人工确认 | `reply` | `POST /agent/reply` |
| 连通性检测 | `ping` | `POST /model-providers/ping` |
| 审批用户 | `approve` | `POST /admin/users/approve` |

**理由**：
- 通用操作保持稳定命名，避免 `delete/remove`、`rename/update`、`get/query` 混用
- 领域动作保留业务语义，避免把 `run`、`reply`、`approve` 等接口硬塞进 `update`
- 替代方案：固定动词白名单 → 拒绝，会让领域动作命名变得别扭，也和现有任务中的 `run`、`reply`、`ping`、`approve` 不一致

### Decision 2: ID 参数统一命名为 `id`，按 HTTP 方法传递

**选择**：所有需要指定目标实体 ID 的外部 RPC 接口，参数名统一为 `id`。查询类接口通过 Query 传递，操作类接口通过 Body 传递。

- `GET query/list`：通过 URL Query 传参，例如 `GET /conversations/query?id=xxx`
- `POST create/update/remove/archive/unarchive/stop`：通过请求 Body 传参，例如 `POST /conversations/remove` + `{ "id": "xxx" }`

**例外**：
- 内部 API（`/internal/*`）保持 Path 参数不变

**理由**：
- GET 查询保持可缓存、可复制 URL 的语义，`query/list` 的查询条件统一在 Query 中表达
- RPC 操作的参数作为调用入参放在 Body 中，避免把实体 ID 混入 Path
- 统一目标实体 ID 名为 `id`，前端调用不需要在 `conversationId`、`workspaceId`、`userId` 之间切换
- 替代方案：所有 ID 统一放 Body → 拒绝，会让 GET 查询参数规则变得特殊且不直观
- 替代方案：外部 API 保留 Path 参数 → 拒绝，会继续混入 REST 风格和嵌套资源路径

### Decision 3: 外部 API 仅使用 GET 和 POST

**选择**：外部 API 统一使用 `@Get()`（查询类）和 `@Post()`（操作类），不使用 `@Put()`、`@Patch()`、`@Delete()`。

**理由**：
- 符合 RPC 语义：所有操作都是"远程过程调用"，GET 对应无副作用查询，POST 对应有副作用操作
- 与现有代码风格一致，改动量最小
- 替代方案：引入 PUT/PATCH/DELETE → 拒绝，与 RPC 风格冲突

### Decision 4: Admin 路由统一使用 `/admin` 前缀和独立 Controller 文件

**选择**：所有 Admin 专用接口的 URL SHALL 以 `/admin` 开头，并对应一个独立的 Controller 文件，文件放在模块的 `admin/` 子目录下。

**当前问题**：
- `model-provider.controller.ts` 一个文件包含两个 Controller
- `user.controller.ts` 一个 Controller 加 `@Roles("admin")`，但 URL 仍是 `/users/*`
- `workspaces` 有单独的 `admin-workspace.controller.ts`

**统一后**：
```
model-providers/
  model-provider.controller.ts      → /model-providers/*
  admin/
    admin-model-provider.controller.ts → /admin/model-providers/*
users/
  admin/
    admin-user.controller.ts           → /admin/users/*
workspaces/
  workspace.controller.ts           → /workspaces/*
  admin/
    admin-workspace.controller.ts   → /admin/workspaces/*
```

**理由**：
- 文件结构清晰，权限边界明确
- URL 层也能直接看出接口的 Admin 属性，避免 admin-only 接口混在 public-looking 的 `/users/*` 下
- 替代方案：全部合并到同一文件 → 拒绝，文件会过大且权限混淆

### Decision 5: 响应结构统一

**选择**：
- 查询单条接口（`query`）：返回完整实体
- 查询列表接口（`list`）：统一使用 `{ list, total }` 结构；分页列表额外返回 `{ list, total, pageNo, pageSize }`
- 操作类接口（`create`、`remove`、`update`）：返回 `{ success: boolean }` 或操作后的完整实体

分页列表与非分页列表的区别：
- 非分页列表：`{ list: T[]; total?: number }` — `total` 可选，建议返回以支持前端展示"共 N 条"
- 分页列表：`{ list: T[]; total: number; pageNo: number; pageSize: number }` — `total` 必选，额外返回当前页码和每页条数

分页查询参数命名：统一使用 `pageNo` 和 `pageSize`，不使用 `page`、`pageNum` 等变体。

共享类型定义在 `packages/shared/src/common/index.ts`：`ListResponse<T>` 和 `PaginatedListResponse<T>`。

**理由**：
- 统一前端消费列表接口的代码模式，避免裸数组、命名数组、`items` 等多种写法并存
- `total` 字段让前端无需额外请求即可展示总数或判断空状态
- 简化前端错误处理（HTTP 状态码 + `success` 字段双重确认）
- 替代方案：统一返回完整实体 → 拒绝，`remove` 操作返回已删除实体无意义
- 替代方案：列表只返回数组 → 拒绝，缺少总数信息，前端无法展示"共 N 条"

## Risks / Trade-offs

| 风险 | 缓解措施 |
|------|---------|
| **BREAKING CHANGE**：所有前端调用代码需要同步更新 | 一次性全部修改，配合前端代码同步更新；在 commit message 中明确标注 BREAKING |
| **测试覆盖不足**：改动量大，可能遗漏某些接口** | 修改后运行全部测试（`pnpm test:api`），逐一验证每个 Controller |
| **文档过时**：API 文档需要重新生成 | 修改完成后重新生成 API 文档，或更新手动维护的文档 |
| **IDE 自动补全失效**：前端 API 客户端类型需要更新 | 同步更新前端 API 调用代码和类型定义 |

## Migration Plan

1. **Phase 1：制定规范**（当前阶段）
   - 完成 design.md 和 spec.md
   - 与团队确认规范

2. **Phase 2：后端修改**
   - 按 Controller 逐个修改 URL 路径、参数方式和响应结构
   - 同步更新对应的 DTO 和 Service 调用
   - 运行测试确保通过

3. **Phase 3：前端同步**
   - 更新前端所有 API 调用代码
   - 更新类型定义

4. **Phase 4：验证**
   - 端到端测试
   - 文档更新

## Open Questions

- ✅ `POST /auth/change-password` 和 `POST /auth/complete-password-change` → 合并为 `POST /auth/update-password`
- ✅ `POST /agent/run` → 保持现状
- ✅ `GET /conversations/messages` → `GET /conversations/messages/list?id=`（Query 参数传 conversation 的 `id`）
