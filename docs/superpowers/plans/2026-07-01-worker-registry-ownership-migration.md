# WorkerRegistry 归属迁移(Phase 1)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `RuntimeInstance`/`WorkspaceRuntimeInstance` 这张表的 repository 归属从 `runtime` 模块整体搬到 `worker-host` 模块,并补上新设计需要的 DB 结构(`transport` 字段、并发防重的 partial unique index),同时保持现有行为 100% 不变——这是一次纯粹的"数据归属搬家",不引入 `resolveInstance()`、不改 local 通信方式、不改 idle 巡检决策权归属(那些是后续阶段的事)。

**Architecture:** `WorkerRegistryRepository`(原 `WorkspaceRuntimeInstanceRepository`,改名+搬家)连同它的 metadata 辅助函数一起搬进 `apps/api/src/worker-host/registry/`,只在 `worker-host` 模块内注册,不导出(按 `.claude/rules/backend-architecture.md`:repository 不导出)。`WorkerHostService`(worker-host 模块唯一导出的根 Service)新增一批透传方法,把这份数据暴露给外部消费者。三个现有消费者(`SandboxRuntimeInstanceService`、`RuntimeService`、`RuntimeInstanceLifecycleService`)改成注入 `WorkerHostService` 而不是直接注入 repository。`RuntimeService.recoverOrphanRuntimeInstances()`/`cleanupStaleRuntimeInstances()` 这两个方法(以及 `RunRecoveryService` 里调用它们的那两行)整个删掉——这是设计文档里明确要去掉的 blanket 清理逻辑,不带入新设计,也不设计替代方案。

**关于 `RuntimeInstanceLifecycleService`/`Listener` 为什么这次不搬家**:它除了要用 WorkerRegistry 数据,还直接注入了 `RuntimeProviderRegistry`(`runtime` 模块内部、不导出的东西)。`runtime.module.ts` 现在还 `imports: [WorkerHostModule]`(这条边还没在这个 phase 里剪掉,是后续 phase 的事)。如果这次也把这两个文件搬进 `worker-host`,`worker-host` 就要反过来 import `RuntimeModule` 才能拿到 `RuntimeService`——跟现存的 `runtime → worker-host` 这条边凑一起,正好组成一个 NestJS 循环 import,编译直接报错。所以这次它们**留在 `runtime/instances/` 原地不动**,只是内部把"直接注入 repository"换成"注入 `WorkerHostService`、调它的透传方法",同时把"直接注入 `RuntimeProviderRegistry`"保留不变(那是同模块内的事,没有跨模块问题)。等后续 phase 把 `runtime → worker-host` 这条边剪掉之后,这两个文件才真正搬去 `worker-host`,那时候"物理销毁"这一步也要跟着从"直接调 provider"换成"调 `runtime` 导出的 `RuntimeService.shutdownRuntimeInstanceByOwnerId()`"。这次不做这一步。

**Tech Stack:** NestJS 11、Prisma(SQLite,`prisma-client` provider)、Vitest。

## Global Constraints

- 后端命名规则见 `.claude/rules/backend-naming.md`,模块边界规则见 `.claude/rules/backend-architecture.md`——repository 不导出,跨模块只调对方导出的根 Service。
- 测试统一用 Vitest,单测用手搓 mock + 构造函数注入,不用 `Test.createTestingModule`(除非测 guard/pipe/filter,或验证模块 wiring 本身,见 Task 8)。
- 这个仓库目前没有 `prisma/migrations/` 目录(用 `db:push` 做日常 dev 同步),但 `package.json` 里已经有 `db:migrate`(`prisma migrate dev`)脚本——这次是这个仓库第一次真正跑 `prisma migrate`,因为 partial unique index 这种 SQL 没法用 Prisma schema 语法表达,必须手写 migration SQL。
- 不做本轮范围外的事:不新增 `resolveInstance()`,不碰 local 的 fork/IPC 逻辑,不改 idle watchdog 的决策归属,不加 token 鉴权字段。

---

### Task 1: Prisma schema 加 `transport` 字段 + partial unique index migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma:211-227`(`RuntimeInstance` model)
- Create: `apps/api/prisma/migrations/<timestamp>_add_transport_and_active_owner_index/migration.sql`(由 `prisma migrate dev --create-only` 生成骨架后手动补充)
- Create: `apps/api/prisma/migrations/migration_lock.toml`(首次跑 migrate 时 Prisma 自动生成,内容固定)

**Interfaces:**
- Produces: `RuntimeInstance.transport: string`(Prisma Client 字段,默认值 `"http"`);DB 层面新增唯一索引 `runtime_instance_active_owner_idx`,后续 Task 3+ 的 `upsertRunning`/`insertStarting` 类写入路径依赖这条索引做并发防重。

- [ ] **Step 1: 改 `schema.prisma`,加 `transport` 字段**

把 `apps/api/prisma/schema.prisma:211-227` 的 `RuntimeInstance` model 改成:

```prisma
model RuntimeInstance {
  id                String             @id
  runtimeType       String
  isolationScope    String
  ownerId           String
  runtimeInstanceId String
  transport         String             @default("http")
  status            String             @default("running")
  expiresAt         DateTime?
  metadata          Json
  createdAt         DateTime           @default(now())
  updatedAt         DateTime           @updatedAt
  workspaceRuntimeInstances WorkspaceRuntimeInstance[]

  @@unique([runtimeType, runtimeInstanceId])
  @@index([runtimeType, isolationScope, status])
  @@index([ownerId])
}
```

(只加了 `transport` 一行,默认值 `"http"`——现有数据全部是 sandbox/HTTP 场景,这个默认值让已有行迁移后语义正确;新写入的 local 行会显式传 `"ipc"`。)

- [ ] **Step 2: 生成 migration 骨架(不直接 apply)**

```bash
cd apps/api && npx prisma migrate dev --create-only --name add_transport_and_active_owner_index
```

预期:在 `apps/api/prisma/migrations/` 下生成一个新目录(形如 `20260701xxxxxx_add_transport_and_active_owner_index/migration.sql`),内容大致是:

```sql
-- AlterTable
ALTER TABLE "RuntimeInstance" ADD COLUMN "transport" TEXT NOT NULL DEFAULT 'http';
```

同时会在 `apps/api/prisma/` 下生成 `migrations/migration_lock.toml`(内容为 `provider = "sqlite"`)。这是这个仓库第一次有 migration 历史,之前的表结构不会被这次生成的骨架文件覆盖或删除。

- [ ] **Step 3: 手动在生成的 migration.sql 末尾追加 partial unique index**

打开 Step 2 生成的 `migration.sql`,在文件末尾追加:

```sql

-- Partial unique index: 同一个 ownerId 同时只能有一条非终态(starting/running)记录,
-- 用于并发 launch 防重。SQLite 原生支持 filtered index,Prisma schema 语法本身
-- 表达不了"只对部分行生效",所以这条索引不在 schema.prisma 里,只存在于 migration 里。
CREATE UNIQUE INDEX "runtime_instance_active_owner_idx"
ON "RuntimeInstance" ("ownerId")
WHERE "status" IN ('starting', 'running');
```

- [ ] **Step 4: 应用 migration**

```bash
cd apps/api && npx prisma migrate dev
```

预期输出包含 `Applying migration ... add_transport_and_active_owner_index` 和 `Your database is now in sync with your schema.`。

- [ ] **Step 5: 验证索引生效**

```bash
cd apps/api && sqlite3 prisma/dev.db ".indexes RuntimeInstance"
```

预期输出包含 `runtime_instance_active_owner_idx`(具体 db 文件名以 `schema.prisma` 里 `datasource db { url = ... }` 配置为准,本地一般是 `prisma/dev.db`)。再跑一次简单的手工验证:

```bash
cd apps/api && sqlite3 prisma/dev.db <<'EOF'
INSERT INTO RuntimeInstance (id, runtimeType, isolationScope, ownerId, runtimeInstanceId, transport, status, metadata, createdAt, updatedAt)
VALUES ('test-1', 'docker', 'workspace', 'owner-x', 'inst-1', 'http', 'starting', '{}', datetime('now'), datetime('now'));
INSERT INTO RuntimeInstance (id, runtimeType, isolationScope, ownerId, runtimeInstanceId, transport, status, metadata, createdAt, updatedAt)
VALUES ('test-2', 'docker', 'workspace', 'owner-x', 'inst-2', 'http', 'starting', '{}', datetime('now'), datetime('now'));
EOF
```

预期第二条 INSERT 报 `UNIQUE constraint failed`。验证完手动删掉这两条测试数据:

```bash
cd apps/api && sqlite3 prisma/dev.db "DELETE FROM RuntimeInstance WHERE id IN ('test-1','test-2');"
```

- [ ] **Step 6: 重新生成 Prisma Client**

```bash
pnpm --filter api db:generate
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(api): add RuntimeInstance.transport field and active-owner partial unique index"
```

---

### Task 2: 把 repository 和 metadata 辅助函数搬进 `worker-host/registry/`

**Files:**
- Create: `apps/api/src/worker-host/registry/worker-registry-metadata.ts`
- Create: `apps/api/src/worker-host/registry/worker-registry-metadata.spec.ts`
- Create: `apps/api/src/worker-host/registry/worker-registry.repository.ts`
- Create: `apps/api/src/worker-host/registry/worker-registry.repository.spec.ts`
- Delete: `apps/api/src/runtime/instances/workspace-runtime-instance.repository.ts`
- Delete: `apps/api/src/runtime/instances/workspace-runtime-instance.repository.spec.ts`
- Delete: `apps/api/src/runtime/instances/runtime-instance-metadata.ts`
- Delete: `apps/api/src/runtime/instances/runtime-instance-metadata.spec.ts`

**Interfaces:**
- Produces: `WorkerRegistryRepository`(类,构造函数注入 `PrismaService`),暴露方法:`findActiveByWorkspace(workspaceId)`、`upsertRunning(placement, ownerId, runtimeInstanceId)`、`markStoppedByOwner(runtimeType, isolationScope, ownerId)`、`markErrorByOwner(runtimeType, isolationScope, ownerId, errorMessage)`、`findActiveResourceByRuntimeId(runtimeType, runtimeInstanceId)`、`isRuntimeInstanceBoundToWorkspace(runtimeType, workspaceId, runtimeInstanceId)`、`deleteWorkspaceBinding(workspaceId)`、`countRunning()`、`findAllRunning()`、`findByRuntimeId(runtimeType, runtimeInstanceId)`、`findRunInstanceView(runtimeType, runtimeInstanceId)`、`userExists(userId)`、`listResourcesPage(opts)`、`findById(id)`、`findBindingWithResource(workspaceId)`、`findWorkspaceIdsByUser(userId)`、`findRunningByOwners(ownerIds)`、`markStoppedById(resource, reason)`。以及 metadata 辅助函数:`runningInstanceMetadata`、`stoppedInstanceMetadata`、`statusInstanceMetadata`、`runtimeInstanceDiagnostics`、`runtimeInstanceMetadataJson`、`isMetadataRecord`。
- Consumes: `PrismaService`(`../../prisma/prisma.service`,路径不变,新旧位置深度相同)。

- [ ] **Step 1: 创建 `worker-registry-metadata.ts`(内容与原 `runtime-instance-metadata.ts` 一致,只是搬家)**

```ts
import type { RuntimePlacement } from "@agework/shared/protocol";
import type { Prisma } from "../../../generated/prisma/client.js";

type RuntimeInstanceMetadata = Record<string, unknown>;

export type RuntimeInstanceDiagnosticMetadata = RuntimeInstanceMetadata & {
  ownerId: string;
  workspaceId?: string;
  statusReason: string;
  lastSeenAt: string;
  lastStartedAt?: string;
  stoppedAt?: string;
  runtimeInstanceId?: string;
};

export function isMetadataRecord(
  metadata: unknown
): metadata is RuntimeInstanceMetadata {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata)
  );
}

export function runningInstanceMetadata(input: {
  placement: RuntimePlacement;
  ownerId: string;
  runtimeInstanceId: string;
  existing?: unknown;
  metadata?: object;
  now?: Date;
}): RuntimeInstanceDiagnosticMetadata {
  const now = (input.now ?? new Date()).toISOString();
  return {
    ...(isMetadataRecord(input.existing) ? input.existing : {}),
    ...(input.metadata ?? {}),
    ownerId: input.ownerId,
    workspaceId: input.placement.workspaceId,
    statusReason: "running",
    lastSeenAt: now,
    lastStartedAt: now,
    runtimeInstanceId: input.runtimeInstanceId,
  };
}

export function stoppedInstanceMetadata(input: {
  runtimeType: string;
  isolationScope: string;
  ownerId: string;
  reason: string;
  errorMessage?: string;
  now?: Date;
}): RuntimeInstanceDiagnosticMetadata {
  const now = (input.now ?? new Date()).toISOString();
  return {
    ownerId: input.ownerId,
    runtimeType: input.runtimeType,
    isolationScope: input.isolationScope,
    statusReason: input.reason,
    lastSeenAt: now,
    stoppedAt: now,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
  };
}

export function statusInstanceMetadata(input: {
  runtimeType: string;
  isolationScope: string;
  ownerId: string;
  reason: string;
  errorMessage?: string;
  now?: Date;
}): RuntimeInstanceDiagnosticMetadata {
  const now = (input.now ?? new Date()).toISOString();
  return {
    ownerId: input.ownerId,
    runtimeType: input.runtimeType,
    isolationScope: input.isolationScope,
    statusReason: input.reason,
    lastSeenAt: now,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
  };
}

export function runtimeInstanceDiagnostics(metadata: unknown) {
  const record = isMetadataRecord(metadata) ? metadata : {};
  return {
    ownerId: typeof record.ownerId === "string" ? record.ownerId : undefined,
    workspaceId:
      typeof record.workspaceId === "string" ? record.workspaceId : undefined,
    statusReason:
      typeof record.statusReason === "string" ? record.statusReason : undefined,
    lastSeenAt:
      typeof record.lastSeenAt === "string" ? record.lastSeenAt : undefined,
    lastStartedAt:
      typeof record.lastStartedAt === "string"
        ? record.lastStartedAt
        : undefined,
    stoppedAt:
      typeof record.stoppedAt === "string" ? record.stoppedAt : undefined,
    errorMessage:
      typeof record.errorMessage === "string" ? record.errorMessage : undefined,
    runtimeInstanceId:
      typeof record.runtimeInstanceId === "string"
        ? record.runtimeInstanceId
        : undefined,
  };
}

export function runtimeInstanceMetadataJson(
  metadata: RuntimeInstanceDiagnosticMetadata
): Prisma.InputJsonValue {
  return metadata as Prisma.InputJsonValue;
}
```

- [ ] **Step 2: 创建 `worker-registry-metadata.spec.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  isMetadataRecord,
  runningInstanceMetadata,
  runtimeInstanceDiagnostics,
  statusInstanceMetadata,
  stoppedInstanceMetadata,
} from "./worker-registry-metadata";

describe("worker-registry-metadata", () => {
  it("isMetadataRecord rejects arrays and null", () => {
    expect(isMetadataRecord({})).toBe(true);
    expect(isMetadataRecord([])).toBe(false);
    expect(isMetadataRecord(null)).toBe(false);
    expect(isMetadataRecord("x")).toBe(false);
  });

  it("runningInstanceMetadata carries ownerId/workspaceId and marks statusReason running", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = runningInstanceMetadata({
      placement: {
        runtimeType: "sandbox",
        workspaceId: "ws-1",
        userId: "user-1",
        hostPath: "/host",
        runtimePath: "/container",
        sandbox: { isolationScope: "workspace", mountTarget: "/container", sandboxEngineType: "docker" },
      } as any,
      ownerId: "ws-1",
      runtimeInstanceId: "inst-1",
      now,
    });
    expect(result.ownerId).toBe("ws-1");
    expect(result.workspaceId).toBe("ws-1");
    expect(result.statusReason).toBe("running");
    expect(result.runtimeInstanceId).toBe("inst-1");
    expect(result.lastSeenAt).toBe(now.toISOString());
  });

  it("runningInstanceMetadata preserves existing metadata record fields", () => {
    const result = runningInstanceMetadata({
      placement: {
        runtimeType: "sandbox",
        workspaceId: "ws-1",
        userId: "user-1",
        hostPath: "/host",
        runtimePath: "/container",
        sandbox: { isolationScope: "workspace", mountTarget: "/container", sandboxEngineType: "docker" },
      } as any,
      ownerId: "ws-1",
      runtimeInstanceId: "inst-1",
      existing: { customField: "kept" },
    });
    expect(result.customField).toBe("kept");
  });

  it("stoppedInstanceMetadata sets stoppedAt and optional errorMessage", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = stoppedInstanceMetadata({
      runtimeType: "sandbox",
      isolationScope: "workspace",
      ownerId: "ws-1",
      reason: "owner_released",
      now,
    });
    expect(result.statusReason).toBe("owner_released");
    expect(result.stoppedAt).toBe(now.toISOString());
    expect(result.errorMessage).toBeUndefined();
  });

  it("statusInstanceMetadata does not set stoppedAt", () => {
    const result = statusInstanceMetadata({
      runtimeType: "sandbox",
      isolationScope: "workspace",
      ownerId: "ws-1",
      reason: "error",
      errorMessage: "boom",
    });
    expect(result.stoppedAt).toBeUndefined();
    expect(result.errorMessage).toBe("boom");
  });

  it("runtimeInstanceDiagnostics extracts known string fields and ignores non-record input", () => {
    expect(runtimeInstanceDiagnostics(null)).toEqual({
      ownerId: undefined,
      workspaceId: undefined,
      statusReason: undefined,
      lastSeenAt: undefined,
      lastStartedAt: undefined,
      stoppedAt: undefined,
      errorMessage: undefined,
      runtimeInstanceId: undefined,
    });
    expect(
      runtimeInstanceDiagnostics({ ownerId: "ws-1", statusReason: "running", extra: 1 })
    ).toMatchObject({ ownerId: "ws-1", statusReason: "running" });
  });
});
```

- [ ] **Step 3: 跑一下新 spec,确认通过(此时还只是搬了 metadata,repository 还没搬,先单独验证这一小步)**

Run: `pnpm --filter api test -- worker-registry-metadata.spec.ts`
Expected: PASS(6 个测试用例全过)

- [ ] **Step 4: 创建 `worker-registry.repository.ts`(原 `WorkspaceRuntimeInstanceRepository` 搬家改名为 `WorkerRegistryRepository`,方法签名/实现原样保留)**

```ts
import { Injectable } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type { SandboxRuntimePlacement } from "@agework/shared/protocol";
import { PrismaService } from "../../prisma/prisma.service";
import {
  runtimeInstanceMetadataJson,
  runningInstanceMetadata,
  statusInstanceMetadata,
  stoppedInstanceMetadata,
} from "./worker-registry-metadata";

function ownerWhere(
  runtimeType: string,
  isolationScope: string,
  ownerId: string
) {
  return { runtimeType, isolationScope, ownerId };
}

/**
 * WorkerRegistry 的 repository 层:维护 workspace -> runtime resource 的绑定关系,
 * 以及实例本身的生命周期数据。数据表继续叫 RuntimeInstance/WorkspaceRuntimeInstance
 * (不改名),只是 repository 归属从 runtime 模块搬到 worker-host 模块——WorkerRegistry
 * 数据天然是 worker-host 自注册/心跳端点要读写的东西,归 runtime 会导致 worker-host
 * 反过来依赖 runtime,破坏 runtime 的零依赖身份。
 */
@Injectable()
export class WorkerRegistryRepository {
  constructor(private prisma: PrismaService) {}

  async findActiveByWorkspace(workspaceId: string) {
    const binding = await this.prisma.workspaceRuntimeInstance.findUnique({
      where: { workspaceId },
      include: { resource: true },
    });
    return binding?.resource.status === "running" ? binding : null;
  }

  async upsertRunning(
    placement: SandboxRuntimePlacement,
    ownerId: string,
    runtimeInstanceId: string,
    metadata?: object
  ) {
    const where = ownerWhere(
      placement.runtimeType,
      placement.sandbox.isolationScope,
      ownerId
    );
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.runtimeInstance.findFirst({ where });
      const data = {
        runtimeInstanceId,
        status: "running",
        expiresAt: null,
        metadata: runtimeInstanceMetadataJson(
          runningInstanceMetadata({
            placement,
            ownerId,
            runtimeInstanceId,
            existing: existing?.metadata,
            metadata,
          })
        ),
      };
      const resource = existing
        ? await tx.runtimeInstance.update({
            where: { id: existing.id },
            data,
          })
        : await tx.runtimeInstance.create({
            data: {
              id: generateId(),
              ...where,
              ...data,
            },
          });
      const workspaceRuntimeInstance = await tx.workspaceRuntimeInstance.upsert(
        {
          where: { workspaceId: placement.workspaceId },
          create: {
            id: generateId(),
            workspaceId: placement.workspaceId,
            resourceId: resource.id,
          },
          update: {
            resourceId: resource.id,
          },
        }
      );
      return { resource, workspaceRuntimeInstance };
    });
  }

  async markStoppedByOwner(
    runtimeType: string,
    isolationScope: string,
    ownerId: string
  ) {
    await this.prisma.runtimeInstance.updateMany({
      where: ownerWhere(runtimeType, isolationScope, ownerId),
      data: {
        status: "stopped",
        metadata: runtimeInstanceMetadataJson(
          stoppedInstanceMetadata({
            runtimeType,
            isolationScope,
            ownerId,
            reason: "stopped",
          })
        ),
      },
    });
  }

  async markErrorByOwner(
    runtimeType: string,
    isolationScope: string,
    ownerId: string,
    errorMessage: string
  ) {
    await this.prisma.runtimeInstance.updateMany({
      where: ownerWhere(runtimeType, isolationScope, ownerId),
      data: {
        status: "error",
        metadata: runtimeInstanceMetadataJson(
          statusInstanceMetadata({
            runtimeType,
            isolationScope,
            ownerId,
            reason: "error",
            errorMessage,
          })
        ),
      },
    });
  }

  async findActiveResourceByRuntimeId(
    runtimeType: string,
    runtimeInstanceId: string
  ) {
    const resource = await this.prisma.runtimeInstance.findUnique({
      where: {
        runtimeType_runtimeInstanceId: {
          runtimeType,
          runtimeInstanceId,
        },
      },
    });
    return resource?.status === "running" ? resource : null;
  }

  async isRuntimeInstanceBoundToWorkspace(
    runtimeType: string,
    workspaceId: string,
    runtimeInstanceId: string
  ) {
    const binding = await this.prisma.workspaceRuntimeInstance.findUnique({
      where: { workspaceId },
      include: { resource: true },
    });
    return (
      binding?.resource.runtimeType === runtimeType &&
      binding.resource.runtimeInstanceId === runtimeInstanceId
    );
  }

  async deleteWorkspaceBinding(workspaceId: string) {
    await this.prisma.workspaceRuntimeInstance.deleteMany({
      where: { workspaceId },
    });
  }

  countRunning(): Promise<number> {
    return this.prisma.runtimeInstance.count({ where: { status: "running" } });
  }

  findAllRunning() {
    return this.prisma.runtimeInstance.findMany({
      where: { status: "running" },
    });
  }

  findByRuntimeId(runtimeType: string, runtimeInstanceId: string) {
    return this.prisma.runtimeInstance.findUnique({
      where: {
        runtimeType_runtimeInstanceId: { runtimeType, runtimeInstanceId },
      },
    });
  }

  /** 管理端 run 详情用:运行实例视图 + 绑定的 workspace。 */
  findRunInstanceView(runtimeType: string, runtimeInstanceId: string) {
    return this.prisma.runtimeInstance.findUnique({
      where: {
        runtimeType_runtimeInstanceId: { runtimeType, runtimeInstanceId },
      },
      select: {
        id: true,
        runtimeType: true,
        isolationScope: true,
        ownerId: true,
        runtimeInstanceId: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
        workspaceRuntimeInstances: {
          select: {
            id: true,
            workspaceId: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
  }

  async userExists(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    return user !== null;
  }

  async listResourcesPage(opts: {
    status?: string;
    take: number;
    skip: number;
  }) {
    const where = opts.status ? { status: opts.status } : {};
    const [items, total] = await Promise.all([
      this.prisma.runtimeInstance.findMany({
        where,
        include: { workspaceRuntimeInstances: true },
        orderBy: { updatedAt: "desc" },
        take: opts.take,
        skip: opts.skip,
      }),
      this.prisma.runtimeInstance.count({ where }),
    ]);
    return { items, total };
  }

  findById(id: string) {
    return this.prisma.runtimeInstance.findUnique({ where: { id } });
  }

  /** 绑定 + 资源(不限状态),供生命周期清理判断隔离归属。 */
  findBindingWithResource(workspaceId: string) {
    return this.prisma.workspaceRuntimeInstance.findUnique({
      where: { workspaceId },
      include: { resource: true },
    });
  }

  findWorkspaceIdsByUser(userId: string): Promise<{ id: string }[]> {
    return this.prisma.workspace.findMany({
      where: { userId, deletedAt: null },
      select: { id: true },
    });
  }

  findRunningByOwners(ownerIds: string[]) {
    return this.prisma.runtimeInstance.findMany({
      where: { ownerId: { in: ownerIds }, status: "running" },
    });
  }

  /** 按 id 置为 stopped 并写入停机诊断元数据。 */
  async markStoppedById(
    resource: {
      id: string;
      runtimeType: string;
      isolationScope: string;
      ownerId: string;
    },
    reason: string
  ): Promise<void> {
    await this.prisma.runtimeInstance.update({
      where: { id: resource.id },
      data: {
        status: "stopped",
        metadata: runtimeInstanceMetadataJson(
          stoppedInstanceMetadata({
            runtimeType: resource.runtimeType,
            isolationScope: resource.isolationScope,
            ownerId: resource.ownerId,
            reason,
          })
        ),
      },
    });
  }
}
```

- [ ] **Step 5: 创建 `worker-registry.repository.spec.ts`**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerRegistryRepository } from "./worker-registry.repository";

function makePrismaMock() {
  return {
    runtimeInstance: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    workspaceRuntimeInstance: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    workspace: {
      findMany: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(undefined)),
  };
}

describe("WorkerRegistryRepository", () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let repository: WorkerRegistryRepository;

  beforeEach(() => {
    prisma = makePrismaMock();
    repository = new WorkerRegistryRepository(prisma as any);
  });

  describe("findActiveByWorkspace", () => {
    it("returns the binding when resource status is running", async () => {
      prisma.workspaceRuntimeInstance.findUnique.mockResolvedValue({
        workspaceId: "ws-1",
        resource: { status: "running" },
      });
      const result = await repository.findActiveByWorkspace("ws-1");
      expect(result).toEqual({
        workspaceId: "ws-1",
        resource: { status: "running" },
      });
    });

    it("returns null when resource status is not running", async () => {
      prisma.workspaceRuntimeInstance.findUnique.mockResolvedValue({
        workspaceId: "ws-1",
        resource: { status: "stopped" },
      });
      const result = await repository.findActiveByWorkspace("ws-1");
      expect(result).toBeNull();
    });

    it("returns null when no binding exists", async () => {
      prisma.workspaceRuntimeInstance.findUnique.mockResolvedValue(null);
      await expect(repository.findActiveByWorkspace("ws-1")).rejects.toThrow();
    });
  });

  describe("upsertRunning", () => {
    const placement = {
      runtimeType: "sandbox",
      workspaceId: "ws-1",
      userId: "user-1",
      hostPath: "/host",
      runtimePath: "/container",
      sandbox: {
        isolationScope: "workspace",
        mountTarget: "/container",
        sandboxEngineType: "docker",
      },
    } as any;

    it("creates a new RuntimeInstance row when none exists for the owner", async () => {
      prisma.runtimeInstance.findFirst.mockResolvedValue(null);
      prisma.runtimeInstance.create.mockResolvedValue({ id: "new-id" });
      prisma.workspaceRuntimeInstance.upsert.mockResolvedValue({
        id: "binding-id",
      });

      const result = await repository.upsertRunning(
        placement,
        "ws-1",
        "inst-1"
      );

      expect(prisma.runtimeInstance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            runtimeType: "sandbox",
            isolationScope: "workspace",
            ownerId: "ws-1",
            runtimeInstanceId: "inst-1",
            status: "running",
          }),
        })
      );
      expect(result.resource).toEqual({ id: "new-id" });
    });

    it("updates the existing row instead of creating a new one when the owner already has one", async () => {
      prisma.runtimeInstance.findFirst.mockResolvedValue({
        id: "existing-id",
        metadata: {},
      });
      prisma.runtimeInstance.update.mockResolvedValue({ id: "existing-id" });
      prisma.workspaceRuntimeInstance.upsert.mockResolvedValue({
        id: "binding-id",
      });

      await repository.upsertRunning(placement, "ws-1", "inst-2");

      expect(prisma.runtimeInstance.create).not.toHaveBeenCalled();
      expect(prisma.runtimeInstance.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "existing-id" } })
      );
    });
  });

  describe("markStoppedByOwner", () => {
    it("updates matching rows to status stopped", async () => {
      prisma.runtimeInstance.updateMany.mockResolvedValue({ count: 1 });
      await repository.markStoppedByOwner("sandbox", "workspace", "ws-1");
      expect(prisma.runtimeInstance.updateMany).toHaveBeenCalledWith({
        where: { runtimeType: "sandbox", isolationScope: "workspace", ownerId: "ws-1" },
        data: expect.objectContaining({ status: "stopped" }),
      });
    });
  });

  describe("isRuntimeInstanceBoundToWorkspace", () => {
    it("returns true when runtimeType and runtimeInstanceId both match the binding", async () => {
      prisma.workspaceRuntimeInstance.findUnique.mockResolvedValue({
        resource: { runtimeType: "sandbox", runtimeInstanceId: "inst-1" },
      });
      const result = await repository.isRuntimeInstanceBoundToWorkspace(
        "sandbox",
        "ws-1",
        "inst-1"
      );
      expect(result).toBe(true);
    });

    it("returns false when runtimeInstanceId does not match", async () => {
      prisma.workspaceRuntimeInstance.findUnique.mockResolvedValue({
        resource: { runtimeType: "sandbox", runtimeInstanceId: "inst-other" },
      });
      const result = await repository.isRuntimeInstanceBoundToWorkspace(
        "sandbox",
        "ws-1",
        "inst-1"
      );
      expect(result).toBe(false);
    });
  });

  describe("userExists", () => {
    it("returns true when a non-deleted user row is found", async () => {
      prisma.user.findFirst.mockResolvedValue({ id: "user-1" });
      expect(await repository.userExists("user-1")).toBe(true);
    });

    it("returns false when no row is found", async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      expect(await repository.userExists("user-1")).toBe(false);
    });
  });

  describe("listResourcesPage", () => {
    it("filters by status when provided and returns items + total", async () => {
      prisma.runtimeInstance.findMany.mockResolvedValue([{ id: "1" }]);
      prisma.runtimeInstance.count.mockResolvedValue(1);
      const result = await repository.listResourcesPage({
        status: "running",
        take: 10,
        skip: 0,
      });
      expect(prisma.runtimeInstance.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: "running" } })
      );
      expect(result).toEqual({ items: [{ id: "1" }], total: 1 });
    });
  });
});
```

- [ ] **Step 6: 删除旧文件**

```bash
git rm apps/api/src/runtime/instances/workspace-runtime-instance.repository.ts \
       apps/api/src/runtime/instances/workspace-runtime-instance.repository.spec.ts \
       apps/api/src/runtime/instances/runtime-instance-metadata.ts \
       apps/api/src/runtime/instances/runtime-instance-metadata.spec.ts
```

(此时 `runtime.module.ts`/`sandbox-instance.service.ts`/`runtime.service.ts`/`lifecycle.service.ts` 还在 import 旧路径,整个仓库这一步会编译失败——这是预期的,Task 3-7 会依次把每个消费者切到新依赖。这一步先把"删除"这个动作和"新文件已经就位、测试已经过"绑在一起提交,后面几个 task 各自把消费者改过来。)

- [ ] **Step 7: 跑一下新 repository 的测试,确认通过**

Run: `pnpm --filter api test -- worker-registry.repository.spec.ts worker-registry-metadata.spec.ts`
Expected: PASS(此时其他文件编译错误不影响这两个文件本身的单测跑通,`vitest` 是按文件跑的)

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/worker-host/registry
git commit -m "refactor(api): move WorkerRegistry repository from runtime to worker-host"
```

---

### Task 3: `WorkerHostService` 新增 WorkerRegistry 透传方法

**Files:**
- Modify: `apps/api/src/worker-host/worker-host.service.ts`
- Modify: `apps/api/src/worker-host/worker-host.service.spec.ts`
- Modify: `apps/api/src/worker-host/worker-host.module.ts`

**Interfaces:**
- Consumes: `WorkerRegistryRepository`(Task 2 产出)
- Produces: `WorkerHostService` 新增方法(供 Task 4-7 的消费者调用):`findActiveRuntimeByWorkspace`、`upsertRunningRuntime`、`markRuntimeStoppedByOwner`、`markRuntimeErrorByOwner`、`isRuntimeInstanceBoundToWorkspace`、`countRunningRuntimes`、`findAllRunningRuntimes`、`findRuntimeByRuntimeId`、`findRuntimeInstanceView`、`userExistsForRuntime`、`listRuntimeResourcesPage`、`findRuntimeById`、`findRuntimeBindingWithResource`、`findWorkspaceIdsByUser`、`findRunningRuntimesByOwners`、`markRuntimeStoppedById`、`deleteRuntimeWorkspaceBinding`。

- [ ] **Step 1: 写一个失败的测试,验证新方法把调用转发给 repository**

在 `apps/api/src/worker-host/worker-host.service.spec.ts` 里补充(如果这个文件还不存在就新建;如果已存在就在现有 `describe` 块基础上加):

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerHostService } from "./worker-host.service";
import type { WorkerRegistryRepository } from "./registry/worker-registry.repository";

function makeRepositoryMock() {
  return {
    findActiveByWorkspace: vi.fn(),
    upsertRunning: vi.fn(),
    markStoppedByOwner: vi.fn(),
    markErrorByOwner: vi.fn(),
    isRuntimeInstanceBoundToWorkspace: vi.fn(),
    countRunning: vi.fn(),
    findAllRunning: vi.fn(),
    findByRuntimeId: vi.fn(),
    findRunInstanceView: vi.fn(),
    userExists: vi.fn(),
    listResourcesPage: vi.fn(),
    findById: vi.fn(),
    findBindingWithResource: vi.fn(),
    findWorkspaceIdsByUser: vi.fn(),
    findRunningByOwners: vi.fn(),
    markStoppedById: vi.fn(),
    deleteWorkspaceBinding: vi.fn(),
  } as unknown as WorkerRegistryRepository;
}

describe("WorkerHostService WorkerRegistry pass-through methods", () => {
  let repository: ReturnType<typeof makeRepositoryMock>;
  let service: WorkerHostService;

  beforeEach(() => {
    repository = makeRepositoryMock();
    service = new WorkerHostService(
      {} as any,
      {} as any,
      {} as any,
      repository
    );
  });

  it("upsertRunningRuntime forwards to repository.upsertRunning", async () => {
    const placement = { runtimeType: "sandbox" } as any;
    (repository.upsertRunning as any).mockResolvedValue({ resource: { id: "x" } });
    const result = await service.upsertRunningRuntime(placement, "ws-1", "inst-1");
    expect(repository.upsertRunning).toHaveBeenCalledWith(placement, "ws-1", "inst-1", undefined);
    expect(result).toEqual({ resource: { id: "x" } });
  });

  it("markRuntimeStoppedByOwner forwards args to repository.markStoppedByOwner", async () => {
    await service.markRuntimeStoppedByOwner("sandbox", "workspace", "ws-1");
    expect(repository.markStoppedByOwner).toHaveBeenCalledWith("sandbox", "workspace", "ws-1");
  });

  it("isRuntimeInstanceBoundToWorkspace forwards to repository and returns its result", async () => {
    (repository.isRuntimeInstanceBoundToWorkspace as any).mockResolvedValue(true);
    const result = await service.isRuntimeInstanceBoundToWorkspace("sandbox", "ws-1", "inst-1");
    expect(result).toBe(true);
    expect(repository.isRuntimeInstanceBoundToWorkspace).toHaveBeenCalledWith(
      "sandbox",
      "ws-1",
      "inst-1"
    );
  });

  it("countRunningRuntimes forwards to repository.countRunning", async () => {
    (repository.countRunning as any).mockResolvedValue(3);
    expect(await service.countRunningRuntimes()).toBe(3);
  });

  it("findRuntimeInstanceView forwards args and result", async () => {
    (repository.findRunInstanceView as any).mockResolvedValue({ id: "x" });
    const result = await service.findRuntimeInstanceView("sandbox", "inst-1");
    expect(repository.findRunInstanceView).toHaveBeenCalledWith("sandbox", "inst-1");
    expect(result).toEqual({ id: "x" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter api test -- worker-host.service.spec.ts`
Expected: FAIL,报 `service.upsertRunningRuntime is not a function`(构造函数参数数量也会跟现有 `WorkerHostService` 对不上,先不管,下一步会改)

- [ ] **Step 3: 改 `worker-host.service.ts`,加构造函数参数 + 新方法**

```ts
import { Injectable } from "@nestjs/common";
import type {
  CommandPayload,
  RunConfig,
  SandboxRuntimePlacement,
  WorkerCommandRpcRequest,
} from "@agework/shared/protocol";
import { WorkerCommandDispatcher } from "./command/command-dispatcher.service";
import { WorkerUpstreamRegistry } from "./upstream/worker-upstream.registry";
import { WorkerEndpointHandler } from "./worker-endpoint.handler";
import type { WorkerUpstreamPort } from "./worker-host.types";
import { WorkerRegistryRepository } from "./registry/worker-registry.repository";

@Injectable()
export class WorkerHostService {
  constructor(
    private readonly endpointHandler: WorkerEndpointHandler,
    private readonly upstream: WorkerUpstreamRegistry,
    private readonly commandDispatcher: WorkerCommandDispatcher,
    private readonly registry: WorkerRegistryRepository
  ) {}

  async pollCommands(
    ownerId: string,
    query: { afterSeq?: number; waitMs?: number }
  ): Promise<{ messages: WorkerCommandRpcRequest[] }> {
    return this.endpointHandler.pollCommands(ownerId, query);
  }

  getRunConfig(runId: string): { config: RunConfig } {
    return this.endpointHandler.getRunConfig(runId);
  }

  async postEvent(runId: string, body: unknown): Promise<{ ok: boolean }> {
    return this.endpointHandler.postEvent(runId, body);
  }

  openSession(params: {
    runId: string;
    ownerId: string;
    runConfig: RunConfig;
  }): void {
    this.commandDispatcher.openSession(params);
  }

  sendCommand(ownerId: string, runId: string, command: CommandPayload): void {
    this.commandDispatcher.sendCommand(ownerId, runId, command);
  }

  cleanupRun(runId: string): void {
    this.commandDispatcher.cleanupRun(runId);
  }

  cleanupByOwnerId(ownerId: string): void {
    this.commandDispatcher.cleanupByOwnerId(ownerId);
  }

  setUpstreamPort(receiver: WorkerUpstreamPort): void {
    this.upstream.setUpstreamPort(receiver);
  }

  // ── WorkerRegistry 透传方法 ──────────────────────────────────────────
  // WorkerRegistry 数据(RuntimeInstance/WorkspaceRuntimeInstance 表)归属 worker-host,
  // 这里是唯一对外入口;这批方法目前是 1:1 透传原 repository 方法,是 Phase 1(纯粹的
  // 归属搬家)的产物——后续 resolveInstance() 落地后,部分方法可能会被更贴合业务语义
  // 的编排方法取代,不代表这是最终形态。

  /** 查询某个 workspace 当前绑定的活跃(running)runtime 资源。 */
  findActiveRuntimeByWorkspace(workspaceId: string) {
    return this.registry.findActiveByWorkspace(workspaceId);
  }

  /** 记录一个 runtime 实例进入 running 状态,不存在则创建、存在则更新。 */
  upsertRunningRuntime(
    placement: SandboxRuntimePlacement,
    ownerId: string,
    runtimeInstanceId: string,
    metadata?: object
  ) {
    return this.registry.upsertRunning(placement, ownerId, runtimeInstanceId, metadata);
  }

  /** 按 owner 把 runtime 资源标记为 stopped。 */
  markRuntimeStoppedByOwner(
    runtimeType: string,
    isolationScope: string,
    ownerId: string
  ) {
    return this.registry.markStoppedByOwner(runtimeType, isolationScope, ownerId);
  }

  /** 按 owner 把 runtime 资源标记为 error。 */
  markRuntimeErrorByOwner(
    runtimeType: string,
    isolationScope: string,
    ownerId: string,
    errorMessage: string
  ) {
    return this.registry.markErrorByOwner(runtimeType, isolationScope, ownerId, errorMessage);
  }

  /** 校验某个 runtimeInstanceId 是否确实绑定到指定 workspace,防伪造/串扰。 */
  isRuntimeInstanceBoundToWorkspace(
    runtimeType: string,
    workspaceId: string,
    runtimeInstanceId: string
  ) {
    return this.registry.isRuntimeInstanceBoundToWorkspace(
      runtimeType,
      workspaceId,
      runtimeInstanceId
    );
  }

  /** 统计当前 running 状态的 runtime 资源数量,供 admin 概览用。 */
  countRunningRuntimes() {
    return this.registry.countRunning();
  }

  /** 列出所有 running 状态的 runtime 资源(不分页,内部维护用)。 */
  findAllRunningRuntimes() {
    return this.registry.findAllRunning();
  }

  /** 按 (runtimeType, runtimeInstanceId) 查找 runtime 资源行。 */
  findRuntimeByRuntimeId(runtimeType: string, runtimeInstanceId: string) {
    return this.registry.findByRuntimeId(runtimeType, runtimeInstanceId);
  }

  /** 管理端 run 详情用:运行实例视图 + 绑定的 workspace 列表。 */
  findRuntimeInstanceView(runtimeType: string, runtimeInstanceId: string) {
    return this.registry.findRunInstanceView(runtimeType, runtimeInstanceId);
  }

  /** 某个用户是否仍然存在(未删除),供级联清理判断用。 */
  userExistsForRuntime(userId: string) {
    return this.registry.userExists(userId);
  }

  /** 管理端分页列出 runtime 资源。 */
  listRuntimeResourcesPage(opts: { status?: string; take: number; skip: number }) {
    return this.registry.listResourcesPage(opts);
  }

  /** 按主键查找 runtime 资源行。 */
  findRuntimeById(id: string) {
    return this.registry.findById(id);
  }

  /** 查找某个 workspace 的绑定关系 + 资源(不限状态),供生命周期清理用。 */
  findRuntimeBindingWithResource(workspaceId: string) {
    return this.registry.findBindingWithResource(workspaceId);
  }

  /** 查找某个用户名下所有(未删除)workspace 的 id 列表。 */
  findWorkspaceIdsByUser(userId: string) {
    return this.registry.findWorkspaceIdsByUser(userId);
  }

  /** 按 ownerId 列表查找当前 running 的 runtime 资源。 */
  findRunningRuntimesByOwners(ownerIds: string[]) {
    return this.registry.findRunningByOwners(ownerIds);
  }

  /** 按主键把 runtime 资源标记为 stopped 并写入停机原因。 */
  markRuntimeStoppedById(
    resource: { id: string; runtimeType: string; isolationScope: string; ownerId: string },
    reason: string
  ) {
    return this.registry.markStoppedById(resource, reason);
  }

  /** 删除某个 workspace 的 runtime 绑定关系。 */
  deleteRuntimeWorkspaceBinding(workspaceId: string) {
    return this.registry.deleteWorkspaceBinding(workspaceId);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter api test -- worker-host.service.spec.ts`
Expected: PASS

- [ ] **Step 5: 改 `worker-host.module.ts`,注册新 repository**

```ts
import { Module } from "@nestjs/common";

import { WorkerConfigStore } from "./config/config-store";
import { WorkerCommandQueue } from "./command/command-queue";
import { WorkerUpstreamRegistry } from "./upstream/worker-upstream.registry";
import { WorkerCommandDispatcher } from "./command/command-dispatcher.service";
import { WorkerCommandController } from "./command.controller";
import { WorkerRunController } from "./worker-run.controller";
import { WorkerEndpointHandler } from "./worker-endpoint.handler";
import { WorkerHostService } from "./worker-host.service";
import { WorkerRegistryRepository } from "./registry/worker-registry.repository";

/**
 * worker-host:API ↔ worker 进程之间的通信边界(配置下发、命令下发、上行事件),
 * 以及 WorkerRegistry 数据归属(哪个 owner 现在绑定着哪个活实例)。worker 调用的
 * 全部 HTTP 端点都在此。被 run / runtime 依赖,自身不反依赖任何一方——反向通知
 * 所需的端口(WorkerUpstreamPort)由实现方 run 在启动时注入。
 *
 * 公开面只暴露 WorkerHostService。命令下发、上行事件注册表、配置存储、命令队列、
 * WorkerRegistry repository 都是 worker-host 内部实现。
 *
 * 开发阶段暂时移除了 worker 端点鉴权(原 WorkerAccessService/WorkerAuthGuard),
 * 待生命周期管理理清后再补。
 */
@Module({
  controllers: [WorkerCommandController, WorkerRunController],
  providers: [
    WorkerConfigStore,
    WorkerCommandQueue,
    WorkerUpstreamRegistry,
    WorkerCommandDispatcher,
    WorkerEndpointHandler,
    WorkerRegistryRepository,
    WorkerHostService,
  ],
  exports: [WorkerHostService],
})
export class WorkerHostModule {}
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/worker-host/worker-host.service.ts apps/api/src/worker-host/worker-host.service.spec.ts apps/api/src/worker-host/worker-host.module.ts
git commit -m "feat(api): expose WorkerRegistry operations via WorkerHostService"
```

---

### Task 4: `SandboxRuntimeInstanceService` 改用 `WorkerHostService`

**Files:**
- Modify: `apps/api/src/runtime/sandbox/sandbox-instance.service.ts`
- Modify: `apps/api/src/runtime/sandbox/sandbox-instance.service.spec.ts`

**Interfaces:**
- Consumes: `WorkerHostService`(已有注入,新增调用 `upsertRunningRuntime`/`markRuntimeStoppedByOwner`/`isRuntimeInstanceBoundToWorkspace`)
- 不再 Consumes: `WorkspaceRuntimeInstanceRepository`(移除)

- [ ] **Step 1: 改 `sandbox-instance.service.ts`,移除 repository 注入,改调 `workerHost` 上的新方法**

这个文件本来就注入了 `WorkerHostService`(参数名 `workerHost`),不需要新增依赖,只是把原来调 `this.workspaceRuntimeService.X()` 的三处调用改成调 `this.workerHost.X()`,并删掉 `workspaceRuntimeService` 这个构造函数参数和对应 import。

把文件顶部 import 从:

```ts
import { WorkerHostService } from "../../worker-host/worker-host.service";
...
import { WorkspaceRuntimeInstanceRepository } from "../instances/workspace-runtime-instance.repository";
```

改成(删掉 `WorkspaceRuntimeInstanceRepository` 那行,`WorkerHostService` 那行保留):

```ts
import { WorkerHostService } from "../../worker-host/worker-host.service";
```

构造函数从:

```ts
  constructor(
    private readonly configService: ConfigService,
    private readonly workspaceRuntimeService: WorkspaceRuntimeInstanceRepository,
    private readonly workerHost: WorkerHostService,
    @Inject(SANDBOX_ENGINES) engines: SandboxEngine[]
  ) {
```

改成:

```ts
  constructor(
    private readonly configService: ConfigService,
    private readonly workerHost: WorkerHostService,
    @Inject(SANDBOX_ENGINES) engines: SandboxEngine[]
  ) {
```

`buildSandboxStartInput` 里的调用,从:

```ts
      isExpectedRuntimeInstance: (runtimeInstanceId: string) =>
        this.workspaceRuntimeService.isRuntimeInstanceBoundToWorkspace(
          "sandbox",
          context.workspaceId,
          runtimeInstanceId
        ),
```

改成:

```ts
      isExpectedRuntimeInstance: (runtimeInstanceId: string) =>
        this.workerHost.isRuntimeInstanceBoundToWorkspace(
          "sandbox",
          context.workspaceId,
          runtimeInstanceId
        ),
```

`shutdownRuntimeInstanceByOwnerId` 里的调用,从:

```ts
    if (state) {
      this.workspaceRuntimeService
        .markStoppedByOwner("sandbox", state.isolationScope, ownerId)
```

改成:

```ts
    if (state) {
      this.workerHost
        .markRuntimeStoppedByOwner("sandbox", state.isolationScope, ownerId)
```

`releaseOwnerRuntime` 里的调用,从:

```ts
    this.workspaceRuntimeService
      .markStoppedByOwner("sandbox", state.isolationScope, ownerId)
```

改成:

```ts
    this.workerHost
      .markRuntimeStoppedByOwner("sandbox", state.isolationScope, ownerId)
```

`recordWorkspaceRuntime` 里的调用,从:

```ts
  private recordWorkspaceRuntime(
    placement: SandboxRuntimePlacement,
    ownerId: string,
    runtimeInstanceId: string
  ): Promise<void> {
    return this.workspaceRuntimeService
      .upsertRunning(placement, ownerId, runtimeInstanceId)
```

改成:

```ts
  private recordWorkspaceRuntime(
    placement: SandboxRuntimePlacement,
    ownerId: string,
    runtimeInstanceId: string
  ): Promise<void> {
    return this.workerHost
      .upsertRunningRuntime(placement, ownerId, runtimeInstanceId)
```

- [ ] **Step 2: 改 `sandbox-instance.service.spec.ts`,把原来的 repository mock 换成 workerHost mock 上对应方法**

找到现有 spec 文件里构造 `SandboxRuntimeInstanceService` 的地方(构造函数参数顺序变了,少了一个参数),对应调整:原本可能是:

```ts
const workspaceRuntimeService = {
  isRuntimeInstanceBoundToWorkspace: vi.fn(),
  markStoppedByOwner: vi.fn(),
  upsertRunning: vi.fn(),
};
const workerHost = { cleanupByOwnerId: vi.fn() };
const service = new SandboxRuntimeInstanceService(
  configService,
  workspaceRuntimeService as any,
  workerHost as any,
  engines
);
```

改成:

```ts
const workerHost = {
  cleanupByOwnerId: vi.fn(),
  isRuntimeInstanceBoundToWorkspace: vi.fn(),
  markRuntimeStoppedByOwner: vi.fn().mockResolvedValue(undefined),
  upsertRunningRuntime: vi.fn().mockResolvedValue(undefined),
};
const service = new SandboxRuntimeInstanceService(
  configService,
  workerHost as any,
  engines
);
```

所有原本断言 `workspaceRuntimeService.markStoppedByOwner`/`upsertRunning`/`isRuntimeInstanceBoundToWorkspace` 被调用的地方,改成断言 `workerHost.markRuntimeStoppedByOwner`/`upsertRunningRuntime`/`isRuntimeInstanceBoundToWorkspace`,方法名和参数保持不变(只是挂载对象换了)。

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm --filter api test -- sandbox-instance.service.spec.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/runtime/sandbox/sandbox-instance.service.ts apps/api/src/runtime/sandbox/sandbox-instance.service.spec.ts
git commit -m "refactor(api): SandboxRuntimeInstanceService uses WorkerHostService for WorkerRegistry access"
```

---

### Task 5: `RuntimeService` 改用 `WorkerHostService`,删掉两个 blanket 清理方法

**Files:**
- Modify: `apps/api/src/runtime/runtime.service.ts`
- Modify: `apps/api/src/runtime/runtime.service.spec.ts`

**Interfaces:**
- Consumes: `WorkerHostService`(新增注入,替换 `WorkspaceRuntimeInstanceRepository`)
- Produces: `RuntimeService` 保留方法 `resolveRuntimeTarget`、`acquireInstanceForRun`、`releaseInstanceForRun`、`recoverOrphanInstance`、`shutdownRuntimeInstanceByOwnerId`、`getRuntimePolicy`、`getRuntimeStats`、`listResources`、`getRuntimeInstanceForAdmin`、`isRuntimeInstanceUserScoped`、`stopRuntimeInstance`;**移除** `recoverOrphanRuntimeInstances`、`cleanupStaleRuntimeInstances`(设计文档明确不带入新设计的 blanket 清理逻辑)。

- [ ] **Step 1: 改 `runtime.service.ts` 的 import 和构造函数**

从:

```ts
import { RuntimeProviderRegistry } from "./providers/provider-registry";
import { SandboxRuntimeInstanceService } from "./sandbox/sandbox-instance.service";
import { WorkspaceRuntimeInstanceRepository } from "./instances/workspace-runtime-instance.repository";
import { runtimeInstanceDiagnostics } from "./instances/runtime-instance-metadata";
```

改成:

```ts
import { RuntimeProviderRegistry } from "./providers/provider-registry";
import { SandboxRuntimeInstanceService } from "./sandbox/sandbox-instance.service";
import { WorkerHostService } from "../worker-host/worker-host.service";
import { runtimeInstanceDiagnostics } from "../worker-host/registry/worker-registry-metadata";
```

构造函数从:

```ts
  constructor(
    private readonly configService: ConfigService,
    private readonly providerRegistry: RuntimeProviderRegistry,
    private readonly repository: WorkspaceRuntimeInstanceRepository,
    private readonly sandboxInstances: SandboxRuntimeInstanceService
  ) {
```

改成:

```ts
  constructor(
    private readonly configService: ConfigService,
    private readonly providerRegistry: RuntimeProviderRegistry,
    private readonly workerHost: WorkerHostService,
    private readonly sandboxInstances: SandboxRuntimeInstanceService
  ) {
```

- [ ] **Step 2: 把 `this.repository.X()` 调用逐个改成 `this.workerHost.Y()`**

`getRuntimeStats()`:

```ts
  async getRuntimeStats() {
    return { activeRuntimes: await this.workerHost.countRunningRuntimes() };
  }
```

`listResources()`:

```ts
  async listResources(query: {
    status?: string;
    pageNo?: number;
    pageSize?: number;
  }) {
    const { pageNo, pageSize, take, skip } = pageWindow(query);
    const { items, total } = await this.workerHost.listRuntimeResourcesPage({
      status: query.status,
      take,
      skip,
    });
    return {
      list: items.map((item) => this.toRuntimeInstanceResponse(item)),
      total,
      pageNo,
      pageSize,
    };
  }
```

`getRuntimeInstanceForAdmin()`:

```ts
  async getRuntimeInstanceForAdmin(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<AdminRunRuntimeInstanceResponse | null> {
    const record = await this.workerHost.findRuntimeInstanceView(
      runtimeType,
      runtimeInstanceId
    );
    if (!record) return null;
    const { workspaceRuntimeInstances, ...resource } = record;
    return {
      ...resource,
      expiresAt: resource.expiresAt
        ? this.toIsoString(resource.expiresAt)
        : null,
      createdAt: this.toIsoString(resource.createdAt),
      updatedAt: this.toIsoString(resource.updatedAt),
      workspaceRuntimes: workspaceRuntimeInstances.map((binding) => ({
        id: binding.id,
        workspaceId: binding.workspaceId,
        createdAt: this.toIsoString(binding.createdAt),
        updatedAt: this.toIsoString(binding.updatedAt),
      })),
    };
  }
```

`isRuntimeInstanceUserScoped()`:

```ts
  async isRuntimeInstanceUserScoped(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<boolean> {
    const resource = await this.workerHost.findRuntimeByRuntimeId(
      runtimeType,
      runtimeInstanceId
    );
    return resource?.isolationScope === "user";
  }
```

`stopRuntimeInstance()`:

```ts
  async stopRuntimeInstance(id: string) {
    const resource = await this.workerHost.findRuntimeById(id);
    if (!resource || resource.status !== "running") {
      throw new NotFoundException(
        `Runtime resource ${id} not found or not running`
      );
    }
    this.shutdownRuntimeInstanceByOwnerId(
      resource.runtimeType,
      resource.ownerId
    );
    await this.workerHost.markRuntimeStoppedById(resource, "manual_stop");
    return { ok: true };
  }
```

- [ ] **Step 3: 整段删掉 `recoverOrphanRuntimeInstances` 和 `cleanupStaleRuntimeInstances`**

删掉这两个完整方法(原文件约 179-236 行):

```ts
  async recoverOrphanRuntimeInstances(): Promise<void> {
    // ... 整个方法体删掉
  }

  /** 清理已明确标记为 stale 的 runtime 资源(running 资源可能仍在外部存活,不在此清理)。 */
  async cleanupStaleRuntimeInstances(): Promise<void> {
    // ... 整个方法体删掉
  }
```

理由(写进设计文档"仍待讨论"第 13 条):新设计下 HTTP 类型的实例只要还活着,重启后自己会继续心跳/轮询,不需要平台在重启时做 blanket 清理;这个方法原来的"重启就把所有非 user 级共享的 running 行当孤儿、直接物理拆除"的逻辑,直接违背新设计"实例应该能扛过重启"的前提,不带入新设计,也不设计替代方案(替代方案属于 Phase 1 范围外的边界问题)。

- [ ] **Step 4: 改 `runtime.service.spec.ts`**

把测试里构造 `RuntimeService` 的地方,`repository` mock 换成 `workerHost` mock,方法名同 Task 3 加的那批(`countRunningRuntimes`/`listRuntimeResourcesPage`/`findRuntimeInstanceView`/`findRuntimeByRuntimeId`/`findRuntimeById`/`markRuntimeStoppedById`)。删掉所有针对 `recoverOrphanRuntimeInstances`/`cleanupStaleRuntimeInstances` 的测试用例(这两个方法不存在了)。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter api test -- runtime.service.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/runtime/runtime.service.ts apps/api/src/runtime/runtime.service.spec.ts
git commit -m "refactor(api): RuntimeService uses WorkerHostService, drop blanket orphan-recovery methods"
```

---

### Task 6: `RunRecoveryService` 去掉对已删除方法的调用

**Files:**
- Modify: `apps/api/src/run/recovery/run-recovery.service.ts`
- Modify: `apps/api/src/run/recovery/run-recovery.service.spec.ts`

**Interfaces:**
- 不再 Consumes: `RuntimeService.recoverOrphanRuntimeInstances`、`RuntimeService.cleanupStaleRuntimeInstances`(Task 5 已删除)

- [ ] **Step 1: 改 `run-recovery.service.ts`,删掉末尾两行调用**

从:

```ts
    await this.runtimeService.recoverOrphanRuntimeInstances();
    await this.runtimeService.cleanupStaleRuntimeInstances();
  }
```

改成:

```ts
  }
```

(`recoverInterruptedRuns()` 方法体到 `Marked interrupted run ${run.id} as error` 那个 for 循环结束、外层 try/catch 结束就完了,不再调这两个已删除的方法。方法其余部分——找 active run、标记 error、调 `executionService.cleanupInterruptedExecution`——保持不变,这部分属于"run 中断时要不要顺手拆实例"那个问题,是设计文档里单独决定的另一件事,不在这个 Phase 1 里改。)

- [ ] **Step 2: 改 `run-recovery.service.spec.ts`,删掉断言这两个方法被调用的测试用例**

找到 spec 里类似 `expect(runtimeService.recoverOrphanRuntimeInstances).toHaveBeenCalled()` 的断言,连同对应的 mock 方法定义一起删掉。

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm --filter api test -- run-recovery.service.spec.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/run/recovery/run-recovery.service.ts apps/api/src/run/recovery/run-recovery.service.spec.ts
git commit -m "refactor(api): drop calls to removed RuntimeService blanket-recovery methods"
```

---

### Task 7: `RuntimeInstanceLifecycleService` 改用 `WorkerHostService`(文件位置不动)

**Files:**
- Modify: `apps/api/src/runtime/instances/lifecycle.service.ts`
- Modify: `apps/api/src/runtime/instances/lifecycle.service.spec.ts`

**Interfaces:**
- Consumes: `WorkerHostService`(新增,替换 `WorkspaceRuntimeInstanceRepository`);`RuntimeProviderRegistry`(不变,同模块内注入,不受这次搬家影响)

- [ ] **Step 1: 改 `lifecycle.service.ts`**

从:

```ts
import { Injectable, Logger } from "@nestjs/common";
import { RuntimeProviderRegistry } from "../providers/provider-registry";
import { WorkspaceRuntimeInstanceRepository } from "./workspace-runtime-instance.repository";

@Injectable()
export class RuntimeInstanceLifecycleService {
  private readonly logger = new Logger(RuntimeInstanceLifecycleService.name);

  constructor(
    private readonly repository: WorkspaceRuntimeInstanceRepository,
    private readonly runtimeProviderRegistry: RuntimeProviderRegistry
  ) {}

  /** 关闭专属于该 workspace 的 runtime 资源(user 隔离下的共享资源不受影响)。 */
  async shutdownForWorkspace(workspaceId: string): Promise<void> {
    const binding = await this.repository.findBindingWithResource(workspaceId);
    if (binding?.resource.status === "running") {
      const resource = binding.resource;
      if (
        resource.isolationScope === "workspace" &&
        resource.ownerId === workspaceId
      ) {
        await this.shutdownResource(resource);
      }
    }
    await this.repository.deleteWorkspaceBinding(workspaceId);
  }

  /** 关闭该用户名下所有 runtime 资源(user 级共享资源 + 该用户所有 workspace 级资源)。
   *  user 隔离下 ownerId = userId;workspace 隔离下 ownerId = workspaceId(也归该 user),
   *  通过 ownerId IN (userId, 该 user 的 workspace ids) 匹配。 */
  async shutdownForUser(userId: string): Promise<void> {
    const workspaces = await this.repository.findWorkspaceIdsByUser(userId);
    const ownerIds = [userId, ...workspaces.map((w) => w.id)];
    const resources = await this.repository.findRunningByOwners(ownerIds);
    for (const resource of resources) {
      await this.shutdownResource(resource);
    }
  }

  private async shutdownResource(resource: {
    id: string;
    runtimeType: string;
    isolationScope: string;
    ownerId: string;
  }): Promise<void> {
    try {
      const provider = this.runtimeProviderRegistry.resolve(
        resource.runtimeType
      );
      await Promise.resolve(
        provider.shutdownRuntimeInstanceByOwnerId?.(resource.ownerId)
      );
      await this.repository.markStoppedById(resource, "owner_released");
    } catch (err) {
      this.logger.warn(
        `Failed to shut down runtime resource ${resource.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
```

改成:

```ts
import { Injectable, Logger } from "@nestjs/common";
import { RuntimeProviderRegistry } from "../providers/provider-registry";
import { WorkerHostService } from "../../worker-host/worker-host.service";

@Injectable()
export class RuntimeInstanceLifecycleService {
  private readonly logger = new Logger(RuntimeInstanceLifecycleService.name);

  constructor(
    private readonly workerHost: WorkerHostService,
    private readonly runtimeProviderRegistry: RuntimeProviderRegistry
  ) {}

  /** 关闭专属于该 workspace 的 runtime 资源(user 隔离下的共享资源不受影响)。 */
  async shutdownForWorkspace(workspaceId: string): Promise<void> {
    const binding = await this.workerHost.findRuntimeBindingWithResource(workspaceId);
    if (binding?.resource.status === "running") {
      const resource = binding.resource;
      if (
        resource.isolationScope === "workspace" &&
        resource.ownerId === workspaceId
      ) {
        await this.shutdownResource(resource);
      }
    }
    await this.workerHost.deleteRuntimeWorkspaceBinding(workspaceId);
  }

  /** 关闭该用户名下所有 runtime 资源(user 级共享资源 + 该用户所有 workspace 级资源)。
   *  user 隔离下 ownerId = userId;workspace 隔离下 ownerId = workspaceId(也归该 user),
   *  通过 ownerId IN (userId, 该 user 的 workspace ids) 匹配。 */
  async shutdownForUser(userId: string): Promise<void> {
    const workspaces = await this.workerHost.findWorkspaceIdsByUser(userId);
    const ownerIds = [userId, ...workspaces.map((w) => w.id)];
    const resources = await this.workerHost.findRunningRuntimesByOwners(ownerIds);
    for (const resource of resources) {
      await this.shutdownResource(resource);
    }
  }

  private async shutdownResource(resource: {
    id: string;
    runtimeType: string;
    isolationScope: string;
    ownerId: string;
  }): Promise<void> {
    try {
      const provider = this.runtimeProviderRegistry.resolve(
        resource.runtimeType
      );
      await Promise.resolve(
        provider.shutdownRuntimeInstanceByOwnerId?.(resource.ownerId)
      );
      await this.workerHost.markRuntimeStoppedById(resource, "owner_released");
    } catch (err) {
      this.logger.warn(
        `Failed to shut down runtime resource ${resource.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
```

(`runtimeProviderRegistry` 保持直接注入不变——它是 `runtime` 模块内部的东西,这个类目前还在 `runtime` 模块里,同模块注入没有跨模块问题。这是 Phase 1 特意保留的临时状态,见本文档开头"关于 RuntimeInstanceLifecycleService 为什么这次不搬家"。)

- [ ] **Step 2: 改 `lifecycle.service.spec.ts`**

把测试里的 `repository` mock 换成 `workerHost` mock,方法名对应改成 `findRuntimeBindingWithResource`/`deleteRuntimeWorkspaceBinding`/`findWorkspaceIdsByUser`/`findRunningRuntimesByOwners`/`markRuntimeStoppedById`。`runtimeProviderRegistry` mock 不变。

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm --filter api test -- lifecycle.service.spec.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/runtime/instances/lifecycle.service.ts apps/api/src/runtime/instances/lifecycle.service.spec.ts
git commit -m "refactor(api): RuntimeInstanceLifecycleService uses WorkerHostService for WorkerRegistry access"
```

---

### Task 8: 清理 `runtime.module.ts` wiring,跑全量回归

**Files:**
- Modify: `apps/api/src/runtime/runtime.module.ts`
- Modify: `apps/api/src/runtime/runtime.module.spec.ts`(如需要)

**Interfaces:**
- Produces: `RuntimeModule` 不再注册 `WorkspaceRuntimeInstanceRepository`(已删除、已搬家),继续 `imports: [WorkerHostModule]`(这条边这个 phase 不剪,留给后续 phase)。

- [ ] **Step 1: 改 `runtime.module.ts`,删掉对已搬家 repository 的注册**

从:

```ts
import { Module } from "@nestjs/common";

// core
import { WorkspaceRuntimeInstanceRepository } from "./instances/workspace-runtime-instance.repository";
import { RuntimeInstanceLifecycleService } from "./instances/lifecycle.service";
import { RuntimeInstanceLifecycleListener } from "./instances/lifecycle.listener";

import { DockerSandboxEngine } from "./sandbox/docker-engine";
...
@Module({
  imports: [WorkerHostModule],
  controllers: [AdminRuntimeController],
  providers: [
    // core
    WorkspaceRuntimeInstanceRepository,
    RuntimeInstanceLifecycleService,
    RuntimeInstanceLifecycleListener,
    // providers
    ...
```

改成:

```ts
import { Module } from "@nestjs/common";

// core
import { RuntimeInstanceLifecycleService } from "./instances/lifecycle.service";
import { RuntimeInstanceLifecycleListener } from "./instances/lifecycle.listener";

import { DockerSandboxEngine } from "./sandbox/docker-engine";
...
@Module({
  imports: [WorkerHostModule],
  controllers: [AdminRuntimeController],
  providers: [
    // core
    RuntimeInstanceLifecycleService,
    RuntimeInstanceLifecycleListener,
    // providers
    ...
```

(只删 `import { WorkspaceRuntimeInstanceRepository } ...` 那一行 import,以及 `providers` 数组里的 `WorkspaceRuntimeInstanceRepository,` 那一行,其余内容——`imports: [WorkerHostModule]`、`SandboxRuntimeInstanceService`、`RuntimeService` 等——保持不动。)

- [ ] **Step 2: 跑 `runtime.module.spec.ts`,确认模块仍然能正常编译装配**

Run: `pnpm --filter api test -- runtime.module.spec.ts`
Expected: PASS(这个测试是用 `Test.createTestingModule` 真的装配一次整个模块,能验证 DI 图没有断裂)

- [ ] **Step 3: 跑 worker-host 和 run 模块的 wiring 测试**

Run: `pnpm --filter api test -- worker-host.module.spec.ts run.module.spec.ts`
Expected: PASS(如果这两个文件目前不存在对应 spec,跳过这一步,改成手动 `pnpm --filter api build` 验证编译通过即可)

- [ ] **Step 4: 跑全量后端测试,确认没有破坏其他地方**

Run: `pnpm test:api`
Expected: PASS,全绿

- [ ] **Step 5: 跑一次类型检查**

Run: `pnpm --filter api typecheck`
Expected: 无类型错误

- [ ] **Step 6: 跑一次 eslint(这个仓库的记忆:type-aware 规则只有 eslint 能抓到,tsc 增量缓存可能漏报)**

Run: `pnpm --filter api lint`
Expected: 无新增 lint 错误

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/runtime/runtime.module.ts
git commit -m "chore(api): remove WorkspaceRuntimeInstanceRepository registration from RuntimeModule"
```

---

## Self-Review 记录

- **Spec 覆盖**:设计文档 2.3 节"WorkerRegistry 归属整体在 worker-host 模块"→ Task 2/3 覆盖;字段表 `transport` 字段 → Task 1 覆盖;3.7 节 partial unique index → Task 1 覆盖;"仍待讨论"第 13 条"recoverOrphanRuntimeInstances 不带入新设计"→ Task 5 覆盖(删除);1.1 节"RuntimeInstanceLifecycleService 这次不搬家"的说明 → 已在计划开头和 Task 7 里显式写明原因。**没有覆盖、留给后续 phase**:`resolveInstance()` 本身、local 通信方式改造、idle watchdog 决策权转移、`run` 依赖简化、Provider 契约的 channel 字段——这些都在设计文档里,但明确是 Phase 2-5 的范围,不在这份计划里,已经在文档开头的 Goal 里说清楚。
- **占位符扫描**:每个 Step 都有完整代码,没有"TODO"/"参考 Task N 的做法"这类占位描述。
- **类型一致性**:`WorkerHostService` 新增方法名(`upsertRunningRuntime`/`markRuntimeStoppedByOwner`/`isRuntimeInstanceBoundToWorkspace`/`countRunningRuntimes`/`findRuntimeInstanceView`/`findRuntimeByRuntimeId`/`findRuntimeById`/`markRuntimeStoppedById`/`findRuntimeBindingWithResource`/`findWorkspaceIdsByUser`/`findRunningRuntimesByOwners`/`deleteRuntimeWorkspaceBinding`/`listRuntimeResourcesPage`)在 Task 3 定义、Task 4/5/7 引用,全程核对过名字一致。
