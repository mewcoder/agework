# `.rules` - Feature Module Architecture (apps/api)

适用于 `apps/api`(NestJS 11 + Prisma)。这是后端的理想目标态,既给人看,也给编辑本仓库的 AI agent 当护栏。

本文统一用 **Feature Module Architecture(竖切模块单体)** 描述本仓库目标架构。行业出处包括 Modular Monolith / Package by Feature / Vertical Slice Architecture / NestJS feature module / Acyclic Dependencies Principle;这些只作为出处,不引入 DDD / Clean Architecture 的目录或建模体系。

## 0. 总原则

- 按业务领域划分 feature module。
- Module = isolation boundary。
- Service = public API boundary,也是该 module 唯一对外入口。
- Repository = DB boundary,也是业务数据访问 Prisma 的唯一入口。
- Internal provider = private capability owner,只服务本 module 内部稳定子能力。
- Event = fact-only notification,只通知已发生事实。
- Dependency = strictly downward or cross-service only。
- 禁止 DDD / Clean Architecture 重型分层体系。
- 后端命名细则见 [`backend-naming.md`](backend-naming.md),本文只保留架构边界与组织规则。

规则冲突或时间不够时,按优先级从上到下执行。高优先级没满足,低优先级不要补救性绕开。

| 优先级 | 必须守住的事 |
|---|---|
| P0 | 禁止循环依赖;禁止用 `forwardRef` 掩盖边界问题 |
| P0 | 禁止跨模块 reach 进内部文件;跨模块只调对方导出的 `Service` |
| P0 | 触碰 feature module 时必须满足 root layout 白名单 |
| P0 | 业务 Service 不直接注入 `PrismaService`;DB 访问走 Repository |
| P0 | 禁止独立 mapper layer |
| P1 | 外部输入必须经过 DTO / pipe / guard 等边界校验 |
| P1 | Event 只通知已发生事实,不用 event 命令别的模块改状态 |
| P2 | 文件命名、少而厚、工具函数位置等组织规则 |

Override 原则:不确定时不要提升 module,不要拆新文件 / 新 provider / 新抽象。先留在现有 owner 内,直到边界、复用或复杂度证据足够明确。

## 1. 组织约束 (STRUCTURE)

### 1.1 Feature Module 根结构

标准模块:

```text
feature/
├── feature.module.ts            # 必有,零逻辑组合根
├── feature.service.ts           # 必有,唯一对外入口
├── feature.controller.ts        # optional, only if exposes HTTP
├── feature.repository.ts        # optional, only if owns persistence
├── feature.types.ts             # optional, cross-boundary backend types
├── feature.events.ts            # optional, domain event types/constants
├── *.spec.ts                    # colocated tests
└── dto/                         # optional, external input DTOs
```

大模块:

```text
runtime/
├── runtime.module.ts
├── runtime.service.ts           # public facade / use-case orchestration
├── instances/                   # stable sub-capability
├── providers/                   # stable sub-capability
└── sandbox/                     # stable sub-capability
```

根结构规则:

- `module` + `service` 每个 feature module 必有。
- `controller` 只有对外暴露 HTTP 时才有。
- `repository` 只有本领域持有数据 / 表时才有。
- `types` / `events` / `dto/` 按需创建,不为凑齐而造空文件 / 空文件夹。
- module root 只放门面文件、`dto/`、测试和子文件夹;不平铺内部业务实现文件。
- feature 直接放 `apps/api/src/` 顶层,不要套 `src/modules/`。

Root 白名单(强制):

| root 项 | 允许条件 |
|---|---|
| `*.module.ts` | module 组合根 |
| `*.service.ts` | 根 Service,唯一对外入口 |
| `*.controller.ts` | feature 自己的 HTTP controller |
| `*.repository.ts` | feature 自己的 persistence boundary |
| `*.types.ts` | 后端跨模块契约类型 |
| `*.events.ts` | domain event 类型 / 常量 |
| `*.spec.ts` | 贴近 root 门面文件的测试 |
| `dto/` | 外部输入 DTO |
| 子能力目录 | internal provider / admin controller / guard / decorator / credential / session 等稳定子能力 |

Delivery gate(强制执行):

- 新增或修改 feature module 时,root layout compliance 是交付门槛。
- 新增 / 修改的 root 文件必须命中上面的 root 白名单;否则必须放进按子能力命名的子目录。
- 触碰已有 feature module 时,如果 root 已有内部实现文件,必须在同次改动中收进子目录;不要继续沿用“历史上就在 root”作为理由。
- Auth 这类跨模块 TypeScript public API 也要进明确子目录:`decorators/` 放 `CurrentUser` / `Public` / `Roles` 等 decorator,`guards/` 放 `JwtAuthGuard` / `RolesGuard` 等 guard。它们可以被跨模块 import,但不允许平铺在 module root。
- 如果确实无法在同次改动完成目录收口,必须在变更说明里明确列出未收口文件和原因;不能静默留下。

### 1.2 Internal 结构

Internal provider 用于拆分同一个 module 内部的复杂能力,不是新的公开层。

```text
feature/
├── feature.module.ts
├── feature.service.ts
├── feature.repository.ts
├── execution/
│   └── execution.service.ts
├── status/
│   └── run-status.service.ts
└── registry/
    └── provider.registry.ts
```

Internal provider 正式定义:

| 项 | 规则 |
|---|---|
| 是什么 | 同一个 feature module 内部的 Nest provider,承接一个稳定子能力,注册在本 module 的 `providers` |
| 放哪里 | 放在按子能力命名的子文件夹,或少量贴近 owner 的文件;不平铺一堆内部实现到模块根 |
| 谁能注入 | 默认由根 Service 注入;同一子能力内部可单向注入,但必须保持 acyclic,不能形成网状互调 |
| 能依赖谁 | 可依赖本模块 Repository / 本模块 internal provider / 下层模块导出的 Service / EventEmitter |
| 不能做什么 | 不能 export;不能被其他根 module import;不能被 controller 直接调用;不能只是给根 Service 包一层转发 |
| 命名 | 优先用具体职责后缀如 `executor`、`registry`、`validator`;已有 `RunStatusService` 这类内部 service 可保留,但 `Service` 后缀不等于公开入口 |

内部调用图:

```text
Controller
  ↓
Root Feature Service
  ↓
Same-module internal provider
  ↓
Repository / lower module exported Service / domain event
```

如果根 Service 出现大量无关 private method、构造注入过多、或一个文件同时承担多个稳定子能力,触发拆 internal provider 的 review。不要用方法数 / 行数当唯一硬阈值。

### 1.3 Module 公开面

```ts
@Module({
  imports: [LowerModule],
  providers: [FeatureService, FeatureRepository, InternalProvider],
  controllers: [FeatureController],
  exports: [FeatureService],
})
export class FeatureModule {}
```

- `module.exports` 定义公开面;没 export 的就是 internal implementation。
- 默认只 export 根 `Service`。
- 跨模块调用统一走目标模块根 `Service`。根 `Service` 可以作为 facade 薄转发到本模块 internal provider,以保持公开面稳定;但不能承载 internal provider 的核心实现细节。
- 禁止 export repository / internal provider / controller / DTO。
- 额外 export provider 原则上禁止;只有框架级 token / provider 无法通过根 `Service` 表达时才允许例外,并且必须保持职责极窄。
- 跨模块需要类型时,使用对方公开的 `*.types.ts` 或 `@agework/shared`;禁止从 service 实现文件导出契约类型。

定义:

- `Root Service`: module 唯一对外入口,文件通常是 `<feature>.service.ts`。它负责公开契约、跨模块编排、对 internal provider 的薄转发。
- `Internal Provider`: Root Service 下的一层 Nest provider,只在本 module 内注册和注入,不 export。它用具体职责命名,不使用泛泛的 `XxxProvider` 后缀。

### 1.4 Admin 边界

Admin 是访问视角,不是业务 ownership。后端不要把各领域管理接口集中成一个横向 `AdminModule`;管理端 HTTP 入口必须仍归属对应 feature module。

推荐结构:

```text
feature/
├── feature.module.ts
├── feature.service.ts
├── feature.controller.ts
└── admin/
    └── admin-feature.controller.ts
```

规则:

- Admin controller 放在业务 owner 的 `admin/` 子目录,并注册在该 feature module 的 `controllers`。
- Admin URL 统一使用 `/admin/...` 前缀;权限边界统一使用 `@Roles("admin")` 或更高等级 guard / policy。
- Admin controller 只处理 HTTP I/O,只能调用本 module 根 `Service`;禁止直接注入 Prisma / repository / internal provider / query provider。查询入口如果需要独立 provider,也必须由 Root Service 暴露。
- Admin 查询需要跨领域信息时,由当前用例 owner 的根 `Service` 编排下层 module 导出的 `Service`;禁止从 admin controller reach 进其他 module 的 repository / internal 子目录。
- 前端管理后台入口可以集中在 `apps/web/src/pages/admin`;共享 API 类型继续按业务领域放在 `@agework/shared` 的对应 `api/*` 文件中。
- 只有真正跨领域的管理用例(如 admin overview、系统健康、审计日志)才允许新增独立 admin / operations feature module;该 module 只能编排其他 module 导出的根 `Service`,不得接管其他领域的数据 ownership。

判断口诀:管理后台体验可以集中,业务所有权不要集中。

### 1.5 跨模块结构约束

允许:

- import 对方 module。
- 注入对方 module 导出的根 `Service`。
- import 对方公开 `*.types.ts` 中的后端契约类型。
- import `@agework/shared` 的跨前后端共享类型 / 协议类型。

禁止:

- import 对方 repository。
- import 对方 internal 子文件夹。
- import 对方 DTO。
- import 对方 service 实现文件里的类型。
- 从文件路径 reach 进未 export 的 provider。

### 1.6 Shared / Common 约定

| 位置 | 用途 |
|---|---|
| `@agework/shared` | 前后端共享类型、协议类型、纯通用函数,如 `generateId` |
| `apps/api/src/common/` | 只后端使用、完全不认识领域概念的通用能力 |
| module 内部 | 认识某个领域概念、只该领域使用的能力 |

放 `@agework/shared` 的硬条件:**前端和后端都真的 import**。判据是实际使用,不是"看起来通用"或"将来可能共用"。后端独用的纯函数即使通用,也放 `apps/api/src/common/`,不进 shared。

工具函数默认不抽,先放 owner Service 的 `private` 方法 / 同文件局部函数。满足一条才抽成独立文件:被 >=2 处真复用、厚到自成可读单元、或是纯函数且值得精准单测。单一调用方的小工具优先内联,不为它单建文件 / 子路径导出。

## 2. 行为规则 (RULES)

### 2.1 Core Flow (P0)

```text
HTTP Request
  ↓
Controller        # HTTP I/O only
  ↓
Feature Service   # public API boundary / use-case orchestration
  ↓
Repository        # DB boundary / safe select-omit
  ↓
PrismaService

Feature Service
  ├─ calls lower module exported Service only
  ├─ delegates to same-module internal providers only
  └─ emits domain events only for past-tense facts
```

这张图是**调用路径**,不是三层 / 四层架构。不要据此创建 `application/domain/data` 目录,也不要把角色理解成横向 layer。

| 角色 | 是什么 | 不是什么 |
|---|---|---|
| Controller | HTTP adapter,只处理 HTTP I/O | 业务入口 / 用例层 |
| Root Feature Service | use-case orchestration role,维护 module 对外契约和流程编排 | application layer,也不是业务逻辑垃圾桶 |
| Internal provider | domain execution role / private capability owner,承接稳定子能力的核心逻辑 | helper / utils / 可跨模块复用层 |
| Repository | persistence boundary,封装 Prisma 查询、事务和字段安全 | data layer 总线 / mapper layer |

判断口诀:

- 如果逻辑是在组织一次用户可见用例,留在 Root Feature Service。
- 如果逻辑属于一个稳定子能力,有自己的状态流转 / 执行步骤 / 注册查找 / 恢复策略,放 Internal provider。
- 如果只是单次使用的小转换,先留在 Service 私有方法或同文件 pure function。
- 如果逻辑只是 Prisma 参数、查询、事务、字段安全,放 Repository。

### 2.2 依赖规则 (P0)

- 禁止循环依赖。
- 禁止 `forwardRef`;出现循环依赖说明边界划错,重划。
- 依赖按业务领域从上层往下走,下层不得反向注入或直接调上层 Service。
- 具体谁在上谁在下,先按用例拥有者 / 状态拥有者 / 基础设施边界判断;调用方向必须服从这个判断。
- 不维护固定全局模块链,避免和实现耦合、随重构漂移。

拆环动作:

| 场景 | 处理 |
|---|---|
| 多数“同级”其实有天然低者 | 定序,只允许上层调下层 |
| 一个用例需要协调两个领域 | 上提到拥有该用例的更上层 Service,它向下调两边 |
| 两边共享低层概念 | 下沉成更低 module,两边都向下调它 |
| 只是通知已发生事实 | 使用 domain event |

反向通知只允许三种机制:`EventEmitter2` domain event(跨域事实通知)、回调端口 `set*Sink`(结果回灌)、Registry(多态注册)。

### 2.3 Service 规则 (P0)

Service 是 module 唯一对外入口。

允许:

- 编排用例流程。
- 调用本 module repository。
- 调用本 module internal provider。
- 调用下层 module 导出的 Service。
- 发 domain event。
- 做响应形状局部转换。
- 作为 module public facade,对 internal provider 做薄转发。Service 可以宽,但不能深;复杂状态机、协议解析、queue / registry / store 细节仍应留在 internal provider。
- Root Service 的 public 方法必须加 JSDoc 注释,把它当作 module public API 维护。注释说明业务语义、主要调用方或重要副作用;不要只复述方法名。

禁止:

- 直接注入 `PrismaService`。
- 跨模块访问 internal / repository / DTO。
- 承载所有业务规则、工具函数和稳定子能力。
- 拆出“给 controller 的公开面”和“给领域的公开面”两套门面。默认只有一个公开面;真分叉到一个类塞不下时再评审。

Root Service 拆分判断:

- Root Service 可以宽,但必须薄。方法数量多不是拆分理由;单个方法或一组方法承载了独立实现深度,才需要拆到 internal provider。
- 出现以下任一强信号,应拆成 internal provider:
  - 持有独立状态或生命周期,如 map/cache/session/queue/registry/timer/retry。
  - 处理协议/传输细节,如 RPC/HTTP/webhook body 解析、normalize、序列化、兼容旧格式。
  - 直接操作队列、registry、store、dispatcher、runtime engine、外部 SDK 或基础设施适配。
  - 包含复杂状态机、恢复流程、调度流程、并发控制、重试/退避/超时处理。
  - 这块能力可以独立命名、独立测试,且名字不是当前 root service 的同义反复。
- 出现以下两个以上弱信号,建议拆成 internal provider:
  - 私有方法开始围绕同一子概念聚集。
  - 单个 public 方法需要多段无关步骤才能读懂。
  - 单测需要大量 mock root service 的内部协作者。
  - 后续很可能被本 module 内多个入口复用。
- 可以留在 Root Service 的逻辑:
  - 简单权限/存在性检查。
  - 调用 internal provider 或下层 Service 的编排顺序。
  - 少量响应形状转换。
  - 对 internal provider 的一行或几行薄转发。

Root Service 是 module facade / use-case orchestrator,但不是承载全部 application 细节的容器。Service 方法里一旦出现明显的 execution/status/recovery/registry/sandbox 等子能力细节,应下沉到 internal provider,Service 只保留用例编排和对外契约。

### 2.4 Repository 规则 (P0)

- 业务数据访问一律走 Repository,Service 不注入 `PrismaService`。
- Repository 可以薄,但 Prisma 查询和 tx client 留在 Repository。
- Repository per 领域,不 per 表。
- 禁止叠 `interface IXxxRepository` + injection token + 实现类。
- 多步写用 `prisma.$transaction(fn)`,封装在 Repository 内。
- 响应不泄敏字段:默认在 Repository 用 `select` / `omit` 把 password hash / token / 审计列挡在源头。
- 留意并消除 N+1。

### 2.5 Controller 规则 (P1)

- Controller 只做 HTTP I/O:解析输入、触发边界校验、调 Service、返回响应。
- 禁止业务逻辑。
- 禁止直接调用 Repository。
- 禁止直接调用 internal provider。

### 2.6 DTO / Transform 规则 (P0/P1)

| 事项 | 归属 |
|---|---|
| 外部输入校验(body/query/param/header) | DTO + pipe / guard;Controller 边界触发 |
| HTTP 响应形状 | 根 Service 私有方法或同文件 pure function |
| 敏感字段过滤 | Repository `select` / `omit`,从数据源头挡 |
| Prisma 参数组装 / JSON cast / where/orderBy | Repository |
| 业务状态计算 / 权限判断 / 用例编排 | 根 Service 或同模块 internal provider |
| 跨前后端共享类型 / 协议类型 | `@agework/shared` |
| 后端内部跨边界类型 | `*.types.ts` |

硬规则:

- 所有外部输入必须 DTO + ValidationPipe / pipe / guard。
- DTO 只用于 input validation,不放业务逻辑。
- 禁止绕过 DTO 让外部输入直接进 Service。
- 禁止独立 `mapper.ts` / mapper layer。
- 禁止把同一个转换拆成多处。
- 字段涉及安全泄漏时,优先在 Repository select 层解决。
- 字段只是响应命名 / 组合时,放 Service 局部转换。

### 2.7 Event 规则 (P1)

- Event 只表示已发生事实,命名用过去式语义。
- Event 只用于通知,不用于同步控制流。
- Handler 可以根据事实决定本领域状态变化。
- 禁止用 event 命令另一个模块改状态。
- 禁止把 event 当跨模块 method call 的替代品。
- Event handler 必须遵守同样的模块边界;禁止调用跨模块 internal provider。

### 2.8 Module 提升规则 (P2)

子能力放进父模块子文件夹,还是提升为平级根 module?默认两可时不提升。If uncertainty exists, do not elevate module.

先跑可计算判定:

1. Blocker 先判:任一命中就必须不提升。
2. 无 blocker 后再计分。

Blocker:

- 拆出去会成环,或需要 `forwardRef` 才能跑。
- 共享父模块内存状态或生命周期。
- 只是父模块某个阶段 / 动作 / 侧面。
- 拆出去后父模块还要反向调用它。

| 信号 | 分数 |
|---|---:|
| 有独立概念名,且不是父模块动作名 | +1 |
| 有独立生命周期 / 状态边界 | +1 |
| 有自己的表 / 独立持久化 | +2 |
| 被 >=2 个其他根 module 直接依赖 | +2 |
| 对外暴露自己的 HTTP/API 查询入口 | +2 |
| 是独立外部系统 / SDK / transport 集成 | +2 |

| 结果 | 处理 |
|---|---|
| 有 blocker | 必须不提升 |
| 无 blocker 且分数 >=3 | 提升为平级根 module |
| 无 blocker 且分数 =2 | 可提升,但优先看是否已有明确调用方 |
| 无 blocker 且分数 <=1 | 留在父模块子文件夹 |

说明:

- Module 不要求有表;`auth`、`worker-host` 这类无表但清晰的认证 / 集成领域可以是 module。
- `run-events` 和 `runs` 平级,因为事件日志是独立概念、有自己的表、可被独立查询。
- 一个领域“生命周期”的执行 / 状态 / 流式 / 恢复若共享状态且彼此咬合,留在父模块 internal,乱了就合文件夹,不是拆平级 module。

### 2.9 命名规则 (P2)

- 优先用产品、API、数据模型里已经存在的常见名词。新名词必须能回答:用户或代码里是否已经有这个概念?
- 动词用常见动词,同一模块里同一动作只选一个词,不要 `get/find/fetch` 混用。
- 角色后缀按真实职责用,如 `service`、`repository`、`controller`、`registry`、`executor`、`validator`。
- 少用或不用抽象空词 / 架构感词,如 `engine`、`core`、`pipeline`、`processor`、`manager`、`helper`、`utils`、`common`。除非它已经是外部协议 / SDK / 产品术语,否则换成具体领域名 + 具体职责。
- `apps/api/src/common/` 是后端通用能力的唯一保留位置;不要在 feature module 内新建 `common/`、`utils/` 兜底。
- 文件名和类名要能互相反推;如果名字只能靠比喻理解,就还没起好。

### 2.10 输入、错误、鉴权、配置、日志、测试

输入:

- 全局 `ValidationPipe` 一处配置,不要在路由重复散落。
- 每个请求 DTO 用 `class-validator` 装饰,放各模块 `dto/`。
- 一切外部输入(body / query / param / header)都校验;路径参数用 `ParseUUIDPipe` 等管道。

错误:

- 预期错误抛 NestJS `HttpException` 族。
- 统一外壳由全局 `common/filters`(`AllExceptionsFilter`)兜。
- 不在 Service 里 try/catch 吞错;非预期失败冒泡到全局 filter 集中记录。

鉴权 / 配置 / 日志:

- 粗粒度访问控制(登录态、角色)放 guard。
- 资源级授权(这个用户能不能动这条数据)放 Service。
- 外部配置 / env 经 `ConfigService` 统一读取与校验,非法值启动即抛。
- Feature 代码不直接读 `process.env`。
- 统一结构化日志 + 透传 `x-request-id`;不在业务里散写 `console`。

测试:

- `*.spec.ts` 贴着实现放;用 Vitest。
- 单测依赖手搓 mock + 构造注入;要测 guard / pipe / filter 时才用 `Test.createTestingModule`。
- 改 `shared` / `adapters` / `runtime` / 消息聚合等共享逻辑,优先补精准单测。

## 3. 禁止范式 (ANTI-PATTERNS)

DDD / Hexagonal / Clean Architecture 重型套路:

- 充血实体 / 值对象 / aggregate root 建模。
- `domain/application/infrastructure` 三层目录。
- use-case / command-handler 套路。
- ports & adapters 命名包。
- CQRS / event sourcing / outbox / anti-corruption layer。
- 独立 response-DTO mapper layer。

为“分层好看”造的无意义结构:

- God Service。
- Repository-per-table。
- 为分层而分层的空层级。
- `src/modules/` 包壳。
- `entities/` 文件夹(TypeORM-ism)。
- 根目录平铺一堆内部文件。
- 为 1 个文件单建文件夹。
- 为转发而转发的 internal provider。

## 4. 自检规则

每次后端改动前后必须确认:

- [ ] 触碰过的 feature module root 是否完全命中 root 白名单?
- [ ] 新增 / 修改的 root 文件是否都属于 module/service/controller/repository/types/events/spec 或 `dto/`?否则是否已收进子能力目录?
- [ ] Auth 这类 decorator / guard 是否放在 `decorators/` / `guards/`,而不是平铺在 root?
- [ ] 有没有为“凑齐”造空文件 / 空文件夹?
- [ ] 文件夹是否少而厚、按子能力命名?
- [ ] 根 Service 是否只是公开入口 / 用例编排?
- [ ] 复杂稳定子能力是否拆成同模块 internal provider,且没有 export 给别的模块?
- [ ] Internal provider 是否只在本模块 providers 注册、不被 controller / 其他根 module 直接调用、不只是转发壳、且内部依赖无环?
- [ ] 子能力提升为平级 module 前是否跑过 blocker + 计分?不确定时是否保持 internal?
- [ ] 跨模块调用是否只走对方公开 Service?
- [ ] 有没有 reach 进别人 repository / internal / DTO?
- [ ] 跨领域调用前,是否确认对方不会直接或传递反过来依赖我?
- [ ] Service 有没有直接注入 `PrismaService`?
- [ ] DTO / transform 是否按归属表放置?
- [ ] 有没有同一个转换散在 Repository、Service、Controller 多处?
- [ ] 响应里会不会漏出敏感字段?
- [ ] 有没有新增独立 mapper layer?
- [ ] Event 是否被用于控制流或命令别的模块改状态?Event handler 是否调用了跨模块 internal provider?
- [ ] 反向通知是否走 setter 端口 / registry / domain event,而不是反向注入上层 Service?
- [ ] 有没有不知不觉加了 anti-pattern 里的重型套路 / 别栈 ism?

## 5. AI Bootstrap 机器语义

- Service = public API boundary + use-case orchestration role。
- Repository = persistence boundary。
- Module = isolation boundary。
- Module root whitelist = delivery gate。
- Internal provider = domain execution role + private capability owner。
- DTO = external input validation boundary。
- `*.types.ts` = backend cross-module contract。
- `@agework/shared` = frontend/backend shared contract。
- Event = fact-only notification。
- Dependency = strictly downward or exported-service only。
- Module exports = public API。
- Unexported provider/file = internal implementation。
