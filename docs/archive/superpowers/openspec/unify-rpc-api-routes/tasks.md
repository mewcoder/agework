## 1. Admin 路由组织规范化

- [x] 1.1 将 `model-provider.controller.ts` 拆分为两个文件：`model-provider.controller.ts`（public）和 `admin/admin-model-provider.controller.ts`（admin）
- [x] 1.2 将 `user.controller.ts` 中的 `@Roles("admin")` 路由迁移到 `users/admin/admin-user.controller.ts`
- [x] 1.3 更新 `ModelProviderModule` 和 `UserModule` 的模块注册

## 2. ConversationController 路由规范化

- [x] 2.1 将 `GET /conversations/get?conversationId=` 改为 `GET /conversations/query?id=`
- [x] 2.2 将 `GET /conversations/list` 改为 `GET /conversations/list`（保持不变，确认规范）
- [x] 2.3 将 `POST /conversations/create` 改为 `POST /conversations/create`（保持不变）
- [x] 2.4 将 `POST /conversations/rename` 改为 `POST /conversations/update`
- [x] 2.5 将 `POST /conversations/delete` 改为 `POST /conversations/remove`
- [x] 2.6 确认 `POST /conversations/archive` 符合规范（保持不变）
- [x] 2.7 确认 `POST /conversations/unarchive` 符合规范（保持不变）
- [x] 2.8 将 `GET /conversations/messages` 改为 `GET /conversations/messages/list?id=`（Query 参数传 conversation 的 id）
- [x] 2.9 更新 `ConversationController` 的 DTO（统一使用 `{ id: string }`）
- [x] 2.10 更新 `ConversationController` 的测试用例

## 3. WorkspaceController 路由规范化

- [x] 3.1 将 `POST /workspaces/rename` 改为 `POST /workspaces/update`
- [x] 3.2 将 `POST /workspaces/delete` 改为 `POST /workspaces/remove`
- [x] 3.3 更新 `WorkspaceController` 的 DTO（统一使用 `{ id: string }`）
- [x] 3.4 更新 `WorkspaceController` 的测试用例

## 4. UserController（Admin）路由规范化

- [x] 4.1 将 `POST /users/create` 改为 `POST /admin/users/create`
- [x] 4.2 将 `POST /users/delete` 改为 `POST /admin/users/remove`
- [x] 4.3 将 `POST /users/approve` 改为 `POST /admin/users/approve`
- [x] 4.4 将 `POST /users/reset-password` 改为 `POST /admin/users/update-password`
- [x] 4.5 更新 `UserController` 的 DTO（统一使用 `{ id: string }`）
- [x] 4.6 更新 `UserController` 的测试用例

## 5. ModelProviderController 路由规范化

- [x] 5.1 确认 `GET /model-providers/list` 符合规范
- [x] 5.2 确认 `GET /model-providers/system-info` 符合规范（保持不变）
- [x] 5.3 将 `POST /model-providers/test` 改为 `POST /model-providers/ping`
- [x] 5.4 更新 Admin ModelProviderController 的路由（`create`、`update`、`remove`、`set-enabled`、`ping`）
- [x] 5.5 更新 `ModelProviderController` 的测试用例

## 6. AuthController 路由规范化

- [x] 6.1 确认 `POST /auth/login`、`POST /auth/register` 符合规范
- [x] 6.2 将 `GET /auth/me` 改为 `GET /auth/query`
- [x] 6.3 将 `POST /auth/change-password` 和 `POST /auth/complete-password-change` 合并为 `POST /auth/update-password`
- [x] 6.4 更新 `AuthController` 的 DTO（`update-password` 统一使用 Body 入参）
- [x] 6.5 更新 `AuthController` 的测试用例

## 7. AgentController 路由规范化

- [x] 7.1 确认 `POST /agent/run` 符合规范（保持现状）
- [x] 7.2 将 `POST /agent/conversations/:conversationId/question-answer` 改为 `POST /agent/reply`（Body 传 `id` 和 `answers`）
- [x] 7.3 将 `POST /agent/conversations/:conversationId/stop` 改为 `POST /agent/stop`（Body 传 `id`）
- [x] 7.4 更新 `AgentController` 的测试用例

## 8. Admin 专用 Controller 路由规范化

- [x] 8.1 更新 `AdminRunController` 路由（`GET /admin/runs/list`）
- [x] 8.2 更新 `AdminRuntimeController` 路由（`policy`、`stats`、`bindings`、`bindings/stop` + Body `{ id }`）
- [x] 8.3 更新 `AdminWorkspaceController` 路由（`all`、`rename` → `update`）
- [x] 8.4 更新各 Admin Controller 的测试用例

## 9. 前端 API 调用同步更新

- [x] 9.1 更新前端所有 API 调用路径
- [x] 9.2 更新前端 API 类型定义
- [ ] 9.3 运行前端测试确保通过

## 10. 验证与文档

- [ ] 10.1 运行全部后端测试（`pnpm test:api`）
- [ ] 10.2 运行全部前端测试（`pnpm test:web`）
- [x] 10.3 更新 API 文档或生成新的接口文档
- [ ] 10.4 端到端测试验证
