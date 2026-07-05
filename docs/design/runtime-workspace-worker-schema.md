# Runtime · Workspace · Worker 表设计

## 设计原则

1. **单一数据源**：`runtimeType` / `isolationScope` 不再三处冗余，运行时从关联对象派生。
2. **FK 保证一致性**：所有引用建外键，删除时行为明确。
3. **瞬态数据不入 FK**：Worker 是运行时载体的存活台账，停了就删，不与 Workspace 建固定 FK。
4. **ownerId 语义归一**：Worker.ownerId 只做并发防重，不承载隔离语义。
5. **关联表保留**：user 隔离下一个 Worker 对应多个 Workspace，需要关联表表达多对多。

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
  status          String    @default("offline")
  lastHeartbeatAt DateTime?
  tokenHash       String?   @unique                  // builtin 时 null（无需配对鉴权）
  capabilities    Json?
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
  /// 绑定的 Runtime；创建时写入，不可改（要换 = 删了重建）。
  /// Runtime 被删时置空，回落到无绑定状态。
  /// builtin Runtime 不可删，registered Runtime 被删后 runtimeId 置空，
  /// Workspace 进入"无 Runtime"状态，不能跑 run 直到重新绑定。
  runtimeId       String?
  runtime         Runtime?            @relation(fields: [runtimeId], references: [id], onDelete: SetNull)
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
  /// 表里只有活跃行(starting/running)，停了就删。
  /// 复合唯一保证同一 ownerId 在同一隔离级别下只有一个活跃 Worker。
  ownerId           String
  /// 宿主实例标识（容器 ID / sandbox ID / pid:token）。
  instanceId        String
  transport         String     @default("http")
  startToken        String?
  status            String     @default("starting")
  /// 载体所在的 Runtime;null = 已解绑（Runtime 被删后置空）。
  runtimeId         String?
  runtime           Runtime?   @relation(fields: [runtimeId], references: [id], onDelete: SetNull)
  expiresAt         DateTime?
  metadata          Json
  createdAt         DateTime   @default(now())
  updatedAt         DateTime   @updatedAt
  bindings          WorkerWorkspaceBinding[]

  @@unique([runtimeType, instanceId])
  @@index([runtimeType, isolationScope, status])
  @@index([runtimeId])
  @@unique([ownerId, isolationScope])
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
  │ 1:N (runtimeId FK, SetNull)              │ 1:N (runtimeId FK, SetNull)
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
| `WorkspaceWorkerBinding` | `WorkerWorkspaceBinding` | Worker 为主体，一个 Worker 绑多个 Workspace |
| Binding 表保留 | 不删除 | user 隔离下 1:N，需要关联表表达多对多 |
| Workspace.`runtimeType` / `isolationScope` | 删除 | 冗余快照，运行时从 `runtime.runtimeType` / `worker.isolationScope` 实时派生 |
| Worker.`runtimeId` 松散引用 | 加 FK (`SetNull`) | DB 保证一致性，删除 Runtime 时 Worker 自动置空 |
| Runtime.`ownerId` 必填 | 改 nullable | null = 全局 Runtime（所有人可用），与 ModelProvider 模式一致 |
| Worker.`activeOwnerKey` | 删除 | Worker 停了直接删行，表里只有活跃行，`ownerId @unique` 直接防重 |
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

1. stopped 行在下次启动时也会被 deleteMany 清掉（原代码 insertStarting 里的逻辑），根本不会堆积。
2. 保留 stopped 的唯一理由是 Admin 面板看"刚停了什么"，但 RunEvent 已经记录了完整的生命周期事件。
3. 停了就删后 `ownerId` 可以直接 `@unique`，不再需要 `activeOwnerKey` 这个"可置空的占座副本"。

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
- 入库后 Workspace.runtimeId 通常有值，查询路径统一。
- builtin 行的 tokenHash / lastHeartbeatAt 为 null，对它们无意义。
- Admin 面板可以看到本机 Runtime 的能力和状态。

### registered Runtime 被删时的处理

registered Runtime 被删时，Workspace.runtimeId 被 `SetNull` 置空。
Workspace 进入"无 Runtime"状态，不能跑 run。
后续需要提供重新绑定 Runtime 的途径（待定）。

### 查询路径

| 场景 | 查询方式 |
|---|---|
| 找 Workspace 的活跃 Worker | `WorkerWorkspaceBinding.findUnique({ where: { workspaceId } }).worker()` |
| 找 Worker 绑了哪些 Workspace | `WorkerWorkspaceBinding.findMany({ where: { workerId } })` |
| 找 Workspace 的 Runtime | `Workspace.runtime`（FK 直连） |
| 找 Worker 的路由目标 | `Worker.runtime`（FK 直连） |
| 找 Runtime 下所有 Worker | `Runtime.workers`（反向关系） |
| user 隔离下找用户的 Worker | `Worker.findFirst({ where: { ownerId: userId, status: "running" } })` |
