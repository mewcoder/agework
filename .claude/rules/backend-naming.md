# Backend Naming Rules (apps/api)

适用于 `apps/api` 的后端命名规则。规则来自当前代码现状与偏好选择: `1B 2A 3A 4A 5A 6C 7B 8C`。

普通功能改动只约束新增代码和触碰到的局部命名;历史文件、目录或 API 的命名收敛放进专项迁移。

## 0. 审核结论

- 文件名、类名、短方法名应继续沿用当前代码主流风格。
- 新模块目录改用单数是可接受选择,但当前已有大量复数目录;因此只对新增模块生效。
- 禁止 `*.use-case.ts` / `XxxUseCase`,历史 use-case 后续移除,避免引入 Clean Architecture / CQRS 风格。
- 内部文件不要滥用 `*.service.ts`;具体职责后缀优先于 service 后缀。

## 1. 文件与目录

- 文件名使用 `kebab-case + role suffix`: `user.service.ts`、`model-provider.repository.ts`、`admin-run-query.dto.ts`。
- 类名使用 `PascalCase + role suffix`: `UserService`、`ModelProviderRepository`、`AdminRunListQueryDto`。
- 新增 feature module 目录名使用单数业务名: `user/`、`workspace/`、`run/`。
- 历史复数目录暂不混进普通改动里重命名,如 `users/`、`workspaces/`、`runs/`、`conversations/`;后续专项命名迁移时再统一。
- 模块根文件名核心使用单数领域名: `user.module.ts`、`user.service.ts`、`user.repository.ts`;历史不一致项后续专项迁移时再统一,不要混进无关改动。
- Admin 文件保持 `admin-<feature>.<role>.ts`: `admin-user.controller.ts`、`admin-user-query.dto.ts`。

## 2. 方法命名

- Service 方法默认不带模块名: 在 `UserService` 中写 `create()`、`list()`、`update()`,不写 `createUser()`。
- Controller 方法优先贴合路由语义;同一 Controller 暴露多个读取端点时,可以补对象名,如 `getRunConfig()`、`getRuntimePolicy()`、`queryStatuses()`。
- 只有在同一个类中确实存在多个同类对象时,才在方法名中补对象名。
- `list` 表示列表查询。
- `findBy...` 表示按条件查单个或少量数据,允许返回空。
- `get...` 表示配置、确定存在的值或对外语义已经固定的读取方法。
- `query` 主要用于 HTTP endpoint 名称或专门的 query provider,不要和 `find/get/list` 随意混用。
- 同一个模块内同一动作只选一个动词。

## 3. 删除命名

- Controller 对外动作用 `remove`,延续当前路由语义: `@Post("remove") remove(...)`。
- Service 可以使用 `delete`,表达业务删除动作。
- Repository 明确区分数据动作: `softDelete`、`delete`、`deleteMany`。
- 归档不是删除,使用 `archive` / `unarchive`。

## 4. DTO 命名

- Body DTO 使用 `<Action><Feature>Dto`: `CreateUserDto`、`UpdateWorkspaceDto`。
- Query DTO 使用 `<Feature><Purpose>QueryDto` 或 `Admin<Feature><Purpose>QueryDto`: `ConversationListQueryDto`、`AdminUserListQueryDto`。
- Param / id DTO 使用 `<Feature>IdDto`: `UserIdDto`、`WorkspaceIdDto`。
- DTO 只表示外部输入校验,不要把响应模型命名成 DTO。

## 5. 内部文件后缀

- 具体职责后缀优先于 `service`: `*.policy.ts`、`*.registry.ts`、`*.executor.ts`、`*.handler.ts`。
- `*.service.ts` 留给根 Service、业务 facade,或没有更具体职责名的 Nest provider。
- 禁止新增 `*.use-case.ts` 和 `XxxUseCase`;历史 use-case 后续移除,改成具体职责名。
- 避免抽象空词: `helper`、`utils`、`manager`、`processor`、`core`。除非它是外部协议、SDK 或现有产品术语。

## 6. 迁移原则

- 不为命名规则单独做大规模 rename。
- 修改历史模块时,只在当前变更范围内顺手收敛命名。
- 如果历史命名和本规则冲突,以“不扩大 diff、不破坏 import、不制造无关迁移”为优先。
