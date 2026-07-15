import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { type AgentType } from "@agework/shared";
import type {
  RuntimeCapabilities,
  RuntimeHostOperations,
  RuntimeSpec,
  WorkerScope,
} from "@agework/shared/protocol";
import { normalizeRuntimeCapabilities } from "@agework/shared/protocol";
import type {
  CreateHostDirectoryResponse,
  CreateRuntimeHostResponse,
  DetectEnvResponse,
  HostDirectoryResponse,
  RuntimeEnvConfig,
  RuntimeHostEnvConfigOverride,
  AgentEnvStatus,
  RuntimeHostResponse,
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
  WorkspaceFileSearchResponse,
} from "@agework/shared/api";
import { resolveRuntimeSpec, type RuntimeSpecInput } from "@agework/providers";
import type { RuntimeType } from "@agework/providers";
import { ConfigService } from "../config/config.service";
import { RuntimeHostRepository } from "./runtime-host.repository";
import type { RuntimeHostRow } from "./runtime-host.types";
import { HostTunnelHandler } from "./gateway/host-tunnel.handler";
import {
  BUILTIN_HOST_ID,
  isBuiltinHostId,
  RUNTIME_HOST_OPERATIONS,
} from "./runtime-host.types";
import { resolveRuntimeHostCliPaths } from "./environment/runtime-host-environment";

/**
 * RuntimeHost 根门面：管理注册、placement 与环境结果持久化，并编排 Host 用例。
 * 所有执行机动作统一经 RuntimeHostOperations；本类不自行访问执行机或拼隧道 RPC。
 */
@Injectable()
export class RuntimeHostService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RuntimeHostService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly repository: RuntimeHostRepository,
    private readonly tunnelHandler: HostTunnelHandler,
    @Inject(RUNTIME_HOST_OPERATIONS)
    private readonly operations: RuntimeHostOperations
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
      const envConfig = (await this.operations.detectEnv(BUILTIN_HOST_ID))
        .native?.cli;
      if (envConfig) {
        await this.repository.updateEnvConfig(BUILTIN_HOST_ID, envConfig);
      }
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

  /** 创建 Registered Runtime 并生成配对 token。token 明文只在本次响应出现,库里只存 sha256。 */
  async create(
    ownerId: string,
    name: string
  ): Promise<CreateRuntimeHostResponse> {
    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    try {
      const row = await this.repository.create({ ownerId, name, tokenHash });
      return { runtimeHost: toRuntimeHostResponse(row), token };
    } catch (err) {
      if (isPrismaUniqueError(err)) {
        throw new ConflictException(`runtime name already exists: ${name}`);
      }
      throw err;
    }
  }

  /** 列出当前用户可见的 Host：自己的 registered + 全局 builtin。 */
  async list(ownerId: string): Promise<{ list: RuntimeHostResponse[] }> {
    const rows = await this.repository.listVisibleToOwner(ownerId);
    return { list: rows.map(toRuntimeHostResponse) };
  }

  /** admin: 列出全部 Host（builtin + 所有用户的 registered），不含已注销。 */
  async listForAdmin(): Promise<{ list: RuntimeHostResponse[] }> {
    const rows = await this.repository.listAll();
    return { list: rows.map(toRuntimeHostResponse) };
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
      current.envConfigOverride as RuntimeHostEnvConfigOverride | null,
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
    if (!isBuiltinHostId(id) && !this.tunnelHandler.isConnected(id)) {
      throw new BadRequestException(`runtime ${id} is not connected`);
    }
    const { executablePath } = await this.operations.installCli({
      runtimeHostId: id,
      agentType,
    });
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
    const row = await this.repository.findById(id);
    if (!row) {
      throw new NotFoundException(`runtime not found: ${id}`);
    }
    // registered 未连接:不是错误,只是此刻无法检测(前端按离线展示)
    if (!this.tunnelHandler.isConnected(id) && !isBuiltinHostId(id)) {
      return { envConfig: null };
    }
    let envConfig: RuntimeEnvConfig | undefined;
    try {
      envConfig = (await this.operations.detectEnv(id)).native?.cli;
    } catch (err) {
      // 检测/RPC 失败与「未检出 CLI」是两回事,失败要让调用方看见
      throw new BadRequestException(
        `detect-env for runtime ${id} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!envConfig) return { envConfig: null };
    await this.repository.updateEnvConfig(id, envConfig);
    return { envConfig };
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
  ): Promise<HostDirectoryResponse> {
    await this.assertRuntimeReachable(ownerId, id);
    try {
      const result = await this.operations.listDirectory({
        runtimeHostId: id,
        path,
      });
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
  ): Promise<CreateHostDirectoryResponse> {
    await this.assertRuntimeReachable(ownerId, id);
    try {
      await this.operations.createDirectory({ runtimeHostId: id, path });
      return { path };
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ── 文件预览 ───────────────────────────────────────────────────────

  /**
   * 文件操作统一下调 RuntimeHostOperations；rootPath 由 WorkspaceService 查出后传入。
   * builtin / registered 分流与路径安全校验由执行面实现负责。
   */
  async listFiles(
    runtimeHostId: string,
    rootPath: string,
    relativePath: string
  ): Promise<WorkspaceFileListResponse> {
    try {
      return await this.operations.listFiles({
        runtimeHostId,
        rootPath,
        path: relativePath,
      });
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
      return await this.operations.readFile({
        runtimeHostId,
        rootPath,
        path: relativePath,
      });
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ── 变更查看(diff,只读) ──────

  /**
   * 变更查看统一下调 RuntimeHostOperations，rootPath 由 WorkspaceService 查出后传入。
   * 执行面错误统一映射为 BadRequestException。
   */
  async listChangedFiles(
    runtimeHostId: string,
    rootPath: string
  ): Promise<WorkspaceChangedFilesResponse> {
    try {
      return await this.operations.listChangedFiles({
        runtimeHostId,
        rootPath,
      });
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
      return await this.operations.readFileDiff({
        runtimeHostId,
        rootPath,
        path: relativePath,
      });
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
      return await this.operations.searchFiles({ runtimeHostId, rootPath });
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private toChangeViewError(err: unknown): BadRequestException {
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

  /** 按 id 查 RuntimeHost 行（无 owner 校验，供 server 内部恢复流程使用）。 */
  getRuntimeHostRow(id: string): Promise<RuntimeHostRow | null> {
    return this.repository.findById(id);
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
    return resolveRuntimeHostCliPaths(row);
  }
}

function toRuntimeHostResponse(row: RuntimeHostRow): RuntimeHostResponse {
  const envConfig = row.envConfig as RuntimeEnvConfig | null;
  const override = row.envConfigOverride as RuntimeHostEnvConfigOverride | null;
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
  override: RuntimeHostEnvConfigOverride | null
): RuntimeHostResponse["envStatus"] {
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
  current: RuntimeHostEnvConfigOverride | null,
  agentType: AgentType,
  executablePath: string
): RuntimeHostEnvConfigOverride {
  const result: RuntimeHostEnvConfigOverride = { ...(current ?? {}) };
  const key = agentType;
  if (!executablePath) {
    delete result[key];
  } else {
    result[key] = { executablePath };
  }
  return result;
}
