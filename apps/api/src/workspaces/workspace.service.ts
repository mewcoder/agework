import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { generateId } from "@agework/shared";
import { spawn } from "child_process";
import { mkdirSync, realpathSync, rmSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve } from "path";
import {
  ConfigService,
  type IsolationScope,
  type RuntimeType,
  type SandboxEngineType,
} from "../config/config.service";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { PrismaService } from "../prisma/prisma.service";
import {
  WORKSPACE_DELETED_EVENT,
  WorkspaceDeletedEvent,
} from "./workspace.events";

const WORKSPACE_NAME_MAX_LENGTH = 20;
const WORKSPACE_DESCRIPTION_MAX_LENGTH = 60;

const WORKSPACE_INCLUDE = { directory: true } as const;

const GIT_CLONE_TIMEOUT_MS = 5 * 60_000;
const ACTIVE_RUN_STATUSES = [
  "queued",
  "preparing",
  "running",
  "cancelling",
  "requires_action",
] as const;
const MANAGED_DIRECTORY_SOURCE = "managed";
const EXTERNAL_DIRECTORY_SOURCE = "external";

type CreateWorkspaceInput = {
  userId: string;
  name: string;
  gitUrl?: string;
  description?: string;
  rootPath?: string;
  runtimeType?: string;
  sandboxEngine?: string;
  isolationScope?: string;
};

function gitClone(gitUrl: string, rootPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["clone", "--", gitUrl, rootPath], {
      stdio: "pipe",
    });
    const stderr: Buffer[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`git clone timed out after ${GIT_CLONE_TIMEOUT_MS / 1000}s`));
    }, GIT_CLONE_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            Buffer.concat(stderr).toString().trim() || `exit code ${code}`
          )
        );
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function expandHomePath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private events: EventEmitter2
  ) {}

  async listAll(pagination?: { take: number; skip: number }) {
    const where = { deletedAt: null };
    if (pagination) {
      const [workspaces, total] = await Promise.all([
        this.prisma.workspace.findMany({
          where,
          include: {
            user: { select: { username: true } },
            _count: { select: { conversations: { where: { deletedAt: null } } } },
            ...WORKSPACE_INCLUDE,
          },
          orderBy: { createdAt: "desc" },
          take: pagination.take,
          skip: pagination.skip,
        }),
        this.prisma.workspace.count({ where }),
      ]);
      return {
        list: workspaces.map((p) => {
          const { _count, ...rest } = p;
          return { ...this.toWorkspaceDto(rest), conversationCount: _count.conversations };
        }),
        total,
        pageNo: pagination.skip / pagination.take + 1,
        pageSize: pagination.take,
      };
    }
    const workspaces = await this.prisma.workspace.findMany({
      where,
      include: {
        user: { select: { username: true } },
        _count: { select: { conversations: { where: { deletedAt: null } } } },
        ...WORKSPACE_INCLUDE,
      },
      orderBy: { createdAt: "desc" },
    });
    return {
      list: workspaces.map((p) => {
        const { _count, ...rest } = p;
        return { ...this.toWorkspaceDto(rest), conversationCount: _count.conversations };
      }),
    };
  }

  async list(userId: string) {
    const workspaces = await this.prisma.workspace.findMany({
      where: { ...this.ownerWhere(userId), deletedAt: null },
      include: WORKSPACE_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
    return { list: workspaces.map((p) => this.toWorkspaceDto(p)) };
  }

  capabilities() {
    const allowedRuntimeTypes = this.config.getAllowedRuntimeTypes();
    const allowedIsolationScopes =
      this.config.getAllowedIsolationScopes();
    const runtimeType = this.config.getDefaultRuntimeType();
    const isolationScope = this.config.getDefaultIsolationScope();
    const canSelectLocalDirectory =
      allowedRuntimeTypes.includes("local") ||
      (allowedRuntimeTypes.includes("sandbox") &&
        allowedIsolationScopes.includes("workspace"));
    return {
      canSelectLocalDirectory,
      runtimeType,
      allowedRuntimeTypes,
      sandboxEngine: this.config.getSandboxEngine(),
      isolationScope,
      allowedIsolationScopes,
    };
  }

  async create(input: CreateWorkspaceInput) {
    const {
      userId,
      name,
      gitUrl,
      description,
      rootPath: requestedRootPath,
      runtimeType: requestedRuntimeType,
      sandboxEngine: requestedSandboxEngine,
      isolationScope: requestedIsolationScope,
    } = input;
    const workspaceName = this.normalizeName(name);
    const workspaceDescription = this.normalizeDescription(description);
    const workspaceGitUrl = gitUrl?.trim();
    const runtimeType = this.normalizeRuntimeType(requestedRuntimeType);
    const sandboxEngine = this.normalizeSandboxEngine(
      runtimeType,
      requestedSandboxEngine
    );
    const isolationScope = this.normalizeIsolationScope(
      runtimeType,
      requestedIsolationScope,
      Boolean(requestedRootPath?.trim())
    );
    const id = generateId();
    const { rootPath, ownsDirectory } = await this.resolveCreateRootPath(
      userId,
      id,
      workspaceGitUrl,
      requestedRootPath,
      runtimeType,
      isolationScope
    );

    try {
      if (ownsDirectory && workspaceGitUrl) {
        this.logger.log(`Cloning ${workspaceGitUrl} into ${rootPath}`);
        await gitClone(workspaceGitUrl, rootPath);
      } else if (ownsDirectory) {
        this.logger.log(`Creating workspace directory: ${rootPath}`);
        mkdirSync(rootPath, { recursive: true });
      } else {
        this.logger.log(`Binding existing workspace directory: ${rootPath}`);
      }
    } catch (err: unknown) {
      // 清理失败时残留的部分目录（如 git clone 超时后的不完整仓库）
      if (ownsDirectory) {
        try { rmSync(rootPath, { recursive: true, force: true }); } catch {}
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new InternalServerErrorException(
        workspaceGitUrl ? `Git clone 失败: ${msg}` : `创建目录失败: ${msg}`
      );
    }

    try {
      const workspace = await this.prisma.$transaction(async (tx) => {
        const created = await tx.workspace.create({
          data: {
            id,
            name: workspaceName,
            gitUrl: workspaceGitUrl,
            description: workspaceDescription,
            userId,
            runtimeType: runtimeType,
            isolationScope,
            sandboxEngine,
          },
        });
        const directory = await tx.workspaceDirectory.create({
          data: {
            id: generateId(),
            workspaceId: created.id,
            rootPath,
            status: "ready",
            source: ownsDirectory
              ? MANAGED_DIRECTORY_SOURCE
              : EXTERNAL_DIRECTORY_SOURCE,
            metadata: {},
          },
        });
        return { ...created, directory };
      });
      return this.toWorkspaceDto(workspace);
    } catch (err) {
      if (ownsDirectory) {
        rmSync(rootPath, { recursive: true, force: true });
      }
      throw err;
    }
  }

  async update(
    userId: string,
    id: string,
    name: string,
    description?: string | null
  ) {
    const workspaceName = this.normalizeName(name);
    const workspaceDescription =
      description === undefined
        ? undefined
        : this.normalizeDescription(description);

    // 使用事务确保查询和更新的原子性
    const updated = await this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.findFirst({
        where: { id, ...this.ownerWhere(userId), deletedAt: null },
      });
      if (!workspace) throw new NotFoundException(`Workspace ${id} not found`);

      return tx.workspace.update({
        where: { id },
        data: { name: workspaceName, description: workspaceDescription },
        include: WORKSPACE_INCLUDE,
      });
    });

    return this.toWorkspaceDto(updated);
  }

  async updateAny(
    id: string,
    name: string,
    description?: string | null
  ) {
    const workspaceName = this.normalizeName(name);
    const workspaceDescription =
      description === undefined
        ? undefined
        : this.normalizeDescription(description);

    // 使用事务确保查询和更新的原子性
    const updated = await this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.findFirst({
        where: { id, deletedAt: null },
      });
      if (!workspace) throw new NotFoundException(`Workspace ${id} not found`);

      return tx.workspace.update({
        where: { id },
        data: { name: workspaceName, description: workspaceDescription },
        include: WORKSPACE_INCLUDE,
      });
    });

    return this.toWorkspaceDto(updated);
  }

  async delete(userId: string, id: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id, ...this.ownerWhere(userId), deletedAt: null },
      select: { id: true },
    });
    if (!workspace) throw new NotFoundException(`Workspace ${id} not found`);
    const activeRun = await this.prisma.run.findFirst({
      where: {
        conversation: { workspaceId: id },
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
      select: { id: true },
    });
    if (activeRun) {
      throw new BadRequestException("工作空间有正在运行的任务，不能删除");
    }

    const deletedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.workspace.update({
        where: { id },
        data: { deletedAt },
      }),
      this.prisma.conversation.updateMany({
        where: { workspaceId: id, deletedAt: null },
        data: { deletedAt },
      }),
    ]);

    // 下游（runtime）据此清理与该 workspace 绑定的资源；workspace 不感知下游。
    this.events.emit(WORKSPACE_DELETED_EVENT, new WorkspaceDeletedEvent(id));
  }

  private toWorkspaceDto<
    T extends {
      directory?: { rootPath: string; status: string; source?: string | null } | null;
      runtimeType?: string | null;
      isolationScope?: string | null;
      sandboxEngine?: string | null;
    },
  >(workspace: T) {
    const {
      directory,
      runtimeType: storedRuntimeType,
      isolationScope: storedIsolationScope,
      ...rest
    } = workspace;
    if (!directory) {
      throw new InternalServerErrorException(
        `Workspace ${(rest as { id?: string }).id ?? "unknown"} has no directory binding`
      );
    }
    const runtimeType = storedRuntimeType ?? this.config.getDefaultRuntimeType();
    const workspaceIsolationScope =
      runtimeType === "sandbox"
        ? this.resolveStoredIsolationScope(storedIsolationScope)
        : null;
    return {
      ...rest,
      runtimeType,
      isolationScope: workspaceIsolationScope,
      rootPath: directory.rootPath,
      directoryStatus: directory.status,
      directorySource: normalizeDirectorySource(directory.source),
    };
  }

  private normalizeName(name: string) {
    const trimmed = name?.trim();
    if (!trimmed) throw new BadRequestException("name is required");
    if (trimmed.length > WORKSPACE_NAME_MAX_LENGTH) {
      throw new BadRequestException(
        `name must be at most ${WORKSPACE_NAME_MAX_LENGTH} characters`
      );
    }
    return trimmed;
  }

  private normalizeDescription(description?: string | null) {
    const trimmed = description?.trim();
    if (!trimmed) return null;
    if (trimmed.length > WORKSPACE_DESCRIPTION_MAX_LENGTH) {
      throw new BadRequestException(
        `description must be at most ${WORKSPACE_DESCRIPTION_MAX_LENGTH} characters`
      );
    }
    return trimmed;
  }

  private async resolveCreateRootPath(
    userId: string,
    workspaceId: string,
    gitUrl: string | undefined,
    requestedRootPath: string | undefined,
    runtimeType: RuntimeType,
    isolationScope: IsolationScope | null
  ) {
    const username = await this.resolveUsername(userId);
    const trimmedRootPath = requestedRootPath?.trim();
    if (!trimmedRootPath) {
      const rootPath =
        isolationScope === "workspace"
          ? join(this.config.getWorkspace(), `${username}_${workspaceId}`)
          : join(this.config.getUserWorkspace(username), workspaceId);
      return { rootPath, ownsDirectory: true };
    }
    if (gitUrl) {
      throw new BadRequestException("本地目录模式不能同时填写 Git 地址");
    }

    const rootPath = this.normalizeExistingDirectory(trimmedRootPath);
    this.assertCustomRootPathSupported(runtimeType, isolationScope);
    if (isolationScope === "workspace") {
      this.assertPathOutsideUserRoot(username, rootPath);
    }

    const existing = await this.prisma.workspaceDirectory.findFirst({
      where: { rootPath },
      select: { workspaceId: true },
    });
    if (existing) {
      throw new ConflictException("该目录已绑定到其他工作空间");
    }

    return { rootPath, ownsDirectory: false };
  }

  private normalizeExistingDirectory(input: string) {
    const expanded = expandHomePath(input.trim());
    if (!expanded) throw new BadRequestException("目录路径不能为空");
    if (!isAbsolute(expanded)) {
      throw new BadRequestException("目录路径必须是绝对路径");
    }

    let rootPath: string;
    let isDirectory = false;
    try {
      rootPath = realpathSync(resolve(expanded));
      isDirectory = statSync(rootPath).isDirectory();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`目录不存在或不可访问: ${msg}`);
    }

    if (!isDirectory) {
      throw new BadRequestException("目录路径必须指向一个目录");
    }
    return rootPath;
  }

  private assertCustomRootPathSupported(
    runtimeType: RuntimeType,
    isolationScope: IsolationScope | null
  ) {
    if (this.supportsCustomRootPath(runtimeType, isolationScope)) return;

    throw new BadRequestException(
      "沙箱工作空间指定本地目录时必须使用工作空间级隔离"
    );
  }

  private assertPathOutsideUserRoot(username: string, rootPath: string) {
    const userRoot = this.config.getUserWorkspace(username);
    const rel = relative(userRoot, rootPath);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new BadRequestException(
        "工作空间隔离的自定义目录不能在用户工作空间目录内"
      );
    }
  }

  private async resolveUsername(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });
    if (!user) {
      throw new BadRequestException(`用户不存在: ${userId}`);
    }
    return user.username;
  }

  private normalizeRuntimeType(runtimeType?: string): RuntimeType {
    const value = runtimeType?.trim() || this.config.getDefaultRuntimeType();
    if (!this.config.isRuntimeTypeAllowed(value)) {
      throw new BadRequestException(`当前部署不支持该工作空间运行环境: ${value}`);
    }
    return value;
  }

  private normalizeSandboxEngine(
    runtimeType: RuntimeType,
    sandboxEngine?: string
  ): SandboxEngineType | null {
    const value = sandboxEngine?.trim();
    if (runtimeType !== "sandbox") {
      if (value) throw new BadRequestException("本地工作空间不能设置 sandboxEngine");
      return null;
    }
    if (!value) return this.config.getSandboxEngine();
    if (value !== "docker" && value !== "opensandbox") {
      throw new BadRequestException(`不支持的 sandboxEngine: ${value}`);
    }
    return value;
  }

  private normalizeIsolationScope(
    runtimeType: RuntimeType,
    isolationScope: string | undefined,
    hasCustomRootPath: boolean
  ): IsolationScope | null {
    const value = isolationScope?.trim();
    if (runtimeType !== "sandbox") {
      if (value) {
        throw new BadRequestException("本地工作空间不能设置 isolationScope");
      }
      return null;
    }

    if (hasCustomRootPath && !value) {
      if (!this.config.isIsolationScopeAllowed("workspace")) {
        throw new BadRequestException(
          "当前部署不支持沙箱工作空间使用自定义本地目录"
        );
      }
      return "workspace";
    }

    const resolved = value || this.config.getDefaultIsolationScope();
    if (!this.config.isIsolationScopeAllowed(resolved)) {
      throw new BadRequestException(`当前部署不支持该沙箱隔离级别: ${resolved}`);
    }
    if (hasCustomRootPath && resolved !== "workspace") {
      throw new BadRequestException(
        "沙箱工作空间指定本地目录时必须使用工作空间级隔离"
      );
    }
    return resolved;
  }

  private resolveStoredIsolationScope(
    isolationScope: string | null | undefined
  ): IsolationScope {
    if (isolationScope === "user" || isolationScope === "workspace") {
      return isolationScope;
    }
    if (isolationScope) {
      throw new InternalServerErrorException(
        `Workspace has invalid isolationScope: ${isolationScope}`
      );
    }
    return this.config.getDefaultIsolationScope();
  }

  private supportsCustomRootPath(
    runtimeType: RuntimeType,
    isolationScope: IsolationScope | null
  ) {
    return runtimeType === "local" ||
      (runtimeType === "sandbox" && isolationScope === "workspace");
  }

  private ownerWhere(userId: string) {
    return { userId };
  }
}

function normalizeDirectorySource(source: string | null | undefined) {
  return source === EXTERNAL_DIRECTORY_SOURCE
    ? EXTERNAL_DIRECTORY_SOURCE
    : MANAGED_DIRECTORY_SOURCE;
}
