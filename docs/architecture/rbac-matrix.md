# 权限模型（RBAC + 资源归属）

后端只用 **RBAC（三种角色）+ 资源归属（owner 校验）**，不引入 CASL / ABAC。本文是权威的权限矩阵，既给人看，也作为改动护栏。

## 两类访问控制

| 类型 | 粒度 | 落在哪 | 怎么做 |
|---|---|---|---|
| 角色访问控制 | 粗粒度（登录态、角色） | **Guard** | 管理后台接口统一 `@Roles("admin")`；URL 用 `/admin/...` 前缀 |
| 资源归属 | 细粒度（这条数据是不是你的） | **Service / Repository** | 业务接口从 `@CurrentUser()` 取 `userId`，查询一律按 owner 过滤 |

口诀：**admin 只能管普通用户；任何人的业务资源只有本人能碰。**

## 角色能力矩阵

| 动作 | super_admin | admin | user |
|---|:--:|:--:|:--:|
| 审批 / 改角色 / 停用 / 重置密码 / 删除 **普通用户** | ✅ | ✅ | ❌ |
| 管理 **admin** 账号 | ✅（停用，不可删） | ❌ | ❌ |
| 管理 **super_admin** 账号 | ❌（仅本人账号 / 服务器脚本） | ❌ | ❌ |
| 改自己的密码 | ✅ | ✅ | ✅ |
| 访问 / 修改 **他人** 的 workspace / conversation / run | — | ❌ | ❌ |
| 访问 / 修改 **自己** 的 workspace / conversation / run | ✅ | ✅ | ✅ |
| 系统设置、模型供应商等管理后台 | ✅ | ✅ | ❌ |

说明：
- super_admin 账号固定唯一为 `admin`，不能通过任何 API 改动，只能本人登录或服务器脚本维护（`assertCanManage` 在 `user/user.service.ts` 对 super_admin 目标一律拒绝）。
- admin 对 admin / super_admin 一律不可管理（`assertCanManage`：admin operator 遇到非 user 目标即 `Forbidden`）。

## 归属是怎么落地的（实现锚点）

- **workspaces**：用户接口 `list/update/delete` 走 `ownerWhere(userId) = { userId }`；跨用户管理用 `updateAny/listAll`，挂在 `workspace/admin/` 的 `@Roles("admin")` controller 上。
- **conversations**：所有按 id 的读写都带 `workspace: { userId, deletedAt: null }`（`workspaceOwnerWhere`），别人的 `conversationId` 命不中 → 404 / 空列表。
- **runs**：没有独立的用户接口，全部经 `conversations/agent` 端点；每个操作先 `conversationService.findOne(userId, …)` 做归属闸门，别人的对话抛 NotFound，`RunService` 不会被调用。
- **run 历史 / 消息**：经 `conversation.listMessages(userId, …)`，先校验归属再返回，未归属返回 `[]`。

## 不要做

- 不要在业务接口只校验登录态而不带 `userId` 过滤——那是越权读写的口子。
- 不要新增横向 `AdminModule` 接管各领域数据；管理接口仍归属各 feature module 的 `admin/` 子目录。
- 不要为权限引入 CASL / ABAC / policy 引擎；当前没有 workspace 共享、组织、项目级角色。

## 测试锚点

- `user/user.service.spec.ts` — admin 不能重置 admin/super_admin 密码；super_admin 也不能通过 API 重置 super_admin。
- `conversation/conversation.service.spec.ts` — `findOne/delete/archive/unarchive/listMessages` 按 owner 过滤，未归属 404 / 空。
- `agent/agent.service.spec.ts` — `reply/stop/resume` 在归属校验失败时不触达 `RunService`。
- `workspace/workspace.service.spec.ts` — `update/delete` 按 owner 过滤，未归属 404 且不写库。
