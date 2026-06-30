# Feature Module Architecture (apps/api)

适用于 `apps/api`(NestJS 11 + Prisma)。竖切模块单体,不引入 DDD / Clean Architecture 重型分层。命名细则见 [`backend-naming.md`](backend-naming.md)。

## 0. 核心概念

| 概念 | 定义 |
|---|---|
| Module | isolation boundary,按业务领域划分 |
| Root Service | module 唯一对外入口,公开契约 + 用例编排 |
| Internal provider | 同 module 内的私有子能力 owner,不 export |
| Repository | DB boundary,Prisma 访问唯一入口 |
| DTO | 外部输入校验边界,只做 input validation |
| `*.types.ts` | 后端跨模块契约类型 |
| `@agework/shared` | 前后端共享类型 / 协议类型 |
| Event | 已发生事实的通知(过去式) |
| Port | 下层 infra/execution 向上层回流的窄反向契约(最后手段) |

调用路径(不是三层架构,不要造 `application/domain/data` 目录):

```
Controller → Root Service → Internal Provider → Repository → PrismaService
Root Service → 下层 module 导出的 Service / domain event
```

## 1. 优先级

| 优先级 | 必须守住 |
|---|---|
| P0 | 禁止循环依赖、禁止 `forwardRef`;跨模块只调对方导出的 Service,不 reach 内部文件;业务 Service 不直接注入 `PrismaService`;禁止独立 mapper layer |
| P1 | 外部输入必须 DTO / pipe / guard 校验;Event 只通知事实,不命令别的模块改状态 |
| P2 | 文件命名、组织规则 |

不确定时不要提升 module、不要拆新文件 / 新抽象,先留在现有 owner 内。

## 2. 文件划分结构

标准模块:

```
feature/
├── feature.module.ts        # 必有,零逻辑组合根
├── feature.service.ts       # 必有,唯一对外入口
├── feature.controller.ts    # 对外暴露 HTTP 时才有
├── feature.repository.ts    # 持有数据 / 表时才有
├── feature.types.ts         # 按需,跨模块契约类型
├── feature.events.ts        # 按需,domain event 类型 / 常量
├── *.spec.ts                # 贴近门面文件的测试
├── dto/                     # 按需,外部输入 DTO
└── <sub-capability>/        # 按需,稳定子能力目录
```

**Root 白名单(delivery gate,强制)**:root 只允许放 `*.module.ts` / `*.service.ts` / `*.controller.ts` / `*.repository.ts` / `*.types.ts` / `*.events.ts` / `*.spec.ts` / `dto/` / 子能力目录。其余内部实现文件必须收进按子能力命名的子目录;Auth 的 `decorators/`、`guards/` 同理,不平铺在 root。feature 直接放 `apps/api/src/` 顶层,不套 `src/modules/`。不为凑齐造空文件 / 空文件夹。

大模块(如 `runtime/`)在 root 下按子能力建目录:`instances/`、`providers/`、`sandbox/` 等。

### Internal provider

承接同一 module 内的稳定子能力,不是新公开层。放在按子能力命名的子目录,注册在本 module `providers`,默认由 Root Service 注入。可依赖本模块 Repository / internal provider / 下层 Service / EventEmitter,但必须 acyclic。**不 export、不被其他 module import、不被 controller 直接调用、不只是给 Root Service 包一层转发**。用具体职责后缀命名(`executor`、`registry`、`store`、`dispatcher`),不用泛泛 `XxxProvider`。

Root Service 出现独立状态 / 协议解析 / queue / registry / 复杂状态机 / 恢复流程等强信号时,拆 internal provider;方法数 / 行数不是硬阈值。Root Service 可以宽但不能深。

### Module 公开面

以 `runtime` 为例:

```ts
@Module({
  providers: [RuntimeService, RuntimeRepository, RunStatusStore, LocalRunExecutor, AgentRegistry],
  controllers: [RuntimeController],
  exports: [RuntimeService],
})
```

`providers` 是**注册**(登记进容器、本 module 内可注入);`exports` 是**导出**(对外开放、别的 module 才能拿)。`RuntimeService` 是根 Service 且被 `exports`;`RuntimeRepository` 和三个 internal provider 都只在 `providers` 注册、不 export,所以只在 module 内可见,别的 module 注入不到——这就是 internal 的来源。

默认只 export 根 `Service`;禁止 export repository / internal provider / controller / DTO。跨模块需要类型用对方 `*.types.ts` 或 `@agework/shared`,禁止从 service 实现文件导出契约类型。Root Service public 方法必须加 JSDoc,当 module public API 维护。

### Admin 边界

管理 HTTP 入口归属对应 feature module 的 `admin/` 子目录,URL 用 `/admin/...` 前缀,`@Roles("admin")` 守卫。Admin controller 只做 HTTP I/O,只调本 module 根 Service,不直接注入 Prisma / repository / internal provider。跨领域管理用例由 owner 根 Service 编排下层 Service。只有真正跨领域的管理用例(如 admin overview、系统健康、审计日志)才允许新增独立 admin / operations feature module,且只能编排其他 module 导出的根 Service,不得接管领域数据 ownership。判断口诀:**管理后台体验可以集中,业务所有权不要集中。**

## 3. 边界规则

### 跨模块

允许:import 对方 module;注入对方导出的根 Service;import 对方 `*.types.ts` 或 `@agework/shared`。

禁止:import 对方 repository / internal 子目录 / DTO / service 实现文件里的类型;从路径 reach 未 export 的 provider。

## 4. 依赖管理与反向依赖处理 (P0)

依赖 strictly downward 或 cross-service only。核心纪律:**反向信息流可以存在,反向 `Service` 依赖不可以存在。** 下层不反向注入上层 Service,禁止循环依赖、禁止 `forwardRef`(出现环说明边界划错,重划)。

当下层 / 被调方需要上层的东西时,按下面决策链从上往下试,命中即停。Port 是最后手段,不是平级三选一:

1. **翻转方向** — 上层其实是更基础领域(数据 / 容器)→ 把它沉到下面,正向直调。若两边共享一个更低概念,则下沉成更低 module,两边都向下调它。
2. **参数喂入** — 调用前能算出来 → 由当前用例 owner 算好,当参数传入下层;下层因此不依赖上层。
3. **上提用例 owner** — 是跨两个领域的同步用例 → 上提到拥有该用例的更上层 Service,它正向调两边。
4. **domain event** — 只是通知已发生事实、不要答案 → 下层发 event,上层 handler 响应(过去式语义,见 §5 Event)。
5. **窄 Port(最后手段)** — 下层是 infra/execution、本就不认识上层领域、且必须运行时回流执行事件 / 结果 / 错误 → 用 Port。

> 多态实现注册用 Registry,运行时按 key 取实现;它不是反向依赖的解法,不进上面决策链。

### Port 纪律

Port 只配决策链第 5 条(infra/execution 运行时回流);平级业务领域之间的反向需求回决策链 1-3,不准做 Port。

- 跨模块 Port 接口由**下层(调用方)定义**在公开 `*.types.ts`,**上层实现**并启动期 `setXxxPort(...)` 接线。编译依赖仍上层→下层(向下),运行时调用下层→上层,无环。
- Port 方法 ≤3 且语义具体,可带返回值用于执行层同步回流查询。
- Port 不能引用实现方的 `Service` / repository / internal provider 类型,也不能把对方根 Service 的公开方法整套搬过来。
- Port 方法持续变多 = 信号:回决策链 1-3(多半该翻转方向或上提 owner),不要继续加方法。
- 同模块 internal provider 之间的 Port 放在所属子能力目录内,不提升到 module root `*.types.ts`。
- `Sink` / `Receiver` / `Recorder` 不再作为新增反向回调契约命名,统一 `XxxPort`。
- 允许 `XxxPort` 契约类型,但不允许引入 Clean Architecture / Hexagonal 的 `ports/`、`adapters/` 分层目录。

### 模块提升判定

子能力放父模块子文件夹还是提升平级 module?默认两可不提升。先判 blocker(命中即不提升):拆出去会成环 / 需 `forwardRef`;共享父模块内存状态或生命周期;只是父模块某阶段 / 动作 / 侧面;拆出去父模块还要反向调用它。

无 blocker 后计分:独立概念名(+1)、独立生命周期(+1)、自己的表(+2)、被 ≥2 个根 module 依赖(+2)、对外暴露 HTTP/API(+2)、独立外部系统/SDK 集成(+2)。≥3 提升;=2 可提升(优先看明确调用方);≤1 留子文件夹。Module 不要求有表。

## 5. 各角色规则

**Controller**:只做 HTTP I/O(解析输入、触发校验、调 Service、返回响应)。禁止业务逻辑、直接调 Repository、直接调 internal provider。

**Root Service**:编排用例;调本模块 Repository / internal provider / 下层 Service;发 domain event;做响应形状局部转换;可对 internal provider 薄转发。禁止直接注入 `PrismaService`、跨模块访问 internal/repository/DTO、承载全部业务规则。复杂子能力下沉 internal provider,Service 只留编排和契约。

**Repository**:业务数据访问唯一入口,per 领域不 per 表。Prisma 查询 / 事务 / 字段安全留在 Repository;多步写用 `prisma.$transaction(fn)`;默认 `select`/`omit` 挡住 password hash / token / 审计列;消除 N+1。禁止叠 `interface IXxxRepository` + token + 实现类;禁止独立 mapper layer。

**DTO / Transform**:外部输入(body/query/param/header)必须 DTO + ValidationPipe / guard,DTO 只做校验不放业务逻辑。HTTP 响应形状放 Service 私有方法 / 同文件 pure function。敏感字段在 Repository select 层解决。禁止绕过 DTO 让外部输入直接进 Service;禁止把同一转换拆散多处。

**HTTP 响应**:列表用 `{ list, total? }` 或 `{ list, total, pageNo, pageSize }`,数组字段必须叫 `list`,分页参数 `pageNo`/`pageSize`。失败用 NestJS `HttpException` 族,不返回 `{ success: false }` 伪成功。

**Event**:`@nestjs/event-emitter` / `EventEmitter2`。过去式命名,只通知不用于同步控制流,不命令别的模块改状态,不当跨模块 method call 替代品。Handler 遵守同样模块边界。Handler 默认 best-effort:失败应记录日志,不能破坏事件来源操作的业务语义。强一致等结果用同步编排,不用 event。

**输入 / 错误 / 鉴权 / 配置 / 日志**:全局 `ValidationPipe` 一处配置;路径参数用 `ParseUUIDPipe` 等。预期错误抛 `HttpException` 族,Service 不 try/catch 吞错,由全局 `AllExceptionsFilter` 兜。粗粒度访问控制放 guard,资源级授权放 Service。外部配置经 `ConfigService` 统一读校验,feature 不直接读 `process.env`。结构化日志 + 透传 `x-request-id`,不散写 `console`。

**测试**:`*.spec.ts` 贴着实现放,Vitest;单测用手搓 mock + 构造注入,测 guard/pipe/filter 才用 `Test.createTestingModule`。改 `shared`/`adapters`/`runtime`/消息聚合优先补精准单测。

**通用代码落点**:

| 位置 | 用途 |
|---|---|
| `@agework/shared` | 前后端都真 import 的共享类型 / 协议类型 / 纯函数(如 `generateId`)。后端独用的不进 |
| `apps/api/src/common/` | 只后端用、完全不认识领域概念的通用能力(filters、guards 的全局壳、纯工具) |
| module 内部 | 认识某个领域概念、只该领域用的能力 |

判据是实际使用,不是"看起来通用"。工具函数默认不抽,先内联 owner Service 私有方法 / 同文件 pure function;满足 ≥2 处真复用 / 厚到自成单元 / 值得单测才抽独立文件。feature module 内不准新建 `common/`、`utils/` 兜底。

## 6. 禁止范式

- DDD / Hexagonal / Clean Architecture:充血实体 / aggregate root、`domain/application/infrastructure` 三层目录、use-case / command-handler、ports & adapters 命名包、CQRS / event sourcing / outbox、独立 response-DTO mapper layer。
- 为"分层好看"造的无意义结构:God Service、Repository-per-table、空层级、`src/modules/` 包壳、`entities/` 文件夹、root 平铺一堆内部文件、为 1 文件单建文件夹、为转发而转发的 internal provider。
- 抽象空词 / 架构感词:`engine`、`core`、`pipeline`、`helper`、`utils`、feature 内新建 `common/`。通用工具默认不抽,先内联;满足 ≥2 处真复用 / 厚到自成单元 / 值得单测才抽独立文件。

## 7. 自检

- [ ] 触碰过的 feature module root 是否完全命中 root 白名单?内部实现是否收进子能力目录?
- [ ] Auth decorator / guard 是否在 `decorators/` / `guards/`,不平铺 root?
- [ ] Root Service 是否只是公开入口 / 用例编排?复杂子能力是否下沉 internal provider 且未 export?
- [ ] Internal provider 是否只在本地注册、不被 controller / 其他 module 直接调用、不是转发壳、内部无环?
- [ ] 跨模块是否只走对方公开 Service?有没有 reach 进 repository / internal / DTO?
- [ ] Service 有没有直接注入 `PrismaService`?
- [ ] DTO / transform 是否按归属放置?同一转换有没有散在多处?响应会不会漏敏感字段?
- [ ] Event 是否被用于控制流或命令别的模块改状态?
- [ ] 反向需求是否先跑过 §4 决策链,只有 infra/execution 运行时回流才用 Port?
- [ ] 子能力提升平级 module 前是否跑过 blocker + 计分?
- [ ] 有没有加了 anti-pattern 重型套路?
