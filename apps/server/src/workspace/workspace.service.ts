import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { execFile } from "child_process";
import { promisify } from "util";
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
import { WorkspaceRuntimePolicy } from "./placement/workspace-runtime.policy";
import { RuntimeHostService } from "../runtime-host/runtime-host.service";
import type { RuntimeType } from "@agework/providers";
import type { WorkerScope } from "@agework/shared/protocol";
import type {
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
  WorkspaceFileSearchResponse,
} from "@agework/shared/api";
import {
  availableRuntimeTypes,
  normalizeRuntimeCapabilities,
} from "@agework/shared/protocol";

const WORKSPACE_NAME_MAX_LENGTH = 20;
const WORKSPACE_DESCRIPTION_MAX_LENGTH = 60;
const GIT_LS_REMOTE_TIMEOUT_MS = 15_000;

const execFileAsync = promisify(execFile);

type CreateWorkspaceInput = {
  userId: string;
  name: string;
  gitUrl?: string;
  /** 创建时选定的 git 分支;传了就在 clone 时 checkout,不传走默认分支。 */
  gitBranch?: string;
  description?: string;
  rootPath?: string;
  runtimeType?: string;
  scope?: string;
  /** 绑定到某个已配对的 Registered Runtime Host。runtimeType 选择其一种能力。 */
  runtimeHostId?: string;
};

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly repo: WorkspaceRepository,
    private readonly conversations: ConversationService,
    private readonly events: EventEmitter2,
    private readonly runtimePolicy: WorkspaceRuntimePolicy,
    private readonly directoryHandler: WorkspaceDirectoryHandler,
    private readonly runtimeService: RuntimeHostService
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
      runtimeType: workspace.runtimeType,
      scope: workspace.scope,
      username: workspace.user.username,
      runtimeHostId: workspace.runtimeHostId,
      runtimeSource: workspace.runtimeHost.source,
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
   * 返回当前部署允许创建工作空间时选择的 runtime / runtimeType 能力。
   */
  getCapabilities() {
    return this.runtimePolicy.capabilities();
  }

  /**
   * 解析公开 git 仓库的分支列表,供创建工作空间时下拉选择。
   * 只查远程 ref(git ls-remote),不 clone、不碰工作区文件,server 本机直接跑。
   * 数组传参 + `--` 防注入;私有仓库 / 地址错 / 超时统一抛 400。
   */
  async listGitBranches(gitUrl: string): Promise<{ list: string[] }> {
    const trimmed = gitUrl?.trim();
    if (!trimmed) {
      throw new BadRequestException("gitUrl is required");
    }
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["ls-remote", "--heads", "--", trimmed],
        { timeout: GIT_LS_REMOTE_TIMEOUT_MS }
      );
      return { list: parseGitBranches(stdout) };
    } catch {
      throw new BadRequestException(
        "无法解析该仓库分支,请确认是公开仓库且地址正确"
      );
    }
  }

  // ── 文件预览（builtin 直读，registered 经隧道 RPC） ──

  /** 列出一层目录(根目录时 path 为空串)。 */
  async listFiles(
    userId: string,
    workspaceId: string,
    path: string
  ): Promise<WorkspaceFileListResponse> {
    const ctx = await this.resolveFileContext(userId, workspaceId);
    return this.runtimeService.listFiles(
      ctx.runtimeHostId,
      ctx.workspaceRootPath,
      path ?? ""
    );
  }

  /** 读取文件内容(文本或图片 base64)。 */
  async readFile(
    userId: string,
    workspaceId: string,
    path: string
  ): Promise<WorkspaceFileReadResponse> {
    if (!path) {
      throw new BadRequestException("path is required");
    }
    const ctx = await this.resolveFileContext(userId, workspaceId);
    return this.runtimeService.readFile(
      ctx.runtimeHostId,
      ctx.workspaceRootPath,
      path
    );
  }

  // ── 变更查看(diff,只读) ──

  /**
   * 列出工作空间相对 HEAD 的累计变更（git-only、只读）。builtin Host 直跑 git；
   * registered Host 经隧道 RPC 调用。
   */
  async listChangedFiles(
    userId: string,
    workspaceId: string
  ): Promise<WorkspaceChangedFilesResponse> {
    const ctx = await this.resolveFileContext(userId, workspaceId);
    return this.runtimeService.listChangedFiles(
      ctx.runtimeHostId,
      ctx.workspaceRootPath
    );
  }

  /** 读取单文件的 before(HEAD)/after(当前)对比。约束同 listChangedFiles。 */
  async readFileDiff(
    userId: string,
    workspaceId: string,
    path: string
  ): Promise<WorkspaceFileDiffResponse> {
    if (!path) {
      throw new BadRequestException("path is required");
    }
    const ctx = await this.resolveFileContext(userId, workspaceId);
    return this.runtimeService.readFileDiff(
      ctx.runtimeHostId,
      ctx.workspaceRootPath,
      path
    );
  }

  /** 列出工作空间所有文件相对路径（git ls-files，供 `@` 文件提及）。 */
  async searchFiles(
    userId: string,
    workspaceId: string
  ): Promise<WorkspaceFileSearchResponse> {
    const ctx = await this.resolveFileContext(userId, workspaceId);
    return this.runtimeService.searchFiles(
      ctx.runtimeHostId,
      ctx.workspaceRootPath
    );
  }

  /**
   * 属主校验 + 解析运行上下文。builtin 和 registered 分支共用。
   */
  private async resolveFileContext(
    userId: string,
    workspaceId: string
  ): Promise<WorkspaceRunContext> {
    const owned = await this.repo.getOwnedId(userId, workspaceId);
    if (!owned) {
      throw new NotFoundException(`Workspace ${workspaceId} not found`);
    }
    return this.getRunContext(workspaceId);
  }

  /**
   * 创建工作空间并准备目录绑定。目录创建 / git clone 失败会清理已创建目录。
   */
  async create(input: CreateWorkspaceInput) {
    const {
      userId,
      name,
      gitUrl,
      gitBranch,
      description,
      rootPath: requestedRootPath,
      runtimeType: requestedRuntimeType,
      scope: requestedWorkerScope,
      runtimeHostId: requestedRuntimeHostId,
    } = input;
    const workspaceName = this.normalizeName(name);
    const workspaceDescription = this.normalizeDescription(description);
    const workspaceGitUrl = gitUrl?.trim();
    // 只有真的填了 git 地址,分支选择才有意义;否则忽略,gitBranch 留 null。
    const workspaceGitBranch = workspaceGitUrl ? gitBranch?.trim() : undefined;
    const { runtimeType, scope, runtimeHostId } = await this.resolvePlacement({
      userId,
      requestedRuntimeType,
      requestedWorkerScope,
      requestedRuntimeHostId,
      hasCustomRootPath: Boolean(requestedRootPath?.trim()),
    });
    const id = generateId();
    // directoryHandler 只接收 registered Host id；builtin Host 的目录仍走本机
    // fs 校验/创建。
    const registeredRuntimeHostId = this.runtimeService.isBuiltinHost(
      runtimeHostId
    )
      ? undefined
      : runtimeHostId;
    const directory = await this.directoryHandler.prepareCreate({
      userId,
      workspaceId: id,
      runtimeType,
      scope,
      gitUrl: workspaceGitUrl,
      gitBranch: workspaceGitBranch,
      requestedRootPath,
      registeredRuntimeHostId,
    });

    try {
      const workspace = await this.repo.createWithDirectory({
        id,
        name: workspaceName,
        gitUrl: workspaceGitUrl,
        gitBranch: workspaceGitBranch ?? directory.detectedGitBranch,
        description: workspaceDescription,
        userId,
        scope,
        // Phase 2 expand:创建时即写执行方式快照,Phase 3 后成为唯一真相。
        runtimeType: runtimeType,
        rootPath: directory.rootPath,
        directorySource: directory.directorySource,
        runtimeHostId,
      });
      return this.toWorkspaceDto(workspace);
    } catch (err) {
      this.directoryHandler.cleanupCreated(directory);
      throw err;
    }
  }

  /**
   * 解析 placement:Registered(传了 runtimeHostId)分支复用 resolveRegisteredPlacement;
   * builtin 分支按部署策略解析 runtimeType/scope，Host id 固定为 builtin。
   */
  private async resolvePlacement(input: {
    userId: string;
    requestedRuntimeType?: string;
    requestedWorkerScope?: string;
    requestedRuntimeHostId?: string;
    hasCustomRootPath: boolean;
  }): Promise<{
    runtimeType: RuntimeType;
    scope: WorkerScope;
    runtimeHostId: string;
  }> {
    if (input.requestedRuntimeHostId) {
      return this.resolveRegisteredPlacement(
        input.userId,
        input.requestedRuntimeHostId,
        input.requestedRuntimeType,
        input.requestedWorkerScope
      );
    }
    const { runtimeType, scope } = this.runtimePolicy.resolveCreateRuntime({
      runtimeType: input.requestedRuntimeType,
      scope: input.requestedWorkerScope,
      hasCustomRootPath: input.hasCustomRootPath,
    });
    return {
      runtimeType,
      scope,
      runtimeHostId: this.runtimeService.getBuiltinHostId(),
    };
  }

  /**
   * Registered Host 分支的 placement 解析:runtimeType 从该 Host 的能力矩阵中选择；
   * scope 按所选 runtimeType 的 scopes 校验，而非部署级 ConfigService 允许列表
   * (那是 builtin Host 的部署策略,与某一台 registered Host 的能力无关)。
   */
  private async resolveRegisteredPlacement(
    userId: string,
    runtimeHostId: string,
    requestedRuntimeType?: string,
    requestedWorkerScope?: string
  ): Promise<{
    runtimeType: RuntimeType;
    scope: WorkerScope;
    runtimeHostId: string;
  }> {
    const registeredRuntime = await this.runtimeService.getOwned(
      userId,
      runtimeHostId
    );
    if (!registeredRuntime) {
      throw new NotFoundException(`Runtime ${runtimeHostId} not found`);
    }
    if (!registeredRuntime.capabilities) {
      throw new BadRequestException("该运行环境还未完成配对,无法创建工作空间");
    }
    const capabilities = normalizeRuntimeCapabilities(
      registeredRuntime.capabilities
    );
    const supportedRuntimeTypes = availableRuntimeTypes(capabilities);
    if (supportedRuntimeTypes.length === 0) {
      throw new BadRequestException("该运行环境还未完成配对,无法创建工作空间");
    }
    const selectedRuntimeType =
      requestedRuntimeType?.trim() ||
      (supportedRuntimeTypes.length === 1
        ? supportedRuntimeTypes[0]
        : undefined);
    if (!selectedRuntimeType) {
      throw new BadRequestException("该运行环境提供多种运行方式,请选择一种");
    }
    if (!supportedRuntimeTypes.includes(selectedRuntimeType)) {
      throw new BadRequestException(
        `该运行环境不支持运行方式: ${selectedRuntimeType}`
      );
    }
    const runtimeType = selectedRuntimeType as RuntimeType;
    const capability = capabilities[runtimeType];
    if (runtimeType === "native") {
      if (requestedWorkerScope && requestedWorkerScope !== "workspace") {
        throw new BadRequestException("native 运行方式只支持 workspace 范围");
      }
      return {
        runtimeType,
        scope: "workspace",
        runtimeHostId,
      };
    }
    const allowedScopes = capability.scopes;
    const scope = requestedWorkerScope?.trim() || allowedScopes[0];
    if (scope !== "user" && scope !== "workspace") {
      throw new BadRequestException(
        `该运行环境不支持运行范围: ${scope ?? "未指定"}`
      );
    }
    if (!allowedScopes.includes(scope)) {
      throw new BadRequestException(
        `该运行环境不支持运行范围: ${scope ?? "未指定"}`
      );
    }
    return {
      runtimeType,
      scope,
      runtimeHostId,
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

    this.events.emit(
      WORKSPACE_DELETED_EVENT,
      new WorkspaceDeletedEvent(id, userId, workspace.runtimeHostId)
    );
  }

  private toWorkspaceDto<
    T extends {
      directory?: {
        rootPath: string;
        status: string;
        source?: string | null;
      } | null;
      runtimeHost: { source: string };
      scope: string;
      runtimeType: string;
    },
  >(workspace: T) {
    const {
      directory,
      runtimeHost: _runtimeHost,
      scope: storedWorkerScope,
      runtimeType: rtSnapshot,
      ...rest
    } = workspace;
    if (!directory) {
      throw new InternalServerErrorException(
        `Workspace ${(rest as { id?: string }).id ?? "unknown"} has no directory binding`
      );
    }
    const workspaceWorkerScope =
      this.runtimePolicy.resolveStoredWorkerScope(storedWorkerScope);
    return {
      ...rest,
      runtimeType: rtSnapshot,
      scope: workspaceWorkerScope,
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

/** 解析 `git ls-remote --heads` 输出:每行 `<sha>\trefs/heads/<branch>`,取出分支名。 */
function parseGitBranches(stdout: string): string[] {
  const prefix = "refs/heads/";
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t")[1] ?? "")
    .filter((ref) => ref.startsWith(prefix))
    .map((ref) => ref.slice(prefix.length));
}

function normalizeDirectorySource(source: string | null | undefined) {
  if (source === EXTERNAL_DIRECTORY_SOURCE) return EXTERNAL_DIRECTORY_SOURCE;
  if (source === REMOTE_DIRECTORY_SOURCE) return REMOTE_DIRECTORY_SOURCE;
  return MANAGED_DIRECTORY_SOURCE;
}
