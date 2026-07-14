import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { generateId, type AgentType } from "@agework/shared";
import type {
  DirectoryListing,
  HostCapabilityStatus,
  HostUpstreamNotification,
  RuntimeCapabilities,
  RuntimeSpec,
  RuntimeTunnelAllRpcRequest,
  RuntimeTunnelHostNotification,
  WorkerScope,
} from "@agework/shared/protocol";
import { normalizeRuntimeCapabilities } from "@agework/shared/protocol";
import type {
  CreateRuntimeDirectoryResponse,
  CreateRuntimeResponse,
  DetectEnvResponse,
  RuntimeDirectoryResponse,
  RuntimeEnvConfig,
  RuntimeEnvConfigOverride,
  AgentEnvStatus,
  RuntimeResponse,
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
  WorkspaceFileSearchResponse,
} from "@agework/shared/api";
import { NotGitRepositoryError } from "@agework/shared/git";
import { resolveRuntimeSpec, type RuntimeSpecInput } from "@agework/providers";
import type { RuntimeConfig, RuntimeType } from "@agework/providers";
import { ConfigService } from "../config/config.service";
import { toRuntimeConfig } from "./local/runtime-config";
import { RuntimeRepository, type RuntimeHostRow } from "./runtime.repository";
import { RuntimeTunnelHandler } from "./gateway/runtime-tunnel.handler";
import { BUILTIN_HOST_ID, isBuiltinHostId } from "./runtime.types";
import { detectEnvConfig } from "@agework/shared/cli";
import { installCli as installLocalCli } from "./cli/cli-installer";
import {
  createDirectory as createDirectoryOnDisk,
  listDirectory as listDirectoryOnDisk,
} from "./filesystem/directory-browser";
import {
  createFsTimeoutSignal,
  listFiles as listFilesDirect,
  readFile as readFileDirect,
  searchFiles as searchFilesDirect,
} from "@agework/shared/filesystem";
import {
  listChangedFiles as listChangedFilesDirect,
  readFileDiff as readFileDiffDirect,
} from "@agework/shared/git";

/**
 * RuntimeHost 注册领域门面：管理 Host 注册表、placement 配置、能力与隧道传输。
 * worker 生命周期只经 RuntimeHostContract；本类不再持有第二套 Runtime 抽象。
 */
@Injectable()
export class RuntimeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RuntimeService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly repository: RuntimeRepository,
    private readonly tunnelHandler: RuntimeTunnelHandler
  ) {}

  /** 启动时只初始化一行 builtin Host，所有允许的 runtimeType 都写入能力矩阵。 */
  async onApplicationBootstrap(): Promise<void> {
    const allowedRuntimeTypes = this.configService.getAllowedRuntimeTypes();
    const capabilities: RuntimeCapabilities = {};
    for (const runtimeType of allowedRuntimeTypes) {
      capabilities[runtimeType] = {
        available: true,
        scopes: runtimeTypeScopes(runtimeType),
      };
    }
    await this.repository.upsertBuiltin({
      name: BUILTIN_HOST_ID,
      capabilities,
      tokenHash: null,
    });

    if (allowedRuntimeTypes.includes("native")) {
      const envConfig = detectEnvConfig();
      await this.repository.updateEnvConfig(BUILTIN_HOST_ID, envConfig);
    }
    this.logger.log(
      `builtin Runtime Host ready: ${allowedRuntimeTypes.join(", ")}`
    );
  }

  /** 是否是 builtin（本机 in-process）Host。 */
  isBuiltinHost(runtimeHostId: string): boolean {
    return isBuiltinHostId(runtimeHostId);
  }

  /** builtin Host 的固定 id（不查库，和 runtimeType 无关）。 */
  getBuiltinHostId(): string {
    return BUILTIN_HOST_ID;
  }

  /** 从 run 输入解析出目标运行环境(纯计算,不启动 worker;默认值由 run 层补齐)。 */
  resolveRuntimeSpec(input: RuntimeSpecInput): RuntimeSpec {
    return resolveRuntimeSpec(input);
  }

  /** 返回当前运行时策略配置(默认/可选 runtimeType、scope、空闲超时秒数),供前端展示与校验用。 */
  getRuntimePolicy() {
    return {
      defaultRuntimeType: this.configService.getDefaultRuntimeType(),
      allowedRuntimeTypes: this.configService.getAllowedRuntimeTypes(),
      defaultScope: this.configService.getDefaultWorkerScope(),
      allowedScopes: this.configService.getAllowedScopes(),
      idleTimeoutSeconds: this.configService.getIdleTimeoutSeconds(),
    };
  }

  /** 创建 Registered Runtime 并生成配对 token。token 明文只在本次响应出现,库里只存 sha256。 */
  async create(ownerId: string, name: string): Promise<CreateRuntimeResponse> {
    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    try {
      const row = await this.repository.create({ ownerId, name, tokenHash });
      return { runtime: toRuntimeResponse(row), token };
    } catch (err) {
      if (isPrismaUniqueError(err)) {
        throw new ConflictException(`runtime name already exists: ${name}`);
      }
      throw err;
    }
  }

  /** 列出当前用户可见的 Host：自己的 registered + 全局 builtin。 */
  async list(ownerId: string): Promise<{ list: RuntimeResponse[] }> {
    const rows = await this.repository.listVisibleToOwner(ownerId);
    return { list: rows.map(toRuntimeResponse) };
  }

  /** admin: 列出全部 Host（builtin + 所有用户的 registered），不含已注销。 */
  async listAll(): Promise<{ list: RuntimeResponse[] }> {
    const rows = await this.repository.listAll();
    return { list: rows.map(toRuntimeResponse) };
  }

  /**
   * 查询 Host 是否存在且对该用户可见（自己的 registered 或全局 builtin，且未注销）；
   * 返回 null 表示不存在/不可见/已注销。供上层入口（如创建 workspace 时校验目标 Host）
   * 做归属校验,由调用方决定如何处理 null。
   */
  getOwned(ownerId: string, id: string): Promise<RuntimeHostRow | null> {
    return this.repository.findVisibleToOwner(ownerId, id);
  }

  /**
   * 注销 registered Host（撤 token、软删除、行永久保留）：只拦"以后不能再绑定新 workspace"，
   * 不主动踢断在线隧道连接——这台机器上可能还有活跃 Worker 在跑,断连接等于强制判死,
   * 跟"放任其自然结束"的设计矛盾(见 runtime 模块 ADR-0001)。连接的存活/掉线继续按
   * 心跳机制走，不因注销而改变。builtin 行 ownerId=null，不会匹配任何真实 userId，
   * 天然不可被此方法注销。
   */
  async delete(ownerId: string, id: string): Promise<void> {
    const revoked = await this.repository.revokeByOwner(ownerId, id);
    if (!revoked) {
      throw new NotFoundException(`runtime not found: ${id}`);
    }
  }

  /**
   * 管理员覆盖 runtime 的 envConfig（per-agent）。空字符串 = 清除该 agent 的覆盖。
   * 不查 runtime 是否存在——admin 接口，不存在时 updateMany count=0 自然报 404。
   */
  async updateEnvConfigOverride(
    id: string,
    agentType: AgentType,
    executablePath: string
  ): Promise<void> {
    const current = await this.repository.findById(id);
    if (!current) {
      throw new NotFoundException(`runtime not found: ${id}`);
    }
    const override = mergeOverride(
      current.envConfigOverride as RuntimeEnvConfigOverride | null,
      agentType,
      executablePath
    );
    const updated = await this.repository.updateEnvConfigOverride(id, override);
    if (!updated) {
      throw new NotFoundException(`runtime not found: ${id}`);
    }
  }

  /**
   * 管理员一键安装 runtime 的独立 CLI(仅支持 native 类型;docker/opensandbox
   * 走镜像固定路径,装不装不影响实际执行,不支持此操作)。
   * 安装成功后自动写入 override 并重新检测刷新展示状态。
   */
  async installCli(
    id: string,
    agentType: AgentType
  ): Promise<DetectEnvResponse> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw new NotFoundException(`runtime not found: ${id}`);
    }
    if (row.source !== "builtin") {
      throw new BadRequestException(
        `runtime ${id} is not a native runtime, cannot install CLI`
      );
    }
    const executablePath = await installLocalCli(agentType);
    await this.updateEnvConfigOverride(id, agentType, executablePath);
    return this.detectEnv(id);
  }

  /**
   * 管理员触发 runtime 重新检测 CLI 环境。
   * - builtin Host:进程内检测。
   * - registered Host:通过 host.detectEnv RPC 重检能力矩阵。
   *   runtime 未连接时返回 null。
   */
  async detectEnv(id: string): Promise<DetectEnvResponse> {
    if (!this.tunnelHandler.isConnected(id) && !isBuiltinHostId(id)) {
      return { envConfig: null };
    }
    try {
      const envConfig = isBuiltinHostId(id)
        ? detectEnvConfig()
        : (
            await this.sendTunnelRequest<HostCapabilityStatus>(
              id,
              {
                jsonrpc: "2.0",
                id: generateId(),
                method: "host.detectEnv",
                params: { runtimeHostId: id },
              },
              this.configService.getLaunchTimeoutSeconds() * 1000
            )
          ).native?.cli;
      if (!envConfig) return { envConfig: null };
      await this.repository.updateEnvConfig(id, envConfig);
      return { envConfig };
    } catch (err) {
      this.logger.warn(
        `detect-env for runtime ${id} failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return { envConfig: null };
    }
  }

  /**
   * 列出该用户可见的 runtime 上 path 下的子目录(不含文件)。
   * runtime 不可见/不存在抛 NotFoundException;registered runtime 未连接抛
   * BadRequestException(前端应已用 status 提前禁用入口,这里是兜底)。
   */
  async listDirectory(
    ownerId: string,
    id: string,
    path?: string
  ): Promise<RuntimeDirectoryResponse> {
    await this.assertRuntimeReachable(ownerId, id);
    try {
      const result = isBuiltinHostId(id)
        ? listDirectoryOnDisk(path)
        : await this.sendTunnelRequest<DirectoryListing>(
            id,
            {
              jsonrpc: "2.0",
              id: generateId(),
              method: "host.listDirectory",
              params: { runtimeHostId: id, path },
            },
            this.configService.getLaunchTimeoutSeconds() * 1000
          );
      return { path: result.path, list: result.entries };
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /** 在该用户可见的 runtime 上新建目录,返回新建目录的绝对路径。规则同 listDirectory。 */
  async createDirectory(
    ownerId: string,
    id: string,
    path: string
  ): Promise<CreateRuntimeDirectoryResponse> {
    await this.assertRuntimeReachable(ownerId, id);
    try {
      if (isBuiltinHostId(id)) return createDirectoryOnDisk(path);
      await this.sendTunnelRequest<never>(
        id,
        {
          jsonrpc: "2.0",
          id: generateId(),
          method: "host.createDirectory",
          params: { runtimeHostId: id, path },
        },
        this.configService.getLaunchTimeoutSeconds() * 1000
      );
      return { path };
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ── 文件预览 ───────────────────────────────────────────────────────

  /**
   * builtin Host 直读本机硬盘；registered Host 经 host.* 隧道 RPC。
   * 安全校验复用 shared/fileBrowser，rootPath 由 WorkspaceService 查出后传入。
   */
  async listFiles(
    runtimeHostId: string,
    rootPath: string,
    relativePath: string
  ): Promise<WorkspaceFileListResponse> {
    try {
      if (!isBuiltinHostId(runtimeHostId)) {
        return await this.sendTunnelRequest<WorkspaceFileListResponse>(
          runtimeHostId,
          {
            jsonrpc: "2.0",
            id: generateId(),
            method: "host.listFiles",
            params: { runtimeHostId, rootPath, path: relativePath },
          },
          this.configService.getLaunchTimeoutSeconds() * 1000
        );
      }
      const result = await listFilesDirect(
        rootPath,
        relativePath,
        createFsTimeoutSignal()
      );
      return {
        path: result.path,
        list: result.list,
        truncated: result.truncated,
      };
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /** 文件预览直读(ADR-0005),同 listFiles。 */
  async readFile(
    runtimeHostId: string,
    rootPath: string,
    relativePath: string
  ): Promise<WorkspaceFileReadResponse> {
    try {
      if (!isBuiltinHostId(runtimeHostId)) {
        return await this.sendTunnelRequest<WorkspaceFileReadResponse>(
          runtimeHostId,
          {
            jsonrpc: "2.0",
            id: generateId(),
            method: "host.readFile",
            params: { runtimeHostId, rootPath, path: relativePath },
          },
          this.configService.getLaunchTimeoutSeconds() * 1000
        );
      }
      const result = await readFileDirect(
        rootPath,
        relativePath,
        createFsTimeoutSignal()
      );
      return {
        path: result.path,
        encoding: result.encoding,
        content: result.content,
        size: result.size,
        truncated: result.truncated,
      };
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ── 变更查看(diff,只读) ──────

  /**
   * 变更查看：builtin Host 在本机 workspace 目录直跑 git；registered Host 经
   * host.* 隧道 RPC。rootPath 由 WorkspaceService 查出后传入。
   * 非 git 目录 → BadRequestException(可区分「非 git」);git 失败 → BadRequestException。
   */
  async listChangedFiles(
    runtimeHostId: string,
    rootPath: string
  ): Promise<WorkspaceChangedFilesResponse> {
    try {
      return isBuiltinHostId(runtimeHostId)
        ? await listChangedFilesDirect(rootPath)
        : await this.sendTunnelRequest<WorkspaceChangedFilesResponse>(
            runtimeHostId,
            {
              jsonrpc: "2.0",
              id: generateId(),
              method: "host.listChangedFiles",
              params: { runtimeHostId, rootPath },
            },
            this.configService.getLaunchTimeoutSeconds() * 1000
          );
    } catch (err) {
      throw this.toChangeViewError(err);
    }
  }

  /** 单文件 diff,同 listChangedFiles。 */
  async readFileDiff(
    runtimeHostId: string,
    rootPath: string,
    relativePath: string
  ): Promise<WorkspaceFileDiffResponse> {
    try {
      return isBuiltinHostId(runtimeHostId)
        ? await readFileDiffDirect(rootPath, relativePath)
        : await this.sendTunnelRequest<WorkspaceFileDiffResponse>(
            runtimeHostId,
            {
              jsonrpc: "2.0",
              id: generateId(),
              method: "host.readFileDiff",
              params: {
                runtimeHostId,
                rootPath,
                path: relativePath,
              },
            },
            this.configService.getLaunchTimeoutSeconds() * 1000
          );
    } catch (err) {
      throw this.toChangeViewError(err);
    }
  }

  /** 文件搜索(git ls-files，供 `@` 文件提及),同 listFiles。 */
  async searchFiles(
    runtimeHostId: string,
    rootPath: string
  ): Promise<WorkspaceFileSearchResponse> {
    try {
      return isBuiltinHostId(runtimeHostId)
        ? await searchFilesDirect(rootPath)
        : await this.sendTunnelRequest<WorkspaceFileSearchResponse>(
            runtimeHostId,
            {
              jsonrpc: "2.0",
              id: generateId(),
              method: "host.searchFiles",
              params: { runtimeHostId, rootPath },
            },
            this.configService.getLaunchTimeoutSeconds() * 1000
          );
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private toChangeViewError(err: unknown): BadRequestException {
    if (err instanceof NotGitRepositoryError) {
      return new BadRequestException("该工作空间不是 Git 仓库,无法查看变更");
    }
    return new BadRequestException(
      err instanceof Error ? err.message : String(err)
    );
  }

  /** 校验 runtime 对该用户可见,且(registered 时)隧道在线,否则抛异常。 */
  private async assertRuntimeReachable(
    ownerId: string,
    id: string
  ): Promise<void> {
    const owned = await this.getOwned(ownerId, id);
    if (!owned) {
      throw new NotFoundException(`runtime not found: ${id}`);
    }
    if (!isBuiltinHostId(id) && !this.tunnelHandler.isConnected(id)) {
      throw new BadRequestException(`runtime ${id} is not connected`);
    }
  }

  /**
   * 按 id 查 Runtime 行（无 owner 校验——内部/Host 契约用）。
   * Phase 2 expand：RuntimeHostAdapter.detectEnv 需要读取 runtimeType/capabilities/envConfig
   * 来构造 HostCapabilityStatus。
   */
  getRuntimeHostRow(id: string): Promise<RuntimeHostRow | null> {
    return this.repository.findById(id);
  }

  /**
   * `@agework/providers` 的 RuntimeConfig(server 配置拼装,见 local/runtime-config.ts)。
   * 供进程内 builtin RuntimeHost 构造 provider 配置。
   */
  getProviderRuntimeConfig(): RuntimeConfig {
    return toRuntimeConfig(this.configService);
  }

  // ── Phase 2 隧道公开面(对 RuntimeTunnelHandler 的薄转发)────────────
  //
  // RuntimeHostAdapter 经这里走隧道,不直接 reach
  // gateway 内部文件(模块边界:跨模块只调根 Service)。

  /** 向已建连的 registered Host 发一次隧道 RPC(host.* / launch/stop/destroy)。 */
  sendTunnelRequest<Result>(
    runtimeHostId: string,
    request: RuntimeTunnelAllRpcRequest,
    timeoutMs: number
  ): Promise<Result> {
    return this.tunnelHandler.sendRequest<Result>(
      runtimeHostId,
      request,
      timeoutMs
    );
  }

  /** 列出所有隧道在线的 registered Host id（builtin Host 不走隧道）。 */
  listConnectedRuntimeHostIds(): string[] {
    return this.tunnelHandler.listConnected();
  }

  /** 向目标 Host 发一条单向隧道通知(不等回应,不在线即丢弃,best-effort)。 */
  sendTunnelNotification(
    runtimeHostId: string,
    notification: RuntimeTunnelHostNotification
  ): void {
    this.tunnelHandler.sendNotification(runtimeHostId, notification);
  }

  /** 注册 host.upstream 通知回调(Host → server 单向回流,进程内仅一个消费者)。
   *  handler 返回 Promise 时按连接串行 await,处理完成后才向 Host 回 ACK 水位。 */
  setTunnelUpstreamHandler(
    handler: (
      runtimeHostId: string,
      notification: HostUpstreamNotification
    ) => Promise<void> | void
  ): void {
    this.tunnelHandler.setUpstreamHandler(handler);
  }

  /**
   * 获取 runtime 的 resolved CLI 路径（override > detected > null）。
   * 供 RunLauncher 对 native 类型提取 CLI 路径写入 RunConfig。
   */
  async getResolvedCliPaths(id: string): Promise<{
    claude: string | null;
    codex: string | null;
    opencode: string | null;
  } | null> {
    const row = await this.repository.findById(id);
    if (!row) return null;
    const envConfig = row.envConfig as RuntimeEnvConfig | null;
    const override = row.envConfigOverride as RuntimeEnvConfigOverride | null;
    return {
      claude: resolveAgentPath(
        override?.claude?.executablePath,
        envConfig?.claude.executablePath ?? null
      ),
      codex: resolveAgentPath(
        override?.codex?.executablePath,
        envConfig?.codex.executablePath ?? null
      ),
      opencode: resolveAgentPath(
        override?.opencode?.executablePath,
        envConfig?.opencode?.executablePath ?? null
      ),
    };
  }
}

function toRuntimeResponse(row: RuntimeHostRow): RuntimeResponse {
  const envConfig = row.envConfig as RuntimeEnvConfig | null;
  const override = row.envConfigOverride as RuntimeEnvConfigOverride | null;
  const normalizedCapabilities = row.capabilities
    ? normalizeRuntimeCapabilities(row.capabilities)
    : null;
  const capabilities =
    normalizedCapabilities && Object.keys(normalizedCapabilities).length > 0
      ? normalizedCapabilities
      : null;
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    ownerId: row.ownerId,
    status: row.status === "online" ? "online" : "offline",
    capabilities,
    envConfig,
    envConfigOverride: override,
    envStatus: envConfig ? computeEnvStatus(envConfig, override) : null,
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** override + detected 合并出展示层 envStatus（见 ADR-0002）。 */
function computeEnvStatus(
  detected: RuntimeEnvConfig,
  override: RuntimeEnvConfigOverride | null
): RuntimeResponse["envStatus"] {
  return {
    claude: mergeAgent(
      detected.claude,
      override?.claude?.executablePath ?? null
    ),
    codex: mergeAgent(detected.codex, override?.codex?.executablePath ?? null),
    opencode: mergeAgent(
      detected.opencode,
      override?.opencode?.executablePath ?? null
    ),
    detectedAt: detected.detectedAt,
  };
}

function mergeAgent(
  detected: RuntimeEnvConfig["claude"],
  overridePath: string | null
): AgentEnvStatus {
  const resolvedPath = overridePath ?? detected.executablePath;
  return {
    resolvedPath,
    source: overridePath ? "custom" : "system",
    detectedPath: detected.executablePath,
    version: detected.version,
  };
}

/** native 没有容器,只允许 workspace 范围的独占子进程;docker/opensandbox 有容器
 *  边界兜底,支持 user/workspace 两种复用范围。 */
function runtimeTypeScopes(runtimeType: RuntimeType): WorkerScope[] {
  return runtimeType === "native" ? ["workspace"] : ["user", "workspace"];
}

function isPrismaUniqueError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/** per-agent 合并 override：空字符串 = 清除该 agent 的覆盖。 */
function mergeOverride(
  current: RuntimeEnvConfigOverride | null,
  agentType: AgentType,
  executablePath: string
): RuntimeEnvConfigOverride {
  const result: RuntimeEnvConfigOverride = { ...(current ?? {}) };
  const key = agentType;
  if (!executablePath) {
    delete result[key];
  } else {
    result[key] = { executablePath };
  }
  return result;
}

function resolveAgentPath(
  overridePath: string | undefined,
  detectedPath: string | null
): string | null {
  return overridePath ?? detectedPath ?? null;
}
