import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { generateId } from "@agework/shared";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { WorkspaceRepository } from "./workspace.repository";
import { RunService } from "../run/run.service";
import type { RunWorkspaceView } from "../run/run-service.types";
import {
  WORKSPACE_DELETED_EVENT,
  WorkspaceDeletedEvent,
} from "./workspace.events";
import {
  EXTERNAL_DIRECTORY_SOURCE,
  MANAGED_DIRECTORY_SOURCE,
  WorkspaceDirectoryHandler,
} from "./directory/workspace-directory.handler";
import { WorkspaceRuntimePolicy } from "./runtime/workspace-runtime.policy";

const WORKSPACE_NAME_MAX_LENGTH = 20;
const WORKSPACE_DESCRIPTION_MAX_LENGTH = 60;

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

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly repo: WorkspaceRepository,
    private readonly events: EventEmitter2,
    private readonly runService: RunService,
    private readonly runtimePolicy: WorkspaceRuntimePolicy,
    private readonly directoryHandler: WorkspaceDirectoryHandler
  ) {}

  /**
   * Admin 查询工作空间列表,包含 owner username 和会话数量等管理视图字段。
   */
  async listAll(pagination?: { take: number; skip: number }) {
    const { list, total } = await this.repo.listAllWithMeta(pagination);
    const mapped = list.map((p) => {
      const { _count, ...rest } = p;
      return {
        ...this.toWorkspaceDto(rest),
        conversationCount: _count.conversations,
      };
    });
    if (pagination) {
      return {
        list: mapped,
        total,
        pageNo: pagination.skip / pagination.take + 1,
        pageSize: pagination.take,
      };
    }
    return { list: mapped };
  }

  /**
   * run 启动所需的 workspace 视图：目录 + runtime 配置 + 属主用户名。
   * 供 agent 层在调用 RunService.start 前解析（run 层不直接读 workspace 表）。
   * workspace 不存在抛 404，未关联目录抛 400。
   */
  async getRunView(workspaceId: string): Promise<RunWorkspaceView> {
    const workspace = await this.repo.findRunView(workspaceId);
    if (!workspace) {
      throw new NotFoundException(`Workspace ${workspaceId} not found`);
    }
    if (!workspace.directory?.rootPath) {
      throw new BadRequestException("工作空间必须关联目录才能运行 agent");
    }
    return {
      workspaceId: workspace.id,
      workspaceRootPath: workspace.directory.rootPath,
      runtimeType: workspace.runtimeType ?? undefined,
      isolationScope: workspace.isolationScope,
      sandboxEngine: workspace.sandboxEngine,
      username: workspace.user.username,
    };
  }

  /**
   * 用户侧查询自己拥有的工作空间列表。
   */
  async list(userId: string) {
    const workspaces = await this.repo.listByOwner(userId);
    return { list: workspaces.map((p) => this.toWorkspaceDto(p)) };
  }

  /**
   * 返回当前部署允许创建工作空间时选择的 runtime / isolation 能力。
   */
  capabilities() {
    return this.runtimePolicy.capabilities();
  }

  /**
   * 创建工作空间并准备目录绑定。目录创建 / git clone 失败会清理已创建目录。
   */
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
    const { runtimeType, sandboxEngine, isolationScope } =
      this.runtimePolicy.resolveCreateRuntime({
        runtimeType: requestedRuntimeType,
        sandboxEngine: requestedSandboxEngine,
        isolationScope: requestedIsolationScope,
        hasCustomRootPath: Boolean(requestedRootPath?.trim()),
      });
    const id = generateId();
    const directory = await this.directoryHandler.prepareCreate({
      userId,
      workspaceId: id,
      runtimeType,
      isolationScope,
      gitUrl: workspaceGitUrl,
      requestedRootPath,
    });

    try {
      const workspace = await this.repo.createWithDirectory({
        id,
        name: workspaceName,
        gitUrl: workspaceGitUrl,
        description: workspaceDescription,
        userId,
        runtimeType,
        isolationScope,
        sandboxEngine,
        rootPath: directory.rootPath,
        directorySource: directory.directorySource,
      });
      return this.toWorkspaceDto(workspace);
    } catch (err) {
      this.directoryHandler.cleanupCreated(directory);
      throw err;
    }
  }

  /**
   * 用户侧更新自己拥有的工作空间基础信息;非 owner 访问收敛为 404。
   */
  async update(
    userId: string,
    id: string,
    name: string,
    description?: string | null
  ) {
    const patch = this.normalizePatch(name, description);
    const updated = await this.repo.updateOwned(userId, id, patch);
    if (!updated) throw new NotFoundException(`Workspace ${id} not found`);
    return this.toWorkspaceDto(updated);
  }

  /**
   * Admin 更新任意工作空间基础信息;权限由 AdminWorkspaceController 保证。
   */
  async updateAny(id: string, name: string, description?: string | null) {
    const patch = this.normalizePatch(name, description);
    const updated = await this.repo.updateById(id, patch);
    if (!updated) throw new NotFoundException(`Workspace ${id} not found`);
    return this.toWorkspaceDto(updated);
  }

  private normalizePatch(name: string, description?: string | null) {
    return {
      name: this.normalizeName(name),
      description:
        description === undefined
          ? undefined
          : this.normalizeDescription(description),
    };
  }

  /**
   * 用户侧删除自己拥有的工作空间。删除前通过 RunService 阻止活跃 run,删除后发出 workspace deleted fact event。
   */
  async delete(userId: string, id: string) {
    const workspace = await this.repo.findOwnedId(userId, id);
    if (!workspace) throw new NotFoundException(`Workspace ${id} not found`);
    if (await this.runService.hasActiveRunForWorkspace(id)) {
      throw new BadRequestException("工作空间有正在运行的任务，不能删除");
    }

    await this.repo.softDeleteCascade(id);

    // 下游（runtime）据此清理与该 workspace 绑定的资源；workspace 不感知下游。
    this.events.emit(WORKSPACE_DELETED_EVENT, new WorkspaceDeletedEvent(id));
  }

  private toWorkspaceDto<
    T extends {
      directory?: {
        rootPath: string;
        status: string;
        source?: string | null;
      } | null;
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
    const runtimeType =
      storedRuntimeType ?? this.runtimePolicy.defaultRuntimeType();
    const workspaceIsolationScope =
      runtimeType === "sandbox"
        ? this.runtimePolicy.resolveStoredIsolationScope(storedIsolationScope)
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
}

function normalizeDirectorySource(source: string | null | undefined) {
  return source === EXTERNAL_DIRECTORY_SOURCE
    ? EXTERNAL_DIRECTORY_SOURCE
    : MANAGED_DIRECTORY_SOURCE;
}
