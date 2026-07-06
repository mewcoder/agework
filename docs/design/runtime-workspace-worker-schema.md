# Runtime · Workspace · Worker 表设计

## 设计原则

1. **单一数据源（仅 runtimeType）**：`runtimeType` 不再在 Workspace 上单独存一份快照，运行时从
   `workspace.runtime.runtimeType` 派生（Runtime 行必然存在、必然有 runtimeType，这条派生总能成立）。
   `isolationScope` **不做同样处理**——它是 workspace 创建时的一次性选择，不是 Runtime 的固定属性
   （一个 Runtime 的 `capabilities.isolationScopes` 可以同时支持 `user`/`workspace` 两种，派生不出
   唯一值），也不能从 Worker 派生（Worker 是瞬态行，工作空间没有活跃 Worker 时无处可派生）。
   `Workspace.isolationScope` 保留为创建时写入的独立列，`Worker.isolationScope` 是启动时从
   Workspace 复制过去的操作副本，两处并存是必要的，不是没做干净。
2. **FK 保证一致性**：所有引用建外键，删除时行为明确。
3. **瞬态数据不入 FK**：Worker 是运行时载体的存活台账，停了就删，不与 Workspace 建固定 FK。
4. **ownerId 语义归一**：Worker.ownerId 只做并发防重，不承载隔离语义。
5. **关联表保留**：user 隔离下一个 Worker 对应多个 Workspace，需要关联表表达多对多。
6. **Runtime 不物理删除**：注销只打 `removedAt` 标记，行永久保留。因此 Workspace.runtimeId / Worker.runtimeId 都能设计成必填——不存在"引用的 Runtime 行没了"这种情况，也就不需要 `SetNull` 把外键置空来表达失效，避免 `runtimeId = null` 同时表达"本机"和"已失效"两种矛盾语义。

## 最终 Schema

```prisma
model Runtime {
  id              String    @id
  name            String
  source          String    @default("registered") // "registered"=远程机器注册, "builtin"=本机内置
  runtimeType     String?
  /// null = 全局（所有人可用），有值 = 用户私有。
  /// 与 ModelProvider.userId 的模式一致。
  ownerId         String?
  owner           User?     @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  status          String    @default("offline")       // 心跳存活状态："online" | "offline"，跟下面 removedAt 的注销语义无关
  lastHeartbeatAt DateTime?
  tokenHash       String?   @unique                  // builtin 时 null（无需配对鉴权）
  capabilities    Json?
  /// 用户注销该 Runtime 的时间戳；有值 = 已注销，不可再被新 Workspace 绑定，
  /// 但行不物理删除（Workspace/Worker.runtimeId 是必填 FK，指向的行必须一直存在）。
  /// 注销时同时对 name 打散（追加 id 后缀），腾出原名供重新注册同名机器。
  /// builtin 行永远为 null，不可注销。
  removedAt       DateTime?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  workspaces      Workspace[]
  workers         Worker[]

  @@unique([ownerId, name])
  @@index([ownerId])
}

model Workspace {
  id          String              @id
  name        String
  gitUrl      String?
  description String?
  /// 创建时的一次性选择，不可改（要换 = 删了重建）。不能从 Runtime 派生——
  /// 一个 Runtime 的 capabilities 可以同时支持 user/workspace 两种，派生不出
  /// 唯一值；也不能从 Worker 派生——Worker 是瞬态行，没有活跃 Worker 时无处
  /// 可派生。local 的 workspace 行填 "workspace" 占位（无隔离概念）。
  isolationScope  String
  /// 绑定的 Runtime；创建时写入，不可改（要换 = 删了重建）。必填——builtin
  /// Runtime 保证每个 Workspace 创建时都能落到一个真实存在的 Runtime 行。
  /// registered Runtime 被注销（`removedAt` 有值）后行仍在，`runtimeId` 不变，
  /// 但 Workspace 进入"Runtime 已注销"状态，不能跑 run 直到重新绑定到别的 Runtime。
  /// runtimeType 不单独存——用 `runtime.runtimeType` 派生（详见设计原则 1）。
  runtimeId       String
  runtime         Runtime             @relation(fields: [runtimeId], references: [id], onDelete: Restrict)
  userId      String
  user        User                @relation(fields: [userId], references: [id], onDelete: Restrict)
  createdAt   DateTime            @default(now())
  updatedAt   DateTime            @updatedAt
  deletedAt   DateTime?
  directory   WorkspaceDirectory?
  conversations Conversation[]
  workerBindings  WorkerWorkspaceBinding[]

  @@index([userId])
  @@index([userId, deletedAt, createdAt])
  @@index([runtimeId])
}

model Worker {
  id                String    @id
  runtimeType       String
  isolationScope    String    // "workspace" | "user"
  /// 并发防重键：user隔离→userId，workspace隔离→workspaceId。
  /// 全局唯一——见下方"为什么防重键只能是裸 ownerId"，不是 (ownerId, isolationScope,
  /// runtimeId) 复合键。表里只有活跃行(starting/running)，停了立刻物理删除
  /// （不是先标终态再等下次启动时 deleteMany，见下）。
  ownerId           String    @unique
  /// 宿主实例标识（容器 ID / sandbox ID / pid:token）。
  instanceId        String
  transport         String     @default("http")
  startToken        String?
  status            String     @default("starting")
  /// 载体所在的 Runtime，必填。Worker 是瞬态行（停了就删），存在期间它绑定的
  /// Runtime 必然还在（Runtime 不物理删除），不会出现需要置空的中间状态。
  runtimeId         String
  runtime           Runtime    @relation(fields: [runtimeId], references: [id], onDelete: Restrict)
  expiresAt         DateTime?
  metadata          Json
  createdAt         DateTime   @default(now())
  updatedAt         DateTime   @updatedAt
  bindings          WorkerWorkspaceBinding[]

  @@unique([runtimeType, instanceId])
  @@index([runtimeType, isolationScope, status])
  @@index([runtimeId])
}

/// Worker ↔ Workspace 绑定关系。
/// workspace 隔离下 1:1（一个 Worker 只绑一个 Workspace）；
/// user 隔离下 1:N（一个 Worker 绑多个 Workspace，同用户共享载体）。
/// Worker 停了就删，Binding 随 Worker 级联删除。
model WorkerWorkspaceBinding {
  id          String    @id
  workerId    String
  worker      Worker    @relation(fields: [workerId], references: [id], onDelete: Cascade)
  workspaceId String
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  createdAt   DateTime  @default(now())

  @@unique([workspaceId])   // 一个 Workspace 同时只绑一个活跃 Worker
  @@index([workerId])
}
```

## 关系图

```
Runtime ──────────────────────────────────────
  │                                           │
  │ 1:N (runtimeId FK, Restrict, 必填)        │ 1:N (runtimeId FK, Restrict, 必填)
  ▼                                           ▼
Workspace                              Worker
  │                                           │
  │         WorkerWorkspaceBinding             │
  └───────────────────── 1:N ─────────────────┘
        workspace 隔离: 1:1
        user 隔离: 1:N（同用户共享载体）
```

## 变更汇总

| 旧 | 新 | 理由 |
|---|---|---|
| `WorkerInstance` | `Worker` | 简洁 |
| `WorkspaceWorkerBinding` | `WorkerWorkspaceBinding` | Worker 为主体，改名讲清楚意图（现状 `workerInstanceId` 本就无唯一约束，1:N 基数不变，这里只是改名） |
| Binding 表保留 | 不删除 | user 隔离下 1:N，需要关联表表达多对多 |
| Workspace.`runtimeType` | 删除 | 冗余快照，运行时从 `runtime.runtimeType` 派生 |
| Workspace.`isolationScope` | 保留 | 创建时一次性选择，Runtime/Worker 都无法可靠派生它（见设计原则 1），不是遗留冗余 |
| Workspace/Worker.`runtimeId` 可空、松散/SetNull | 改必填 + FK (`Restrict`) | Runtime 不再物理删除（见下），引用的行永远存在，不需要置空表达失效 |
| Runtime | 新增 `removedAt` | 承载"用户注销"语义，与心跳的 `status: online/offline` 分开，也让上面的 FK 能保持必填 |
| Runtime.`ownerId` 必填 | 改 nullable | null = 全局 Runtime（所有人可用），与 ModelProvider 模式一致；下游 `list/getOwned/delete` 等 owner-scoped 查询需要跟着改成"我的 + 全局的" |
| Worker.`activeOwnerKey` | 删除 | 改成 Worker 停了立刻物理删行（不是标终态+懒惰 sweep），表里只剩活跃行，`ownerId @unique` 直接防重，不需要"可置空的占座副本" |
| Runtime.`kind` | 改名 `source` | "这个 Runtime 从哪来"比"什么分类"更准确 |
| Worker.`runtimeInstanceId` | 改名 `instanceId` | 宿主实例标识，原名与 Runtime 表混淆 |

## 设计决策记录

### 为什么保留 WorkerWorkspaceBinding？

user 隔离下一个 Worker 对应多个 Workspace，Worker 上无法存单个 workspaceId。
关联表是表达这种多对多关系的唯一方式。
workspace 隔离下也写一行（1:1），逻辑统一，不分叉。

### 为什么 Workspace 不挂 workerId？

Worker 是运行时载体的存活台账（容器/进程），生命周期是 starting → running → 删除。
它是瞬态的——停了就删行，不像 runtimeId 是创建时定死的稳定归属。
瞬态关系不该固化在 Workspace 表上，通过 WorkerWorkspaceBinding 关联即可。

### 为什么 Worker 停了就删？

1. 改成停/错立刻物理删行（不是标终态、等下次启动时 deleteMany 懒惰清），根本不会堆积，
   比现状"下次启动时 sweep"更彻底：现状终态行会短暂残留，若同一 ownerId 换了
   runtimeType 再起（比如同一用户名下先跑了一个 docker 的 workspace 又跑 opensandbox 的），
   sweep 是按 `(runtimeType, isolationScope, ownerId)` 三元组删的，删不掉"同 owner 不同
   runtimeType"的旧终态行——这也是现状必须靠 `activeOwnerKey` 可置空来避免撞车的原因。
   立刻物理删就没有这个残留窗口，`ownerId @unique` 可以直接生效，不需要
   `activeOwnerKey` 这个"可置空的占座副本"。
2. 保留 stopped 的唯一理由是 Admin 面板看"刚停了什么"，但 RunEvent 已经记录了完整的生命周期事件。
   代价：Admin"运行资源列表"按 `status=stopped/error` 筛选以后永远返回空，历史状态只能去
   RunEvent 查，这是设计上接受的取舍，不是遗漏。

### 为什么防重键只能是裸 ownerId，不能加 isolationScope/runtimeId

grilling 过程中一度想把防重键从 `ownerId` 单列改成 `(ownerId, isolationScope, runtimeId)`
三列，让同一用户在两个不同 Runtime 实例上的 user-scope Worker 不互相撞车。写代码时发现这
站不住：worker-manager 的整条控制面协议——长轮询取命令（`pollCommands(ownerId, ...)`）、
握手确认（`WorkerHandshakeStore`，`Map<ownerId, PendingHandshake>`）、心跳存活
（`WorkerLivenessStore`，按 ownerId 记录 last-seen）、fence 判死——**全部只用 `ownerId`
当 key，协议里根本不认识 `runtimeId`**。哪怕 DB 层放开约束允许同一 ownerId 同时有两个活跃
Worker 行，这两个物理进程回连注册时握手表里还是会互相覆盖同一个 `ownerId` 键，长轮询/心跳也
分不清是哪一个——DB 约束放开了，控制面协议本身撑不住。

真要支持"同一用户同时有多个 runtimeId 各自的 Worker"，得把整条协议（register/poll/心跳/
handshake）的 key 从裸 `ownerId` 换成 `(ownerId, runtimeId)` 复合 key，这是牵一发动全身的
协议改动，不在这次改表范围内。这次维持现状的真实不变量——**系统任一时刻只支持一个 owner
对应一个活跃 Worker，与 runtimeType/runtimeId 无关**——`ownerId @unique` 单列如实反映这条
不变量，不是简化，是现状本来就这样。

### ownerId 的语义

| 表 | ownerId 含义 |
|---|---|
| Runtime | 用户归属：null = 全局，userId = 私有 |
| Worker | 并发防重键：userId（user 隔离）或 workspaceId（workspace 隔离） |

### ownerId 的语义

| 表 | ownerId 含义 |
|---|---|
| Runtime | 用户归属：null = 全局，userId = 私有 |
| Worker | 并发防重键：userId（user 隔离）或 workspaceId（workspace 隔离） |

同名但语义不同。Worker 的隔离语义在 `isolationScope` 字段，不在 `ownerId`。

### isolationScope 选项

| 值 | 含义 | ownerId | 适用 runtimeType |
|---|---|---|---|
| `workspace` | 每 Workspace 独占一个 Worker | workspaceId | local, docker, opensandbox |
| `user` | 同用户共享一个 Worker | userId | docker, opensandbox |

local 只有 `workspace`——没有容器，每个 Workspace 独占一个子进程。
sandbox 两种都支持——有容器边界兜底，user 级共享安全。

### Runtime 字段说明

| 字段 | 含义 | 举例 |
|------|------|------|
| `source` | Runtime 的来源 | `"builtin"` = 本机内置；`"registered"` = 远程机器主动注册 |
| `runtimeType` | 这台机器能跑什么类型的载体 | `"local"` / `"docker"` / `"opensandbox"` |
| `capabilities` | 这台机器支持什么能力 | `{ isolationScopes: ["user", "workspace"] }`，注册时上报 |
| `ownerId` | 归属：null = 全局，userId = 私有 | 与 ModelProvider.userId 模式一致 |
| `tokenHash` | 配对鉴权 token 的 SHA-256 | builtin 时 null（无需配对） |
| `lastHeartbeatAt` | 最后心跳时间 | builtin 时 null（服务活着就是活着） |

### 本机 Runtime 入库

参考 ModelProvider 的系统行模式（`system:claude`、`system:codex`），builtin Runtime 采用相同策略：

- **固定 ID**：`builtin-local`、`builtin-docker`、`builtin-opensandbox`
- **`source = "builtin"`** 区分系统行（对应 ModelProvider 的 `scope = "system"`）
- **启动时 upsert**：`onModuleInit` 中根据 ConfigService 配置写入
- **不可删**：系统行，用户无权删除
- **`status = "online"`**：服务活着就是活着，启动时标记

| id | source | runtimeType | capabilities |
|----|--------|------------|--------------|
| builtin-local | builtin | local | { isolationScopes: ["workspace"] } |
| builtin-docker | builtin | docker | { isolationScopes: ["user", "workspace"] } |
| builtin-opensandbox | builtin | opensandbox | { isolationScopes: ["user", "workspace"] } |

- local 只有 `workspace` 隔离——没有容器，每 Workspace 独占一个子进程。
- 依赖部署配置：ConfigService 允许了哪些 runtimeType，就 upsert 几行。
- 入库后 Workspace.runtimeId 必有值（FK 必填），查询路径统一。
- builtin 行的 tokenHash / lastHeartbeatAt 为 null，对它们无意义；`removedAt` 也恒为 null。
- Admin 面板可以看到本机 Runtime 的能力和状态。

### registered Runtime 被注销时的处理

registered Runtime 被注销时只打 `removedAt` 标记，行不删除，Workspace.runtimeId 不变。
Workspace 进入"Runtime 已注销"状态，不能跑 run，直到重新绑定到别的 Runtime。
注销同时把该行 `name` 打散（追加 id 后缀），腾出原名允许用户用同名重新注册一台机器
（否则 `@@unique([ownerId, name])` 会因为旧的注销行还占着名字而拒绝重建）。
后续需要提供重新绑定 Runtime 的途径（待定）。

**注销不影响这台机器上现有的 Worker**：选择"放任不管"——已经在跑的 Worker 继续跑到自然
结束（进程自己退出，或心跳超时被 fence 判死），注销这个动作本身只拦"以后不能再绑定新
workspace"，不主动去停/删现有 Worker。因此注销**不能**再像现状 `RuntimeService.delete()`
（`runtime.service.ts:97-104`）那样顺手 `tunnelHandler.closeConnection(id)` 踢断隧道连接——
连接一断，在线的 Worker 立刻上报不了心跳/事件，等于变相强制判死，跟"放任不管"的初衷矛盾。
注销后连接的存活/掉线继续按原有心跳机制走，不因 `removedAt` 被打标而改变。

> TODO：确认现状代码里是否有别的地方假设"Runtime 被删除 = 连接必然已关闭"（比如某个判断
> 依赖 `delete()` 一定会调 `closeConnection`），迁移到"注销不关连接"之后要逐一排查改掉。

### 迁移：历史 Workspace.runtimeId 回填

现状 `Workspace.runtimeId = null` 表示 Managed（本机 in-process），迁移前必须先把这些
历史行的 `runtimeId` 回填成对应的 `builtin-local` / `builtin-docker` / `builtin-opensandbox`
（依据回填时刻仍在的 `runtimeType` 快照列判断落哪一个），才能把 `runtimeId` 改成必填列并
删除 `runtimeType` 这一列快照（`isolationScope` 保留，不删）。否则回填前建 NOT NULL 约束
会直接失败，且历史 workspace 的运行环境信息也无处可查。`Worker.runtimeId` 同理，但因为
Worker 是瞬态行（进程一停就删），迁移窗口内 stop 掉所有存量 Worker 后重新起号即可，不需要
回填历史数据。

本仓库当前是 dev-only 阶段（`prisma db push`，无迁移历史文件），dev.db 里没有需要保留的
真实生产数据，回填脚本作为设计记录保留在这里，实现时直接 `db push --force-reset` 重置更快，
不必真的写回填脚本。

现状代码里大量地方把 `runtimeId === null` / `Boolean(workspace.runtimeId)` 当作
"是否 Managed" 的判断依据（`runtime.service.ts` 的 `runtimeFor()`、
`worker-manager/instance/lifecycle.handler.ts`、`worker-manager/instance/worker.provisioner.ts`、
`workspace.service.ts`、`run/launch/run-launcher.ts` 等，共 6+ 处），迁移后 `runtimeId`
永远非空，这些判断要全部改成"`runtime.source === "builtin"`"或等价的显式判断，不能再靠
是否为 null 分辨 Managed/Registered。

### 查询路径

| 场景 | 查询方式 |
|---|---|
| 找 Workspace 的活跃 Worker | `WorkerWorkspaceBinding.findUnique({ where: { workspaceId } }).worker()` |
| 找 Worker 绑了哪些 Workspace | `WorkerWorkspaceBinding.findMany({ where: { workerId } })` |
| 找 Workspace 的 Runtime | `Workspace.runtime`（FK 直连） |
| 找 Worker 的路由目标 | `Worker.runtime`（FK 直连） |
| 找 Runtime 下所有 Worker | `Runtime.workers`（反向关系） |
| user 隔离下找用户的 Worker | `Worker.findUnique({ where: { ownerId: userId } })`（ownerId 全局唯一，见上） |
| 用户看自己可用的 Runtime 列表 | `Runtime.findMany({ where: { OR: [{ ownerId: userId }, { ownerId: null }], removedAt: null } })`——不能沿用现状 `where: { ownerId }` 单一过滤，否则用户看不到 builtin 行 |
