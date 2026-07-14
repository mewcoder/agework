# Backend and API Naming Rules

适用于 `apps/server` 的后端命名规则,并覆盖与后端 API 契约直接相关的 `apps/web/src/api`、`apps/web/src/types`、`apps/web/src/store`、`apps/web/src/pages` 命名。

体例参考《Java 开发手册》命名规约:条目按【强制】/【推荐】/【参考】分级,正反例对照。不适用的 Java 条目(数组 `int[]`、`Abstract`/`Base`/`Exception`/`Test` 后缀、`Impl`、接口不加修饰符、子父类成员同名)已剔除;与 NestJS/TS + RPC-over-HTTP 约定冲突的条目(如 Service/DAO 接口 + `Impl`、各层统一 `get/save` 前缀)不照搬。

普通功能改动只约束新增代码和触碰到的局部命名;历史命名沿用现状,不单独 rename。

## 1. 命名风格

1.【强制】所有编程相关的命名均不能以下划线或美元符号开始,也不能以下划线或美元符号结束。
反例:`_name` / `__name` / `$Object` / `name_` / `name$` / `Object$`

2.【强制】所有编程相关的命名严禁使用拼音与英文混合的方式,更不允许直接使用中文的方式。即使纯拼音命名方式也要避免。
正例:`ali` / `alibaba` / `taobao` / `aliyun` 等国际通用名称,可视同英文。
反例:`DaZhePromotion`【打折】/ `getPingfenByName()`【评分】/ `int 变量名 = 3`

3.【强制】代码和注释中都要避免使用任何人类语言中的种族歧视性或侮辱性词语。
正例:`blockList` / `allowList` / `secondary`
反例:`blackList` / `whiteList` / `slave` / `SB` / `WTF`

4.【强制】类名使用 UpperCamelCase 风格,并叠加 role suffix。全大写缩写后缀(DTO / Enum)保持大写。
正例:`UserService` / `ModelProviderRepository` / `CreateUserDto` / `RunStatusEnum`
反例:`userService` / `UserDo` / `HTMLDto`

5.【强制】方法名、参数名、成员变量、局部变量都统一使用 lowerCamelCase 风格。
正例:`localValue` / `getHttpMessage()` / `inputUserId`

6.【强制】常量命名全部大写,单词间用下划线隔开,力求语义完整清楚,不要嫌名字长。
正例:`MAX_STOCK_COUNT` / `CACHE_EXPIRED_TIME` / `RUNTIME_IDLE_TIMEOUT_SECONDS`
反例:`MAX_COUNT` / `EXPIRED_TIME`

7.【强制】枚举类名带 `Enum` 后缀,文件名 `xxx.enum.ts`,成员全大写下划线。
正例:类名 `RunStatusEnum`,文件名 `run-status.enum.ts`,成员 `RUNNING` / `COMPLETED` / `UNKNOWN_REASON`。
反例:类名 `RunStatus`(缺后缀)、成员 `running`。

8.【强制】布尔类型的变量、字段、Prisma 列都不要加 `is` 前缀。
正例:`enabled` / `deleted` / `archived`
反例:`isEnabled` / `isDeleted` / `isArchived`

9.【强制】杜绝完全不规范的英文缩写,避免望文不知义。
反例:`conversation`“缩写”成 `conv`;`repository`“缩写”成 `repo`;`condition`“缩写”成 `condi`。

10.【推荐】任何自定义编程元素命名时,使用完整的单词组合来表达,达到代码自解释。
正例:`AtomicReferenceFieldUpdater`。
反例:方法内变量 `let a;`。

11.【推荐】在常量与变量命名时,表示类型的名词放在词尾,以提升辨识度。
正例:`startTime` / `workQueue` / `nameList` / `userList` / `TERMINATED_THREAD_COUNT`
反例:`startedAt` / `QueueOfWork` / `listName` / `COUNT_TERMINATED_THREAD`

12.【参考】模块、接口、类、方法使用了设计模式或承担特定角色时,命名要体现具体职责。本仓库通过 role suffix 表达(见第 20 条)。
正例:`OrderFactory` / `LoginProxy` / `ResourceObserver` / `LocalRunExecutor` / `WorkerUpstreamPort`。

13.【强制】文件名使用 `kebab-case + role suffix`,与类名 `PascalCase + role suffix`(大小写规则见第 4 条)一一对应。Admin 文件保持 `admin-<feature>.<role>.ts`。禁止 `*.use-case.ts` / `XxxUseCase`;内部文件不滥用 `*.service.ts`,具体职责后缀优先。
正例:`user.service.ts`→`UserService`、`model-provider.repository.ts`→`ModelProviderRepository`、`create-user.dto.ts`→`CreateUserDto`、`run-status.enum.ts`→`RunStatusEnum`、`admin-user.controller.ts`。

14.【强制】默认全部使用单数业务语义,只有两个例外使用复数:HTTP API path 资源段(`/users`、`/runtimes`)、前端 API 文件名(`apps/web/src/api/users.ts`)。
正例:Entity `User`、module 目录 `apps/server/src/user/`、module 根文件 `user.module.ts`、Web Store `useUserStore.ts`、Web `types/` 文件 `User.ts`、页面 `pages/admin/user.tsx`、组件 `user-form.tsx`。
反例:页面文件用 `users.tsx` 表达集合(页面是路由映射,可用`user-list.tsx`)。

动词总览(第 15-19 条共用参考):`get` / `find` / `query` / `list` / `count` / `save` / `create` / `update` / `delete` / `remove` / `archive`。

15.【强制】外部 API 采用 RPC-over-HTTP 风格,只用 `GET`(查询,参数放 Query)和 `POST`(操作,参数放 Body)。URL 资源段复数 kebab-case,动作名放最后一段;不通过 Path 传实体 ID,目标 ID 统一命名 `id`。`GET` 查询参数 ≤3 个时直接 `@Query()` + pipe,不封装 DTO;参数 >3 个时改用 `POST` + Body DTO,不新增 Query DTO。例外:admin 只读列表的复杂筛选(如 `admin/runs/events/list` 的多维过滤)保持 `GET`,参数 >3 个时允许封装 Query DTO——这是仓库 admin 面的既有统一模式,子资源正例即此类。
正例:`GET /api/v1/conversations/list`、`POST /api/v1/conversations/delete`(URL 动作名,Controller 方法名用 `delete`)、`POST /api/v1/conversations/archive`、`removePermission()`(移除权限方法名)。
反例:`/conversations/:id/update`(路径传 ID)、`POST /conversations/remove`(URL 应用 `delete`)、`deletePermission()`(移除权限应用 `remove`)。
说明:通用动作名 `create` / `update` / `delete` / `query` / `list`,不新增同义词。URL 删除动作统一用 `delete`(对应 Controller 方法名 `delete`);Service 内部删除方法可用 `delete`。移除场景(移除权限 / 成员等)用 `remove`。领域动作保留业务语义,参考动词总览。

标准形状:

```text
GET  /api/v1/<resources>/list
GET  /api/v1/<resources>/query?id=...
POST /api/v1/<resources>/create
POST /api/v1/<resources>/update
POST /api/v1/<resources>/delete
POST /api/v1/<resources>/<domain-action>
```

Admin 形状:

```text
GET  /api/v1/admin/<resources>/list
GET  /api/v1/admin/<resources>/query?id=...
POST /api/v1/admin/<resources>/update
POST /api/v1/admin/<resources>/delete
```

子资源列表也要保留动作段,不要省成裸资源段:

```text
GET /api/v1/conversations/messages/list?conversationId=...
GET /api/v1/admin/runs/events/list?runId=...
GET /api/v1/admin/runtime/resources/list
```

16.【参考】Controller 层命名规约(HTTP 适配,贴合路由语义):单条 `query`,列表 `list`,删除 `delete`。同一 Controller 暴露多个读取端点时可补对象名,如 `getRunConfig()`、`queryStatuses()`。`query` 不与 `find/get/list` 混用。

17.【参考】Repository 层命名规约(数据访问,对齐 Spring Data / Prisma / JPA 惯例):读取单个 `findById` / `findByXxx`(可空,不抛异常),列表 `listByXxx`,计数 `countByXxx`,存在性 `existsByXxx`,删除 `softDelete` / `delete` / `deleteByXxx`(按条件批量删)。

18.【参考】Service 层命名规约(业务用例,按业务语义命名):读取单个 `get` + 业务名词(非空,抛 `NotFoundException`),列表 `list`,写入 `create` / `update`,删除 `delete`。方法默认不带模块名(`UserService.create()` 不写 `createUser()`);操作对象非本模块主实体时必须带名词(`getConversation()`),裸 `get()` / `find()` 不允许。禁止 `findById` / `getById` 数据访问式命名;同一动作只选一个动词。Admin 方法加 `ForAdmin` 后缀(`listForAdmin()`、`updateForAdmin()`),不用 `listAll` / `updateAny`。

19.【参考】Internal provider 用具体职责后缀命名,`*.service.ts` 留给根 Service / 业务 facade,`Provider` 不作为类名后缀(`ModelProvider` 等业务术语例外)。反向回调契约用 `XxxPort`(接线 `setXxxPort`)。常见职责后缀:`Handler`(处理入口流程或事件入口)、`Registry`(注册表 / 多态实现表)、`Store`(模块内状态存储)、`Dispatcher`(下发命令 / 分发消息)、`Policy`(策略判断,不做 I/O 编排)、`Executor`(运行单元或任务生命周期)、`Adapter`(外部 SDK / 协议 / 基础设施适配)、`Parser`(协议 / 文本解析)、`Factory`(创建复杂对象或 provider 实例)、`Guard`(Nest guard)、`Port`(下层基础设施 / 执行层向上回流的窄反向契约)。
正例:`WorkerEndpointHandler`、`LocalRunExecutor`、`WorkerUpstreamPort`。
反例:`WorkerEndpointService`(应按职责用 `Handler`)、`WorkerUpstreamSink`(应叫 `XxxPort`)、`XxxProvider`(泛泛内部实现层)。

20.【参考】领域模型后缀规约:数据传输对象 `xxxDto`,仅用于外部输入校验,不把响应模型命名成 DTO。Body DTO 用 `<Action><Feature>Dto`(`CreateUserDto`、`UpdateWorkspaceDto`),Param/id DTO 用 `<Feature>IdDto`(`UserIdDto`、`WorkspaceIdDto`)。禁用 `xxxDO` / `xxxBO` / `xxxVO` / `xxxPOJO`;数据对象用 Prisma model,展示对象用前端 `types/*`。
