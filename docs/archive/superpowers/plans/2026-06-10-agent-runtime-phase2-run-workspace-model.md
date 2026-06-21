# AgeWork Agent 运行基础设施 Phase 2：Run + Workspace 数据模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Prisma 中引入 `Workspace`、`Run` 实体，把 `Project.workdir` 替换为 `Project → Workspace` 关联，并把 `AgentController` 的运行编排从 `Thread.runStatus` + 内存 `activeAgentRuns` Map 切换为 `Run` 实体 + `RunRegistry`（控制面注册表）；本阶段仍是进程内执行，外部行为（聊天 / 停止 / HITL / 项目列表）保持不变。

**Architecture:**
- `Workspace` 是数据实体（`locator` + `status` + `metadata`），`Project.workspaceId` 唯一关联一个 `Workspace`；`WorkspaceService` 负责创建。`ProjectService` 把 `workspace.locator` 映射回响应里的 `workdir` 字段，前端零改动。
- `Run` 实体替代 `Thread.runStatus` 之外的"运行态"信息（`status`/`phase`/`lastSeq`/`lastHeartbeatAt`/`error` 等，对齐设计文档第 7 节，为 Phase 3 worker 上报预留字段）。`RunService` 负责 CRUD，`RunRegistry` 是进程内 `Map<runId, RunHandle>`，替代原来按 `threadId` 索引的 `activeAgentRuns`。
- `AgentController.run()` 在拿到 adapter 后创建 `Run`（`queued` → 立即 `running`，因为本阶段仍是进程内同步启动）、注册 `RunRegistry` 句柄；`finalizeRun` 同步更新 `Run.status` 并注销句柄；`stop` 端点改为查 `RunService.findActiveByThreadId` + `RunRegistry.get`。`Thread.runStatus`/`pendingAction` 字段和对应的 SSE/前端行为保持不变，只是不再是"唯一真相来源"。

**Tech Stack:** NestJS 11 Feature Module、Prisma (SQLite, `db push --force-reset`)、Vitest。

**提交约定**：根据项目记忆，本仓库的 git commit 由用户主动发起，AI 不自动提交。每个任务最后一步只做 `git add` 暂存并给出建议的 commit message，不执行 `git commit`。

**重要提示**：Task 1 会执行 `prisma db push --force-reset`，会清空本地开发数据库 `apps/api/dev.db`（按 `CLAUDE.md`「开发阶段，不需要迁移数据，清空重新生成即可」的约定）。执行前如本地有想保留的测试数据，请先自行备份。

---

### Task 1: Prisma schema — 新增 Workspace、Run，调整 Project

**Files:**
- Modify: `apps/api/prisma/schema.prisma`

- [ ] **Step 1: 编辑 schema，新增 `Workspace` 模型**

在 `model User { ... }` 和 `model Project { ... }` 之间插入：

```prisma
model Workspace {
  id        String   @id @default(cuid())
  locator   String
  status    String   @default("ready")
  metadata  String   @default("{}")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  project   Project?
}
```

- [ ] **Step 2: 把 `Project.workdir` 替换为 `Project.workspaceId` 关联**

把：

```prisma
model Project {
  id          String    @id @default(cuid())
  name        String
  workdir     String
  gitUrl      String?
  description String?
  userId      String?
  user        User?     @relation(fields: [userId], references: [id])
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?
  threads     Thread[]

  @@index([userId])
}
```

改为：

```prisma
model Project {
  id          String    @id @default(cuid())
  name        String
  workspaceId String    @unique
  workspace   Workspace @relation(fields: [workspaceId], references: [id])
  gitUrl      String?
  description String?
  userId      String?
  user        User?     @relation(fields: [userId], references: [id])
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?
  threads     Thread[]

  @@index([userId])
}
```

- [ ] **Step 3: 在文件末尾新增 `Run` 模型**

```prisma
model Run {
  id              String    @id @default(cuid())
  threadId        String
  projectId       String
  userId          String
  agentType       String
  providerType    String    @default("local")
  runtimeId       String?
  status          String    @default("queued")
  phase           String?
  lastSeq         Int       @default(0)
  lastHeartbeatAt DateTime?
  error           String?
  startedAt       DateTime?
  finishedAt      DateTime?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@index([threadId])
  @@index([status])
}
```

`Run` 用纯字符串字段记录 `threadId`/`projectId`/`userId`，不建 Prisma 关系（避免给 SQLite 增加级联约束），与 `Thread`/`Project`/`User` 的关联只在应用层维护，和现有 `Message` 用 `threadId` 字符串关联的风格一致。

- [ ] **Step 4: 重置开发数据库并生成 Prisma Client**

```bash
pnpm --filter api db:reset
```

Expected: 命令执行 `prisma db push --force-reset`，输出包含 `Your database is now in sync with your Prisma schema` 和 `Generated Prisma Client`。

- [ ] **Step 5: 运行 typecheck，确认是预期中的"未迁移代码"报错**

```bash
pnpm --filter api typecheck 2>&1 | tail -30
```

Expected: 报错集中在 `src/projects/project.service.ts`、`src/projects/project.service.spec.ts`、`src/threads/thread.service.ts` 中对 `project.workdir` / `data.workdir` 的引用（属性不存在），其余文件无报错。这些会在 Task 3、Task 4 中修复。

- [ ] **Step 6: 暂存**

```bash
git add apps/api/prisma/schema.prisma
```

建议 commit message：`feat(api): add Workspace and Run models, replace Project.workdir with workspaceId`

---

### Task 2: WorkspaceModule / WorkspaceService

**Files:**
- Create: `apps/api/src/workspaces/workspace.service.ts`
- Create: `apps/api/src/workspaces/workspace.module.ts`
- Test: `apps/api/src/workspaces/workspace.service.spec.ts`

- [ ] **Step 1: 写测试**

```ts
// apps/api/src/workspaces/workspace.service.spec.ts
vi.mock("../prisma/prisma.service", () => ({
  PrismaService: class PrismaService {},
}));

import { WorkspaceService } from "./workspace.service";

describe("WorkspaceService", () => {
  it("creates a workspace with the given locator and ready status", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "workspace-1",
      locator: "/tmp/workspace/admin-1/abc12345",
      status: "ready",
      metadata: "{}",
    });
    const service = new WorkspaceService({ workspace: { create } } as never);

    const workspace = await service.create("/tmp/workspace/admin-1/abc12345");

    expect(create).toHaveBeenCalledWith({
      data: { locator: "/tmp/workspace/admin-1/abc12345", status: "ready" },
    });
    expect(workspace.id).toBe("workspace-1");
    expect(workspace.locator).toBe("/tmp/workspace/admin-1/abc12345");
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
pnpm --filter api exec vitest run src/workspaces/workspace.service.spec.ts
```

Expected: FAIL，提示找不到模块 `./workspace.service`。

- [ ] **Step 3: 实现 `WorkspaceService`**

```ts
// apps/api/src/workspaces/workspace.service.ts
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class WorkspaceService {
  constructor(private prisma: PrismaService) {}

  async create(locator: string) {
    return this.prisma.workspace.create({
      data: { locator, status: "ready" },
    });
  }
}
```

- [ ] **Step 4: 创建 `WorkspaceModule`**

```ts
// apps/api/src/workspaces/workspace.module.ts
import { Module } from "@nestjs/common";
import { WorkspaceService } from "./workspace.service";

@Module({
  providers: [WorkspaceService],
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
```

- [ ] **Step 5: 运行测试，确认通过**

```bash
pnpm --filter api exec vitest run src/workspaces/workspace.service.spec.ts
```

Expected: PASS。

- [ ] **Step 6: 暂存**

```bash
git add apps/api/src/workspaces
```

建议 commit message：`feat(api): add WorkspaceService and WorkspaceModule`

---

### Task 3: ProjectService 改用 Workspace

**Files:**
- Modify: `apps/api/src/projects/project.service.ts`
- Modify: `apps/api/src/projects/project.module.ts`
- Test: `apps/api/src/projects/project.service.spec.ts`

- [ ] **Step 1: 重写测试，覆盖"创建 workspace + 写入 project.workspaceId + 响应里映射回 workdir"**

```ts
// apps/api/src/projects/project.service.spec.ts
vi.mock("../prisma/prisma.service", () => ({
  PrismaService: class PrismaService {},
}));

vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock("@paralleldrive/cuid2", () => ({
  createId: () => "project-1",
}));

import { ProjectService } from "./project.service";

describe("ProjectService", () => {
  it("creates a workspace for the project and maps workspace.locator back to workdir", async () => {
    const expectedLocator = "/tmp/workspace/admin-1/project-";

    const workspaceCreate = vi.fn((locator: string) =>
      Promise.resolve({
        id: "workspace-1",
        locator,
        status: "ready",
        metadata: "{}",
      })
    );
    const projectCreate = vi.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        ...args.data,
        workspace: {
          id: "workspace-1",
          locator: expectedLocator,
          status: "ready",
          metadata: "{}",
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    );
    const service = new ProjectService(
      { project: { create: projectCreate } } as never,
      {
        getUserWorkspace: (userId: string) => `/tmp/workspace/${userId}`,
      } as never,
      { create: workspaceCreate } as never
    );

    const project = await service.create("admin-1", "Local project");

    expect(workspaceCreate).toHaveBeenCalledWith(expectedLocator);
    expect(projectCreate.mock.calls[0]?.[0].data).toMatchObject({
      id: "project-1",
      userId: "admin-1",
      workspaceId: "workspace-1",
    });
    expect(project.workdir).toBe(expectedLocator);
    expect((project as Record<string, unknown>).workspace).toBeUndefined();
  });
});
```

注意：`id.slice(0, 8)` 对 mock 的 `"project-1"`（9 个字符）取前 8 位是 `"project-"`，所以 `expectedLocator` 末尾是 `project-`（与现有 `id.slice(0, 8)` 逻辑保持一致，未改动该计算方式）。

- [ ] **Step 2: 运行测试，确认失败**

```bash
pnpm --filter api exec vitest run src/projects/project.service.spec.ts
```

Expected: FAIL —— `ProjectService` 构造函数目前只接受 2 个参数，且 `prisma.project.create` 的 `data` 里仍是 `workdir` 而不是 `workspaceId`。

- [ ] **Step 3: 重写 `project.service.ts`**

```ts
// apps/api/src/projects/project.service.ts
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { spawn } from "child_process";
import { createId } from "@paralleldrive/cuid2";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { ConfigService } from "../config/config.service";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceService } from "../workspaces/workspace.service";

const PROJECT_NAME_MAX_LENGTH = 20;
const PROJECT_DESCRIPTION_MAX_LENGTH = 60;

const PROJECT_INCLUDE = { workspace: true } as const;

function gitClone(gitUrl: string, workdir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["clone", gitUrl, workdir], { stdio: "pipe" });
    const stderr: Buffer[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            Buffer.concat(stderr).toString().trim() || `exit code ${code}`
          )
        );
    });
    proc.on("error", reject);
  });
}

@Injectable()
export class ProjectService {
  private readonly logger = new Logger(ProjectService.name);
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private workspaceService: WorkspaceService
  ) {}

  async listAll() {
    const projects = await this.prisma.project.findMany({
      where: { deletedAt: null },
      include: { user: { select: { username: true } }, ...PROJECT_INCLUDE },
      orderBy: { createdAt: "desc" },
    });
    return projects.map((p) => this.toProjectDto(p));
  }

  async list(userId: string) {
    const projects = await this.prisma.project.findMany({
      where: { ...this.ownerWhere(userId), deletedAt: null },
      include: PROJECT_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
    return projects.map((p) => this.toProjectDto(p));
  }

  async create(
    userId: string,
    name: string,
    gitUrl?: string,
    description?: string
  ) {
    const projectName = this.normalizeName(name);
    const projectDescription = this.normalizeDescription(description);
    const projectGitUrl = gitUrl?.trim();
    const id = createId();
    const locator = join(this.config.getUserWorkspace(userId), id.slice(0, 8));

    try {
      if (projectGitUrl) {
        this.logger.log(`Cloning ${projectGitUrl} into ${locator}`);
        await gitClone(projectGitUrl, locator);
      } else {
        this.logger.log(`Creating project directory: ${locator}`);
        mkdirSync(locator, { recursive: true });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new InternalServerErrorException(
        projectGitUrl ? `Git clone 失败: ${msg}` : `创建目录失败: ${msg}`
      );
    }

    const workspace = await this.workspaceService.create(locator);

    try {
      const project = await this.prisma.project.create({
        data: {
          id,
          name: projectName,
          workspaceId: workspace.id,
          gitUrl: projectGitUrl,
          description: projectDescription,
          userId,
        },
        include: PROJECT_INCLUDE,
      });
      return this.toProjectDto(project);
    } catch (err) {
      rmSync(locator, { recursive: true, force: true });
      await this.prisma.workspace
        .delete({ where: { id: workspace.id } })
        .catch(() => {});
      throw err;
    }
  }

  async update(
    userId: string,
    id: string,
    name: string,
    description?: string | null
  ) {
    const projectName = this.normalizeName(name);
    const projectDescription =
      description === undefined
        ? undefined
        : this.normalizeDescription(description);
    const project = await this.prisma.project.findFirst({
      where: { id, ...this.ownerWhere(userId) },
    });
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    const updated = await this.prisma.project.update({
      where: { id },
      data: { name: projectName, description: projectDescription },
      include: PROJECT_INCLUDE,
    });
    return this.toProjectDto(updated);
  }

  async updateAny(id: string, name: string, description?: string | null) {
    const projectName = this.normalizeName(name);
    const projectDescription =
      description === undefined
        ? undefined
        : this.normalizeDescription(description);
    const project = await this.prisma.project.findFirst({
      where: { id, deletedAt: null },
    });
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    const updated = await this.prisma.project.update({
      where: { id },
      data: { name: projectName, description: projectDescription },
      include: PROJECT_INCLUDE,
    });
    return this.toProjectDto(updated);
  }

  async delete(userId: string, id: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, ...this.ownerWhere(userId), deletedAt: null },
    });
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    await this.prisma.project.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  private toProjectDto<T extends { workspace: { locator: string } }>(
    project: T
  ) {
    const { workspace, ...rest } = project;
    return { ...rest, workdir: workspace.locator };
  }

  private normalizeName(name: string) {
    const trimmed = name?.trim();
    if (!trimmed) throw new BadRequestException("name is required");
    if (trimmed.length > PROJECT_NAME_MAX_LENGTH) {
      throw new BadRequestException(
        `name must be at most ${PROJECT_NAME_MAX_LENGTH} characters`
      );
    }
    return trimmed;
  }

  private normalizeDescription(description?: string | null) {
    const trimmed = description?.trim();
    if (!trimmed) return null;
    if (trimmed.length > PROJECT_DESCRIPTION_MAX_LENGTH) {
      throw new BadRequestException(
        `description must be at most ${PROJECT_DESCRIPTION_MAX_LENGTH} characters`
      );
    }
    return trimmed;
  }

  private ownerWhere(userId: string) {
    return { userId };
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
pnpm --filter api exec vitest run src/projects/project.service.spec.ts
```

Expected: PASS。

- [ ] **Step 5: `ProjectModule` 引入 `WorkspaceModule`**

```ts
// apps/api/src/projects/project.module.ts
import { Module } from "@nestjs/common";
import { ProjectController } from "./project.controller";
import { ProjectService } from "./project.service";
import { WorkspaceModule } from "../workspaces/workspace.module";

@Module({
  imports: [WorkspaceModule],
  controllers: [ProjectController],
  providers: [ProjectService],
})
export class ProjectModule {}
```

- [ ] **Step 6: 暂存**

```bash
git add apps/api/src/projects apps/api/src/workspaces
```

建议 commit message：`refactor(api): ProjectService creates a Workspace and maps locator back to workdir`

---

### Task 4: ThreadService.getProjectInfo 改读 workspace.locator

**Files:**
- Modify: `apps/api/src/threads/thread.service.ts`

- [ ] **Step 1: 修改 `getProjectInfo`**

把：

```ts
  async getProjectInfo(
    userId: string,
    threadId: string
  ): Promise<{ workdir?: string; name?: string }> {
    const thread = await this.prisma.thread.findFirst({
      where: { id: threadId, project: this.projectOwnerWhere(userId) },
    });
    if (!thread) return {};
    const project = await this.prisma.project.findFirst({
      where: { id: thread.projectId, deletedAt: null },
    });
    return { workdir: project?.workdir, name: project?.name };
  }
```

改为：

```ts
  async getProjectInfo(
    userId: string,
    threadId: string
  ): Promise<{ workdir?: string; name?: string }> {
    const thread = await this.prisma.thread.findFirst({
      where: { id: threadId, project: this.projectOwnerWhere(userId) },
    });
    if (!thread) return {};
    const project = await this.prisma.project.findFirst({
      where: { id: thread.projectId, deletedAt: null },
      include: { workspace: true },
    });
    return { workdir: project?.workspace.locator, name: project?.name };
  }
```

- [ ] **Step 2: 运行 typecheck 和现有线程测试**

```bash
pnpm --filter api typecheck 2>&1 | tail -20
pnpm --filter api exec vitest run src/threads/thread.service.spec.ts
```

Expected: typecheck 不再报 `project.workdir` / `data.workdir` 相关错误（Task 1 Step 5 列出的报错已全部清除）；线程测试 PASS。

- [ ] **Step 3: 暂存**

```bash
git add apps/api/src/threads/thread.service.ts
```

建议 commit message：`refactor(api): ThreadService.getProjectInfo reads workspace.locator`

---

### Task 5: RunRegistry（控制面内存注册表）

**Files:**
- Create: `apps/api/src/runs/run-registry.service.ts`
- Test: `apps/api/src/runs/run-registry.service.spec.ts`

- [ ] **Step 1: 写测试**

```ts
// apps/api/src/runs/run-registry.service.spec.ts
import { RunRegistry } from "./run-registry.service";

describe("RunRegistry", () => {
  it("registers, retrieves and unregisters a run handle", () => {
    const registry = new RunRegistry();
    const handle = { interrupt: vi.fn(), stopRequested: false };

    registry.register("run-1", handle);
    expect(registry.get("run-1")).toBe(handle);

    registry.unregister("run-1");
    expect(registry.get("run-1")).toBeUndefined();
  });

  it("returns undefined for an unknown run id", () => {
    const registry = new RunRegistry();
    expect(registry.get("missing")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
pnpm --filter api exec vitest run src/runs/run-registry.service.spec.ts
```

Expected: FAIL，提示找不到模块 `./run-registry.service`。

- [ ] **Step 3: 实现 `RunRegistry`**

```ts
// apps/api/src/runs/run-registry.service.ts
import { Injectable } from "@nestjs/common";

export type RunHandle = {
  interrupt: () => void | Promise<void>;
  stopRequested: boolean;
};

@Injectable()
export class RunRegistry {
  private readonly handles = new Map<string, RunHandle>();

  register(runId: string, handle: RunHandle): void {
    this.handles.set(runId, handle);
  }

  unregister(runId: string): void {
    this.handles.delete(runId);
  }

  get(runId: string): RunHandle | undefined {
    return this.handles.get(runId);
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
pnpm --filter api exec vitest run src/runs/run-registry.service.spec.ts
```

Expected: PASS。

- [ ] **Step 5: 暂存**

```bash
git add apps/api/src/runs/run-registry.service.ts apps/api/src/runs/run-registry.service.spec.ts
```

建议 commit message：`feat(api): add RunRegistry in-process run handle registry`

---

### Task 6: RunService（Run 实体 CRUD）

**Files:**
- Create: `apps/api/src/runs/run.service.ts`
- Test: `apps/api/src/runs/run.service.spec.ts`

- [ ] **Step 1: 写测试**

```ts
// apps/api/src/runs/run.service.spec.ts
vi.mock("../prisma/prisma.service", () => ({
  PrismaService: class PrismaService {},
}));

import { RunService } from "./run.service";

describe("RunService", () => {
  it("creates a run with the given identifiers", async () => {
    const create = vi.fn().mockResolvedValue({ id: "run-1", status: "queued" });
    const service = new RunService({ run: { create } } as never);

    await service.create({
      id: "run-1",
      threadId: "thread-1",
      projectId: "project-1",
      userId: "user-1",
      agentType: "claude",
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        id: "run-1",
        threadId: "thread-1",
        projectId: "project-1",
        userId: "user-1",
        agentType: "claude",
      },
    });
  });

  it("marks a run as running with a startedAt timestamp", async () => {
    const update = vi.fn().mockResolvedValue({});
    const service = new RunService({ run: { update } } as never);

    await service.markRunning("run-1");

    expect(update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({ status: "running" }),
    });
  });

  it("marks a run as finished", async () => {
    const update = vi.fn().mockResolvedValue({});
    const service = new RunService({ run: { update } } as never);

    await service.markFinished("run-1");

    expect(update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({ status: "finished" }),
    });
  });

  it("marks a run as errored with the error message", async () => {
    const update = vi.fn().mockResolvedValue({});
    const service = new RunService({ run: { update } } as never);

    await service.markError("run-1", "boom");

    expect(update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({ status: "error", error: "boom" }),
    });
  });

  it("marks a run as cancelling", async () => {
    const update = vi.fn().mockResolvedValue({});
    const service = new RunService({ run: { update } } as never);

    await service.markCancelling("run-1");

    expect(update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: { status: "cancelling" },
    });
  });

  it("finds the most recent active run for a thread", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "run-1", status: "running" });
    const service = new RunService({ run: { findFirst } } as never);

    const run = await service.findActiveByThreadId("thread-1");

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        threadId: "thread-1",
        status: { in: ["queued", "preparing", "running", "cancelling"] },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(run?.id).toBe("run-1");
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
pnpm --filter api exec vitest run src/runs/run.service.spec.ts
```

Expected: FAIL，提示找不到模块 `./run.service`。

- [ ] **Step 3: 实现 `RunService`**

```ts
// apps/api/src/runs/run.service.ts
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "cancelling"
  | "finished"
  | "error";

const ACTIVE_RUN_STATUSES: RunStatus[] = [
  "queued",
  "preparing",
  "running",
  "cancelling",
];

@Injectable()
export class RunService {
  constructor(private prisma: PrismaService) {}

  async create(data: {
    id: string;
    threadId: string;
    projectId: string;
    userId: string;
    agentType: string;
  }) {
    return this.prisma.run.create({
      data: {
        id: data.id,
        threadId: data.threadId,
        projectId: data.projectId,
        userId: data.userId,
        agentType: data.agentType,
      },
    });
  }

  async markRunning(runId: string) {
    await this.prisma.run.update({
      where: { id: runId },
      data: { status: "running", startedAt: new Date() },
    });
  }

  async markCancelling(runId: string) {
    await this.prisma.run.update({
      where: { id: runId },
      data: { status: "cancelling" },
    });
  }

  async markFinished(runId: string) {
    await this.prisma.run.update({
      where: { id: runId },
      data: { status: "finished", finishedAt: new Date() },
    });
  }

  async markError(runId: string, error: string) {
    await this.prisma.run.update({
      where: { id: runId },
      data: { status: "error", error, finishedAt: new Date() },
    });
  }

  async findActiveByThreadId(threadId: string) {
    return this.prisma.run.findFirst({
      where: { threadId, status: { in: ACTIVE_RUN_STATUSES } },
      orderBy: { createdAt: "desc" },
    });
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
pnpm --filter api exec vitest run src/runs/run.service.spec.ts
```

Expected: PASS。

- [ ] **Step 5: 暂存**

```bash
git add apps/api/src/runs/run.service.ts apps/api/src/runs/run.service.spec.ts
```

建议 commit message：`feat(api): add RunService for Run entity lifecycle`

---

### Task 7: RunsModule

**Files:**
- Create: `apps/api/src/runs/runs.module.ts`

- [ ] **Step 1: 创建模块**

```ts
// apps/api/src/runs/runs.module.ts
import { Module } from "@nestjs/common";
import { RunService } from "./run.service";
import { RunRegistry } from "./run-registry.service";

@Module({
  providers: [RunService, RunRegistry],
  exports: [RunService, RunRegistry],
})
export class RunsModule {}
```

- [ ] **Step 2: 运行 typecheck**

```bash
pnpm --filter api typecheck 2>&1 | tail -10
```

Expected: 无新增报错。

- [ ] **Step 3: 暂存**

```bash
git add apps/api/src/runs/runs.module.ts
```

建议 commit message：`feat(api): add RunsModule`

---

### Task 8: AgentController/AgentModule 改为围绕 Run 生命周期编排

**Files:**
- Modify: `apps/api/src/agent/agent.controller.ts`
- Modify: `apps/api/src/agent/agent.module.ts`

- [ ] **Step 1: 替换 import 与移除 `activeAgentRuns` Map / `ActiveAgentRun` 类型**

把：

```ts
import { resolveQuestion, cancelQuestion } from "@agework/adapters";
import { RunAggregator } from "./run-aggregator";

// ── 用户主动停止 ──────────────────────────────────────────────────────────────
// Keyed by threadId. Lets the stop endpoint reach into an in-flight run from
// a separate request to actually interrupt the agent (not just disconnect SSE).
type ActiveAgentRun = {
  interrupt: () => void | Promise<void>;
  stopRequested: boolean;
};
const activeAgentRuns = new Map<string, ActiveAgentRun>();
```

改为：

```ts
import { resolveQuestion, cancelQuestion } from "@agework/adapters";
import { RunAggregator } from "./run-aggregator";
import { RunService } from "../runs/run.service";
import { RunRegistry, type RunHandle } from "../runs/run-registry.service";
```

- [ ] **Step 2: 注入 `RunService` 和 `RunRegistry`**

把：

```ts
  constructor(
    private readonly agentService: AgentService,
    private readonly threadService: ThreadService,
    private readonly traceLogger: AgentTraceLogger,
    private readonly titleService: TitleService
  ) {}
```

改为：

```ts
  constructor(
    private readonly agentService: AgentService,
    private readonly threadService: ThreadService,
    private readonly traceLogger: AgentTraceLogger,
    private readonly titleService: TitleService,
    private readonly runService: RunService,
    private readonly runRegistry: RunRegistry
  ) {}
```

- [ ] **Step 3: 在线程信息查询时记录 `projectId`**

把：

```ts
    let agentType = requestedAgentType;
    let modelConfigId = requestedModelConfigId;
    let agentResumeId: string | undefined;
    let projectWorkdir: string | undefined;

    if (threadId) {
      try {
        const thread = await this.threadService.findOne(userId, threadId);
        agentType = thread.agentType ?? agentType;
        agentResumeId = thread.agentResumeId;
        const projectInfo = await this.threadService.getProjectInfo(
          userId,
          threadId
        );
        projectWorkdir = projectInfo.workdir;
      } catch {
        // thread not found yet, use forwardedProps agent
      }
    }
```

改为：

```ts
    let agentType = requestedAgentType;
    let modelConfigId = requestedModelConfigId;
    let agentResumeId: string | undefined;
    let projectId: string | undefined;
    let projectWorkdir: string | undefined;

    if (threadId) {
      try {
        const thread = await this.threadService.findOne(userId, threadId);
        agentType = thread.agentType ?? agentType;
        agentResumeId = thread.agentResumeId;
        projectId = thread.projectId;
        const projectInfo = await this.threadService.getProjectInfo(
          userId,
          threadId
        );
        projectWorkdir = projectInfo.workdir;
      } catch {
        // thread not found yet, use forwardedProps agent
      }
    }
```

- [ ] **Step 4: 创建 Run、注册 RunRegistry 句柄、改写 `finalizeRun`**

把：

```ts
    if (threadId) {
      await this.threadService
        .setRunStatus(threadId, "running")
        .catch(() => {});
    }

    const activeRun: ActiveAgentRun = {
      interrupt: () => adapter.interrupt(),
      stopRequested: false,
    };
    if (threadId) activeAgentRuns.set(threadId, activeRun);

    let finalized = false;
    const finalizeRun = (status: "idle" | "error") => {
      if (finalized) return;
      finalized = true;
      if (threadId) {
        if (activeAgentRuns.get(threadId) === activeRun) activeAgentRuns.delete(threadId);
        this.threadService.setRunStatus(threadId, status).catch(() => {});
      }
    };
```

改为：

```ts
    if (threadId) {
      await this.threadService
        .setRunStatus(threadId, "running")
        .catch(() => {});
    }

    let run: { id: string } | undefined;
    if (threadId && projectId) {
      try {
        run = await this.runService.create({
          id: runId,
          threadId,
          projectId,
          userId,
          agentType,
        });
        await this.runService.markRunning(run.id);
      } catch {
        run = undefined;
      }
    }

    const activeRun: RunHandle = {
      interrupt: () => adapter.interrupt(),
      stopRequested: false,
    };
    if (run) this.runRegistry.register(run.id, activeRun);

    let finalized = false;
    const finalizeRun = (status: "idle" | "error", error?: string) => {
      if (finalized) return;
      finalized = true;
      if (run) {
        this.runRegistry.unregister(run.id);
        if (status === "error") {
          this.runService.markError(run.id, error ?? "unknown error").catch(() => {});
        } else {
          this.runService.markFinished(run.id).catch(() => {});
        }
      }
      if (threadId) {
        this.threadService.setRunStatus(threadId, status).catch(() => {});
      }
    };
```

`run` 创建失败（极少见的 DB 异常）时整体退化为"无 Run 记录"，聊天流程本身不受影响——`stop` 端点会因为 `findActiveByThreadId` 查不到记录而走兜底分支（Step 6）。

- [ ] **Step 5: 把 observable 的 `error` 回调里的 `finalizeRun("error")` 改为带上错误信息**

把：

```ts
      error: (err: Error) => {
        // 中断导致 observable 直接报错（未走到 RUN_FINISHED/RUN_ERROR 事件）：
        // 仍按"已停止"持久化并收尾，不当作运行失败处理
        if (activeRun.stopRequested) {
          if (threadId) saveRun(false);
          finalizeRun("idle");
          if (!res.writableEnded) res.end();
          return;
        }
        finalizeRun("error");
        if (!errorEventSent && !res.writableEnded) {
```

改为：

```ts
      error: (err: Error) => {
        // 中断导致 observable 直接报错（未走到 RUN_FINISHED/RUN_ERROR 事件）：
        // 仍按"已停止"持久化并收尾，不当作运行失败处理
        if (activeRun.stopRequested) {
          if (threadId) saveRun(false);
          finalizeRun("idle");
          if (!res.writableEnded) res.end();
          return;
        }
        finalizeRun("error", err.message);
        if (!errorEventSent && !res.writableEnded) {
```

- [ ] **Step 6: 改写 `stop` 端点**

把：

```ts
  @Post("threads/:threadId/stop")
  async stop(
    @Param("threadId") threadId: string,
    @CurrentUser() user: JwtUser
  ) {
    const thread = await this.threadService.findOne(user.userId, threadId);
    const run = activeAgentRuns.get(threadId);
    if (!run) {
      if (thread.runStatus === "running") {
        await this.threadService.setRunStatus(threadId, "idle");
      }
      return;
    }
    run.stopRequested = true;
    await run.interrupt();
  }
```

改为：

```ts
  @Post("threads/:threadId/stop")
  async stop(
    @Param("threadId") threadId: string,
    @CurrentUser() user: JwtUser
  ) {
    const thread = await this.threadService.findOne(user.userId, threadId);
    const activeRunRecord = await this.runService.findActiveByThreadId(threadId);
    const handle = activeRunRecord
      ? this.runRegistry.get(activeRunRecord.id)
      : undefined;
    if (!handle) {
      if (thread.runStatus === "running") {
        await this.threadService.setRunStatus(threadId, "idle");
      }
      if (activeRunRecord) {
        await this.runService.markFinished(activeRunRecord.id);
      }
      return;
    }
    handle.stopRequested = true;
    if (activeRunRecord) {
      await this.runService.markCancelling(activeRunRecord.id);
    }
    await handle.interrupt();
  }
```

- [ ] **Step 7: `AgentModule` 引入 `RunsModule`**

把：

```ts
import { Module } from "@nestjs/common";
import { AgentController } from "./agent.controller";
import { AgentService } from "./agent.service";
import { AgentTraceLogger } from "./agent-trace-logger";
import { TitleService } from "./title.service";
import { ThreadModule } from "../threads/thread.module";

@Module({
  imports: [ThreadModule],
  controllers: [AgentController],
  providers: [AgentService, AgentTraceLogger, TitleService],
})
export class AgentModule {}
```

改为：

```ts
import { Module } from "@nestjs/common";
import { AgentController } from "./agent.controller";
import { AgentService } from "./agent.service";
import { AgentTraceLogger } from "./agent-trace-logger";
import { TitleService } from "./title.service";
import { ThreadModule } from "../threads/thread.module";
import { RunsModule } from "../runs/runs.module";

@Module({
  imports: [ThreadModule, RunsModule],
  controllers: [AgentController],
  providers: [AgentService, AgentTraceLogger, TitleService],
})
export class AgentModule {}
```

- [ ] **Step 8: typecheck**

```bash
pnpm --filter api typecheck 2>&1 | tail -20
```

Expected: 无报错。

- [ ] **Step 9: 暂存**

```bash
git add apps/api/src/agent/agent.controller.ts apps/api/src/agent/agent.module.ts
```

建议 commit message：`refactor(api): AgentController orchestrates runs via Run entity + RunRegistry`

---

### Task 9: 全量验证

**Files:** 无新增文件，仅运行验证命令。

- [ ] **Step 1: 全量 typecheck 与构建**

```bash
pnpm typecheck 2>&1 | tail -20
pnpm build 2>&1 | tail -10
```

Expected: 全部成功。

- [ ] **Step 2: 后端测试**

```bash
pnpm test:api 2>&1 | tail -20
```

Expected: 全部 PASS（包括 Task 3 重写后的 `project.service.spec.ts`，原先因 `id.slice(0,8)` 与期望值不一致导致的失败已随重写的测试数据一并修正）。

- [ ] **Step 3: 手动启动并冒烟测试（对应设计文档第 12 节"阶段 1-2 验证方式"）**

```bash
pnpm dev
```

在浏览器中验证：
- 创建一个新项目，确认创建成功（项目列表正常显示，目录已创建）。
- 打开一个线程发起一次 Claude 或 Codex 对话，确认消息正常流式返回并落库。
- 对话过程中点击"停止"，确认能立即中断，`Run` 表中对应记录的 `status` 变为 `cancelling` 后又变为 `finished`（可用 `pnpm db:studio` 查看 `Run` 表确认）。
- 触发一次需要 HITL（AskUserQuestion）的对话，确认问答流程正常。

确认无误后按 Ctrl+C 停止。

- [ ] **Step 4: 暂存（如有遗漏文件）**

```bash
git status --short
```

Expected: 无未暂存的相关改动（如有遗漏，`git add` 补齐）。

---

## 完成后

按 `superpowers:executing-plans` 流程，全部任务完成并验证通过后：
- 公告 "I'm using the finishing-a-development-branch skill to complete this work."
- 调用 `superpowers:finishing-a-development-branch`。
