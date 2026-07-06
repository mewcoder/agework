import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { generateId } from "@agework/shared";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { WorkspaceRepository } from "./workspace.repository";
import type { WorkspaceRunContext } from "./workspace.types";
import { ConversationService } from "../conversation/conversation.service";
import {
  WORKSPACE_DELETED_EVENT,
  WorkspaceDeletedEvent,
} from "./workspace.events";
import {
  EXTERNAL_DIRECTORY_SOURCE,
  MANAGED_DIRECTORY_SOURCE,
  REMOTE_DIRECTORY_SOURCE,
  WorkspaceDirectoryHandler,
} from "./directory/workspace-directory.handler";
import { WorkspaceRuntimePolicy } from "./runtime/workspace-runtime.policy";
import { RuntimeService } from "../runtime/runtime.service";
import type { RuntimeType, IsolationScope } from "../config/config.service";

const WORKSPACE_NAME_MAX_LENGTH = 20;
const WORKSPACE_DESCRIPTION_MAX_LENGTH = 60;

type CreateWorkspaceInput = {
  userId: string;
  name: string;
  gitUrl?: string;
  description?: string;
  rootPath?: string;
  runtimeType?: string;
  isolationScope?: string;
  /** 绑定到某个已配对的 Registered Runtime;传入时 runtimeType/isolationScope
   *  改由该 Runtime 自己决定,忽略 input 里另外传的 runtimeType。 */
  runtimeId?: string;
};

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly repo: WorkspaceRepository,
    private readonly conversations: ConversationService,
    private readonly events: EventEmitter2,
    private readonly runtimePolicy: WorkspaceRuntimePolicy,
    private readonly directoryHandler: WorkspaceDirectoryHandler,
    private readonly runtimeService: RuntimeService
  ) {}

  /**
   * 查询工作空间是否存在且属于该用户;返回 null 表示不存在或非属主。
   * 供上层入口(如 agent 建会话)做归属校验,由调用方决定如何处理 null。
   */
  getOwnedId(
    userId: string,
    workspaceId: string
  ): Promise<{ id: string } | null> {
    return this.repo.getOwnedId(userId, workspaceId);
  }

  /**
   * Admin 查询工作空间列表,包含 owner username 和会话数量等管理视图字段。
   */
  async listForAdmin(pagination?: { take: number; skip: number }) {
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
   * run 启动所需的 workspace 运行上下文：目录 + runtime 配置 + 属主用户名。
   * 供 agent 层在调用 RunService.start 前解析（run 层不直接读 workspace 表）。
   * workspace 不存在抛 404，未关联目录抛 400。
   */
  async getRunContext(workspaceId: string): Promise<WorkspaceRunContext> {
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
      // Runtime 行必然存在,runtimeType 在配对完成前才可能为空(见
      // WorkspaceService.resolveRegisteredPlacement,创建时已经校验过)。
      runtimeType: workspace.runtime.runtimeType as string,
      isolationScope: workspace.isolationScope,
      username: workspace.user.username,
      runtimeId: workspace.runtimeId,
      runtimeSource: workspace.runtime.source,
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
  getCapabilities() {
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
      isolationScope: requestedIsolationScope,
      runtimeId: requestedRuntimeId,
    } = input;
    const workspaceName = this.normalizeName(name);
    const workspaceDescription = this.normalizeDescription(description);
    const workspaceGitUrl = gitUrl?.trim();
    const { runtimeType, isolationScope, targetRuntimeId } =
      await this.resolvePlacement({
        userId,
        requestedRuntimeType,
        requestedIsolationScope,
        requestedRuntimeId,
        hasCustomRootPath: Boolean(requestedRootPath?.trim()),
      });
    // local 没有隔离概念,isolationScope 解析结果是 null;Workspace.isolationScope
    // 列必填,用 "workspace" 占位(与 Worker 侧同一约定,见 worker.provisioner.ts
    // 的 identity())。
    const storedIsolationScope = isolationScope ?? "workspace";
    const id = generateId();
    // directoryHandler 用 targetRuntimeId 是否有值判断"目录在远程机器上,不碰本机
    // 文件系统"——builtin runtimeId 现在也总是有值,但 builtin 就是 Managed(本机),
    // 目录仍要走本机 fs 校验/创建,只有 registered 才传给它。
    const remoteRuntimeId = this.runtimeService.isManaged(targetRuntimeId)
      ? undefined
      : targetRuntimeId;
    const directory = await this.directoryHandler.prepareCreate({
      userId,
      workspaceId: id,
      runtimeType,
      isolationScope,
      gitUrl: workspaceGitUrl,
      requestedRootPath,
      targetRuntimeId: remoteRuntimeId,
    });

    try {
      const workspace = await this.repo.createWithDirectory({
        id,
        name: workspaceName,
        gitUrl: workspaceGitUrl,
        description: workspaceDescription,
        userId,
        isolationScope: storedIsolationScope,
        rootPath: directory.rootPath,
        directorySource: directory.directorySource,
        runtimeId: targetRuntimeId,
      });
      return this.toWorkspaceDto(workspace);
    } catch (err) {
      this.directoryHandler.cleanupCreated(directory);
      throw err;
    }
  }

  /**
   * 解析 placement:Registered(传了 runtimeId)分支复用 resolveRegisteredPlacement;
   * Managed 分支按部署策略解析 runtimeType/isolationScope 后,落到该 runtimeType
   * 对应的 builtin Runtime id。
   */
  private async resolvePlacement(input: {
    userId: string;
    requestedRuntimeType?: string;
    requestedIsolationScope?: string;
    requestedRuntimeId?: string;
    hasCustomRootPath: boolean;
  }): Promise<{
    runtimeType: RuntimeType;
    isolationScope: IsolationScope | null;
    targetRuntimeId: string;
  }> {
    if (input.requestedRuntimeId) {
      return this.resolveRegisteredPlacement(
        input.userId,
        input.requestedRuntimeId,
        input.requestedIsolationScope
      );
    }
    const { runtimeType, isolationScope } =
      this.runtimePolicy.resolveCreateRuntime({
        runtimeType: input.requestedRuntimeType,
        isolationScope: input.requestedIsolationScope,
        hasCustomRootPath: input.hasCustomRootPath,
      });
    return {
      runtimeType,
      isolationScope,
      targetRuntimeId: this.runtimeService.getBuiltinRuntimeId(runtimeType),
    };
  }

  /**
   * Registered runtime 分支的 placement 解析:runtimeType 由该 Runtime 自己注册的
   * 类型决定(选 Runtime 即定运行方式,不接受前端另传 runtimeType);isolationScope
   * 按该 Runtime 上报的能力矩阵校验/收窄,而非部署级 ConfigService 允许列表
   * (那是 Managed 专属的策略,与某一台具体机器的能力无关)。
   */
  private async resolveRegisteredPlacement(
    userId: string,
    runtimeId: string,
    requestedIsolationScope?: string
  ): Promise<{
    runtimeType: RuntimeType;
    isolationScope: IsolationScope | null;
    targetRuntimeId: string;
  }> {
    const registeredRuntime = await this.runtimeService.getOwned(
      userId,
      runtimeId
    );
    if (!registeredRuntime) {
      throw new NotFoundException(`Runtime ${runtimeId} not found`);
    }
    if (!registeredRuntime.runtimeType) {
      throw new BadRequestException("该运行环境还未完成配对,无法创建工作空间");
    }
    const runtimeType = registeredRuntime.runtimeType as RuntimeType;
    if (runtimeType === "local") {
      if (requestedIsolationScope) {
        throw new BadRequestException("本地运行环境不能设置 isolationScope");
      }
      return { runtimeType, isolationScope: null, targetRuntimeId: runtimeId };
    }
    const capabilities = registeredRuntime.capabilities as {
      isolationScopes?: string[];
    } | null;
    const allowedScopes = capabilities?.isolationScopes ?? [];
    const isolationScope = requestedIsolationScope?.trim() || allowedScopes[0];
    if (!isolationScope || !allowedScopes.includes(isolationScope)) {
      throw new BadRequestException(
        `该运行环境不支持隔离级别: ${isolationScope ?? "未指定"}`
      );
    }
    return {
      runtimeType,
      isolationScope: isolationScope as IsolationScope,
      targetRuntimeId: runtimeId,
    };
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
  async updateForAdmin(id: string, name: string, description?: string | null) {
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
   * 用户侧删除自己拥有的工作空间。软删后发出 workspace deleted fact event,
   * 下游据此级联(runtime 清理绑定资源、run 停止该 workspace 的活跃任务);
   * workspace 不感知下游(方案 B:总能删,任务被停)。
   */
  async delete(userId: string, id: string) {
    const workspace = await this.repo.getOwnedId(userId, id);
    if (!workspace) throw new NotFoundException(`Workspace ${id} not found`);

    const deletedAt = new Date();
    await this.repo.softDelete(id, deletedAt);
    await this.conversations.deleteByWorkspace(id, deletedAt);

    this.events.emit(WORKSPACE_DELETED_EVENT, new WorkspaceDeletedEvent(id));
  }

  private toWorkspaceDto<
    T extends {
      directory?: {
        rootPath: string;
        status: string;
        source?: string | null;
      } | null;
      runtime: { runtimeType: string | null };
      isolationScope: string;
    },
  >(workspace: T) {
    const {
      directory,
      runtime,
      isolationScope: storedIsolationScope,
      ...rest
    } = workspace;
    if (!directory) {
      throw new InternalServerErrorException(
        `Workspace ${(rest as { id?: string }).id ?? "unknown"} has no directory binding`
      );
    }
    const runtimeType =
      runtime.runtimeType ?? this.runtimePolicy.defaultRuntimeType();
    const workspaceIsolationScope =
      runtimeType !== "local"
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
  if (source === EXTERNAL_DIRECTORY_SOURCE) return EXTERNAL_DIRECTORY_SOURCE;
  if (source === REMOTE_DIRECTORY_SOURCE) return REMOTE_DIRECTORY_SOURCE;
  return MANAGED_DIRECTORY_SOURCE;
}
