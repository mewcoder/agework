## Why

当前 API 路由存在命名不一致、ID 传递方式混乱、HTTP 方法使用不规范等问题。虽然采用 RPC 风格，但缺乏统一的约定，导致不同 Controller 的接口风格各异，增加了前端调用和后端维护的成本。

## What Changes

- **统一 RPC 命名规范**：所有接口统一使用语义明确的动作路径；通用 CRUD 和查询操作优先使用 `create`、`remove`、`update`、`query`、`list`，领域动作只要符合业务语义即可
- **统一 ID 参数命名和传递方式**：目标实体 ID 统一命名为 `id`；`GET query/list` 通过 Query 传参，`POST` 操作通过 Body 传参，禁止外部 API 使用 Path 参数传递实体 ID
- **统一 HTTP 方法**：外部 API 统一使用 `@Get()`（查询）和 `@Post()`（操作），内部 API 保持现有风格
- **统一 Admin 路由组织**：所有 Admin 接口统一使用 `/admin` URL 前缀，并放在独立 Controller 文件中
- **统一响应结构**：操作类接口统一返回 `{ success: boolean }` 或完整实体对象；列表接口统一返回 `{ list, total }`，分页列表额外返回 `pageNo` 和 `pageSize`

**BREAKING**：所有外部 API 的 URL 路径和请求/响应格式将发生变更，前端调用代码需要同步更新。

## Capabilities

### New Capabilities
- `rpc-route-convention`: 定义 RPC 风格接口的统一命名规范，包括动词选择、ID 传递方式、HTTP 方法使用规则

### Modified Capabilities
- （无现有 spec，此项为空）

## Impact

- **后端**：`apps/api/src/` 下所有 Controller 文件（13 个文件，15 个 Controller）
- **前端**：所有 API 调用代码需要同步更新路径和参数格式
- **测试**：所有 Controller 和 Service 的测试用例需要更新
- **文档**：API 文档需要重新生成
