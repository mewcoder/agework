# 后端模块架构规范(apps/api)

适用于 `apps/api`(NestJS 11 + Prisma)。这是后端的**理想目标态**,既给人看,也给编辑本仓库的 AI agent 当护栏。

一句话总纲:**这是「按领域切的模块化单体」,不是 DDD,也不要上 DDD。按角色分层,不按教条分层;每一层、每一个文件夹、每一个借来的 pattern,都得为本栈(NestJS + Prisma + 大量 agent 编辑)重新挣到存在理由,挣不到就砍。**

> **这套有行业出处,不是自创**:竖切按领域 = **Modular Monolith**(Simon Brown)/ **Package by Feature**;按领域而非按层切 = **Vertical Slice Architecture**(Jimmy Bogard);`module/controller/service` + `imports/exports` 跨模块调 service = **NestJS 官方 feature module** 的标准用法;只向下、不成环 = **Acyclic Dependencies Principle**(Robert C. Martin);领域边界 + 唯一公开门 = **Strategic DDD / Bounded Context**(Eric Evans)。即:**保留 DDD 的战略边界,丢弃战术重型建模**(见末节「不要做」)。

## 何时适用

- 新增 / 重构 feature module、controller、service、repository
- 划模块边界、定模块间依赖
- 加 DTO 校验、guard、interceptor、exception filter
- 写后端单测

## 总则:竖切为主

先问「属于哪个领域」(竖),再问「在领域里是什么角色」(横)。

- 一个 module = 一个业务领域;`Service` 是该领域对外**唯一的门**。
- 横向的 Controller / Service / Repository 只是领域**内部**角色,不是顶层组织原则。
- 模块外只认领域的公开面,不认它内部怎么分层。

为什么不是 DDD:本工程的复杂度在异步编排 / 流式 / runtime 生命周期(过程复杂度),不在领域不变量。给过程复杂度套聚合 / 值对象 / 充血实体只是搬运复杂度。借 DDD 的轻量战术(domain event、repository、领域边界)即可,拒绝重型建模(见末节)。

## 模块骨架

**根目录只放领域的「门面文件」+ 子文件夹;内部辅助文件不平铺在根。** 哪些门面文件该有,按职责定,不是「凑齐」:

- **`module` + `service`:每个领域必有。** module 是零逻辑组合根,service 是领域唯一对外的门。
- **`controller`:对外暴露 HTTP 才有。**(runtime 不暴露 HTTP,根上就没有 controller。)
- **`repository`:领域持有数据(表)才有。**(auth 不持表、把数据委托给 `UserService`,所以没有 repository。)
- **`types` / `events` / `dto/`:按需,有就有、没有就不建。**

各领域看起来**相似**(同一套门面槽位),但**不强求文件数量一致、不为凑齐而造空文件 / 空文件夹**。

标准模块:

```
users/
├── user.module.ts           # 零逻辑,只组合
├── user.controller.ts       # 瘦,只 HTTP I/O
├── user.service.ts          # 领域唯一对外入口 + 编排
├── user.repository.ts       # 独占 Prisma 的 DB 访问
├── user.types.ts            # 跨边界类型(有才建)
├── *.spec.ts                # 贴各自源文件
└── dto/                     # 外部输入 + class-validator
```

大模块(顶层不变,内部能力下沉到**少而厚**的文件夹):

```
runtime/
├── runtime.module.ts
├── runtime.service.ts       # 领域唯一对外入口
├── instances/               # 稳定子能力(实例生命周期)
├── providers/               # 稳定子能力(各 runtime provider)
└── sandbox/                 # 稳定子能力(sandbox 执行)
```

(runtime 不对外暴露 HTTP、根上不持表,所以根只有 module + service;领域若有 HTTP / 自己的表,根上再加 `controller` / `repository` / `types`。)

规则:

- **根目录一眼只有门面文件 + 子文件夹**(module/service 必有,controller/repository/types 按职责),内部辅助文件不许平铺在根。
- **文件夹少而厚**:能合则合,宁可 3 个厚文件夹,不要 6 个薄文件夹;但也别为 1 个文件单建文件夹。
- **子文件夹按子能力 / 子领域命名**(如 `credentials/`、`instances/`、`sandbox/`),让名字自解释;不用泛化的 `internal/` / `common/` / `utils/` 兜底。
- **`module.ts` 零逻辑**,只组合 imports/providers/controllers/exports。
- **`controller` 瘦**:解析 HTTP 输入、调 Service、返回结果,不写业务。
- **文件名标明它是什么**,让文件名承担分类:目录名可按路由 / 集合用复数(`users/`),文件前缀统一用领域概念名并沿用现有模块约定(`user.service.ts` / `user.repository.ts` / `user.types.ts`;已有 `runs.module.ts` 这类历史命名先保持一致),不要按某个 service 命名(别写成 `user-service.types.ts`);结构后缀固定(`*.module/controller/service/repository/types/events/dto/spec`)。内部辅助文件用一个能说清职责的词收尾(`sandbox.executor.ts`、`provider.registry.ts` 这类是**自然长出来的,不是要背的清单**)。起不出这种名字就别抽文件,留在 owner Service 的 private method 里。

**工具函数 / 转换函数放哪(非必要勿拆):**

- **默认不拆**:工具函数先当 owner Service 的 `private` 方法 / 同文件局部函数,**满足一条才抽成独立文件**——被 ≥2 处真复用、或厚到自成可读单元、或是纯函数且值得精准单测。
- **抽出来按「认不认识领域」决定位置**:认识某领域概念(读 user 字段 / 按 run 状态算…)、只该领域用 → **留模块内**(私有方法,厚了抽 `xxx-<职责>.ts` / 进子文件夹);不认识领域、纯通用且只后端用 → `apps/api/src/common/`;不认识领域、前后端都可能用 → `@agework/shared`(如 `message-text`、`generateId`)。
- **行 → 响应 DTO 的转换放 Service 私有方法**(如 `toUserDto`),敏感字段在 Repository 用 `select`/`omit` 挡;**不要**为它建 `mapper.ts` / mapper 层。

## 子文件夹 vs 平级 module

子能力放进**父模块的子文件夹**,还是提升为**和父模块平级的根 module**?

**两条必要条件**(都满足才考虑提升):

1. **是独立领域或横切能力**——有自己的概念名,不是父模块的某个「阶段 / 动作 / 侧面」。
2. **拆出去依赖不成环**——和父模块保持单向,不互相依赖(成环就别拆,更不许用 `forwardRef` 圆场)。

**支撑信号**(有得越多越站得住,但都不是门槛):

- 拥有自己的表 / 独立持久化;
- 被 ≥2 个模块依赖或明显可复用。

> **module 不要求有表。** `auth`(认证)、`worker-host`(传输 / 集成层)都没有自己的表,但都是清晰的横切 / 集成领域,理应独立成 module。「有表」只是强信号,不是准入门槛。

- ✅ 正例:`run-events` 和 `runs` 平级——独立概念(事件日志)+ 自己的表(`run-event.repository`)+ 被独立查询。
- ❌ 反例:一个领域「生命周期」的各侧面(执行 / 状态 / 流式 / 恢复)共享同一份状态、彼此咬合,拆成平级 module 必然成环——留在父模块当子文件夹,乱了就「合文件夹」(少而厚),不是「拆模块」。

## 模块边界

```ts
// runtime.module.ts —— 公开面只有 RuntimeService,其余全是内部实现
@Module({
  providers: [RuntimeService, RuntimeProviderRegistry /* ...instances/sandbox 内部 */],
  exports: [RuntimeService],
})
export class RuntimeModule {}
```

- **`module.exports` 定义公开面**;没 export 的就是内部实现。默认只 export `Service`。
- **禁止跨模块 reach 进内部文件**(repository / 子目录里的任何文件)。要什么,走对方公开 `Service`。
- **跨边界类型进 `*.types.ts` 或 `@agework/shared`**;禁止从 service 实现文件导出类型(被别人 import 的类型就是契约,搬进 `*.types.ts`)。
- **防 God Service**:「Service 是唯一**对外**入口」必须配「**内部**按能力激进拆分」。单入口约束的是公开面,不是把逻辑堆进一个胖类。

## 跨领域调用

要用另一个领域的能力,**只调它导出的 `Service`,构造注入,只向下**:

```ts
// auth.module.ts —— Auth 在 Users 之上,导入 Users 的公开 module
@Module({
  imports: [UserModule],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}

// auth.service.ts —— 只注入 Users 导出的公开 Service
@Injectable()
export class AuthService {
  constructor(private readonly users: UserService) {}  // 注入对方公开 Service

  login(u: string, p: string) {
    return this.users.authenticate(u, p);               // 调它的公开方法
  }
}
```

- **同一个 `Service` 同时服务两类调用者**:自己的 `Controller`(HTTP)+ 上层领域的 `Service`(跨域)。**只有一个公开面、一条规则(向下、不成环),不拆「给 controller 的脸」和「给领域的脸」**;真分叉到一个类塞不下时再说,默认别预拆。
- **只调对方 `Service`**,绝不 reach 进它的 `repository` / 子能力文件(那里有原始 / 敏感数据,且没有授权)。
- **调之前自检一句:「对方会不会(直接或传递)反过来依赖我?」**
  - 否 → 直接调,你就是它的上层,合法。
  - 是 → 你在闭一个环,说明边界划错 / 方向反了,改用下面的拆环动作,**禁止 `forwardRef` 圆场**。
- **「同级」不是预先贴的标签**:你调了 B,你就排在 B 之上。不存在「同级直连该不该」的问题,只存在「这次调用会不会成环」。
- 两个领域要协作、又排不出谁在上时,拆环四选一:**① 定序**(多数「同级」其实有天然低者)/ **② 上提**——把协作上提到拥有该用例的更上层 Service,它向下调两边 / **③ 下沉**——把共享物抽成更低的 module,两边都向下调它 / **④ 事件**——若只是「通知已发生的事实」,用 domain event 断开依赖(见下节)。

## 依赖方向与事件

```ts
// 反向通知:下层在 module 组合根用 setter 端口 / registry 注册回上层入口,
// 而不是反向注入上层 Service。
this.someRegistry.setReceiver(this.eventsService);     // registry 端口
this.liveSessions.setTimeoutErrorSink(this.eventsService); // 回调端口
```

- **依赖单向**:`Auth → Users → Conversations → Runs → Runtime / WorkerHost`。下层不得反向注入或直接调上层 Service。
- **禁止 `forwardRef`**:出现循环依赖说明边界划错,重划,别用 `forwardRef` 掩盖。
- 需要反向通知时三选一:`EventEmitter2` domain event(跨域事实通知)/ 回调端口 `set*Sink`(结果回灌)/ Registry(多态注册)。
- **硬规则(最高优先级)——事件只通知,不命令**:domain event 只用于「通知已发生的事实」(过去式、fire-and-forget)。**禁止用事件去命令另一个模块改它的状态**。下层只发「发生了什么」,状态变更归领域自己决定。

## 数据访问

```ts
@Injectable()
export class UserRepository {
  constructor(private prisma: PrismaService) {} // 唯一注入 Prisma 的地方
  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }
}
```

- **一律走 Repository,Service 不注入 `PrismaService`。** 理由:本仓库大量被 agent 编辑,「一律走仓储」是是非题(照模板不会判错),优于「有查询才上」的判断题(易判错、在不该碰 Prisma 处戳进去)。
- **护栏**:Repository 可以薄;**禁止**叠 `interface IXxxRepository` + injection token + 实现类;**Repository per 领域,不 per 表**。
- 多步写用 `prisma.$transaction(fn)`:Prisma 查询和 tx client 留在 Repository;Service 可编排用例,但不直接写 Prisma 查询。留意并消除 N+1。
- 响应不泄敏字段:**默认在 Repository 用 `select` / `omit` 把 password hash / token / 审计列挡在源头**(别建 response-DTO mapper 层)。

## 输入校验

```ts
// main.ts —— 一处全局,不在路由重复
app.useGlobalPipes(
  new ValidationPipe({ whitelist: true, transform: true /* 公开 API 建议加 forbidNonWhitelisted */ }),
);
```

- 每个请求 DTO 用 `class-validator` 装饰,放各模块 `dto/`。
- 一切外部输入(body / query / param / header)都校验;路径参数用 `ParseUUIDPipe` 等管道。

## 错误处理

```ts
// 预期内客户端错误,抛框架异常;全局 AllExceptionsFilter 统一外壳
throw new NotFoundException("user not found");
// → { code, data: null, message, requestId }
```

- 预期错误抛 NestJS `HttpException` 族;统一外壳由全局 `common/filters`(`AllExceptionsFilter`)兜。
- **不在 Service 里 try/catch 吞错**;非预期失败冒泡到全局 filter 集中记录。

## 鉴权 · 配置 · 日志(横切)

- **鉴权分两层**:粗粒度访问控制(登录态、角色)放 guard(`JwtAuthGuard` / `RolesGuard`);**资源级授权**(这个用户能不能动这条数据)放 Service,别全塞进 guard。
- **配置收口**:外部配置 / env 经 `ConfigService` 统一读取与校验,**非法值启动即抛**、不带病运行;feature 代码不直接读 `process.env`。
- **日志**:统一结构化日志 + 透传 `x-request-id`(全局 `AllExceptionsFilter` 已落);不在业务里散写 `console`。

## 测试

```ts
// 手搓 mock,经构造注入,不必起整个容器
const repo = { findById: vi.fn() } as unknown as UserRepository;
const service = new UserService(repo, /* ...其余 mock */);
```

- `*.spec.ts` 贴着实现放;用 Vitest。
- 单测里依赖手搓 mock + 构造注入;要测 guard / pipe / filter 时才用 `Test.createTestingModule`。
- 改 `shared` / `adapters` / `runtime` / 消息聚合等共享逻辑,优先补精准单测。

## 不要做

每条都附「为什么本工程不需要」。看到「最佳实践」想加这些时,停。

DDD / Hexagonal 重型套路(本工程是过程复杂度,不是富领域):

- 充血实体 / 值对象 / aggregate root 建模 —— 没有富领域不变量要封装。
- `domain/application/infrastructure` 三层目录 —— 竖切按领域已够,三层是无意义层级。
- use-case / command-handler 套路 —— Service 方法就是用例。
- ports & adapters 命名包 —— 解耦已用 Registry / EventEmitter。
- CQRS / event sourcing / outbox / anti-corruption layer —— 没有对应需求。
- response-DTO mapper 层(每模型一套出参映射)—— 目标是「不泄露」,用 `select` 即可。

为「分层好看」造的无意义结构:

- God Service —— 单入口要配内部拆分。
- repository-per-table —— per 领域不 per 表。
- 为分层而分层的空层级 —— 抽不抽看「独立变化原因」,不看行数。

从通用 NestJS 模板筛掉的「别栈 ism」:

- `src/modules/` 包壳 —— feature 直接放 `src/` 顶层。
- `entities/` 文件夹 —— TypeORM-ism,Prisma 不写 entity 类,用 Prisma 类型 + `*.types.ts`。
- 根目录平铺一堆内部文件 / 为 1 个文件单建文件夹 —— 见「模块骨架」:根只留门面文件 + 子文件夹,其余进少而厚的文件夹。

## 自检清单

- [ ] 模块根目录是不是只有门面文件(module/service 必有,controller/repository 按职责)+ 子文件夹?有没有为「凑齐」造空文件 / 空文件夹?
- [ ] 文件夹是不是「少而厚」、按子能力命名?有没有薄文件夹该合、或散文件该收进文件夹?
- [ ] 跨模块调用是不是只走对方公开 `Service`?有没有 reach 进别人内部?
- [ ] 跨领域调用前,有没有确认对方不会(传递地)反过来依赖我(不成环)?
- [ ] Service 有没有直接注入 `PrismaService`?(应走 Repository)
- [ ] 有没有用事件去**命令**别的模块改状态?(应只通知事实)
- [ ] 响应里会不会漏出敏感字段?
- [ ] 有没有不知不觉加了「不要做」里的重型套路 / 别栈 ism?
