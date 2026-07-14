import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { type AgentType } from "@agework/shared";
import type {
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
import type { RuntimeConfig } from "@agework/providers";
import { ConfigService, type RuntimeType } from "../config/config.service";
import { LocalRuntime } from "./local/local-runtime";
import { toRuntimeConfig } from "./local/runtime-config";
import { RemoteRuntime } from "./remote/remote-runtime";
import { RuntimeRepository, type RuntimeHostRow } from "./runtime.repository";
import { RuntimeTunnelHandler } from "./gateway/runtime-tunnel.handler";
import type { Runtime } from "./runtime.types";
import { BUILTIN_HOST_ID, isBuiltinHostId } from "./runtime.types";

/**
 * Runtime 领域门面:解析目标 `Runtime` 实现 + placement 计算 + 运行时策略
 * + Registered Runtime 的配对管理(create/list/revoke)+ managed Runtime 的注册表。
 * 起/停/毁 worker 的具体分发在 `Runtime` 实现内(见 `runtime.types.ts`)。
 */
@Injectable()
export class RuntimeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RuntimeService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly localRuntime: LocalRuntime,
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
      const envConfig = await this.localRuntime.detectEnv();
      await this.repository.updateEnvConfig(BUILTIN_HOST_ID, envConfig);
    }
    this.logger.log(
      `builtin Runtime Host ready: ${allowedRuntimeTypes.join(", ")}`
    );
  }

  /**
   * 解析目标 `Runtime` 实现(server 起/停/毁 worker 的唯一入口)。
   * - managed-native:LocalRuntime(进程内直读)。
   * - managed-docker/opensandbox + registered:RemoteRuntime(隧道 RPC)。
   * RemoteRuntime 每次都新建,不持有连接本身(连接归 RuntimeTunnelHandler 管),
   * 构造零开销。
   */
  runtimeFor(runtimeId: string): Runtime {
    if (isBuiltinHostId(runtimeId)) {
      return this.localRuntime;
    }
    return new RemoteRuntime(
      runtimeId,
      this.tunnelHandler,
      this.configService.getLaunchTimeoutSeconds() * 1000
    );
  }

  /** 是否是 managed(本机 in-process)Runtime id。供上层判断 Managed/Registered。 */
  isManaged(runtimeId: string): boolean {
    return isBuiltinHostId(runtimeId);
  }

  /** managed Runtime 的固定 id(不查库,纯计算)。供 workspace 创建时解析目标 runtimeId。 */
  getManagedRuntimeId(_runtimeType: RuntimeType): string {
    return BUILTIN_HOST_ID;
  }

  /** 从 run 输入解析出目标运行环境(纯计算,不启动 worker;默认值由 run 层补齐)。 */
  resolveRuntimeSpec(input: RuntimeSpecInput): RuntimeSpec {
    return resolveRuntimeSpec(input);
  }

  /** 返回当前运行时策略配置(默认/可选 runtimeType、scope、空闲超时秒数),供前端展示与校验用。 */
  getRuntimePolicy() {
    return {
      runtimeType: this.configService.getDefaultRuntimeType(),
      allowedRuntimeTypes: this.configService.getAllowedRuntimeTypes(),
      scope: this.configService.getDefaultIsolationScope(),
      allowedIsolationScopes: this.configService.getAllowedIsolationScopes(),
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

  /** 列出当前用户可见的 Runtime:自己的 Registered + 全局 managed。 */
  async list(ownerId: string): Promise<{ list: RuntimeResponse[] }> {
    const rows = await this.repository.listVisibleToOwner(ownerId);
    return { list: rows.map(toRuntimeResponse) };
  }

  /** admin: 列出全部 Runtime(managed + 所有用户的 registered),不含已注销。 */
  async listAll(): Promise<{ list: RuntimeResponse[] }> {
    const rows = await this.repository.listAll();
    return { list: rows.map(toRuntimeResponse) };
  }

  /**
   * 查询 Runtime 是否存在且对该用户可见(自己的 Registered 或全局 managed,且未注销);
   * 返回 null 表示不存在/不可见/已注销。供上层入口(如创建 workspace 时校验目标 runtime)
   * 做归属校验,由调用方决定如何处理 null。
   */
  getOwned(ownerId: string, id: string): Promise<RuntimeHostRow | null> {
    return this.repository.findVisibleToOwner(ownerId, id);
  }

  /**
   * 注销 Runtime(撤 token,软删除,行永久保留):只拦"以后不能再绑定新 workspace",
   * 不主动踢断在线隧道连接——这台机器上可能还有活跃 Worker 在跑,断连接等于强制判死,
   * 跟"放任其自然结束"的设计矛盾(见 runtime 模块 ADR-0001)。连接的存活/掉线继续按
   * 心跳机制走,不因注销而改变。managed 行 ownerId=null,不会匹配任何真实 userId,
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
    const executablePath = await this.localRuntime.installCli(agentType);
    await this.updateEnvConfigOverride(id, agentType, executablePath);
    return this.detectEnv(id);
  }

  /**
   * 管理员触发 runtime 重新检测 CLI 环境。
   * - managed runtime: LocalRuntime 进程内检测。
   * - registered runtime: 通过隧道发 detect-env RPC,manager 重检后返回新 envConfig。
   *   runtime 未连接时返回 null。
   */
  async detectEnv(id: string): Promise<DetectEnvResponse> {
    if (!this.tunnelHandler.isConnected(id) && !isBuiltinHostId(id)) {
      return { envConfig: null };
    }
    try {
      const envConfig = await this.runtimeFor(id).detectEnv();
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
      const result = await this.runtimeFor(id).listDirectory(path);
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
      return await this.runtimeFor(id).createDirectory(path);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ── 文件预览(ADR-0005: managed native 直读, docker/opensandbox/registered 隧道 RPC) ─────

  /**
   * 文件预览直读:managed native 在 server 进程内直读本机硬盘;docker/opensandbox/
   * registered 经隧道 RPC 调 runtime 进程。安全校验复用 shared/fileBrowser(与
   * worker 同一份代码)。rootPath 由 WorkspaceService 查出后传入。
   */
  async listFiles(
    runtimeId: string,
    rootPath: string,
    relativePath: string
  ): Promise<WorkspaceFileListResponse> {
    try {
      return await this.runtimeFor(runtimeId).listFiles(rootPath, relativePath);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /** 文件预览直读(ADR-0005),同 listFiles。 */
  async readFile(
    runtimeId: string,
    rootPath: string,
    relativePath: string
  ): Promise<WorkspaceFileReadResponse> {
    try {
      return await this.runtimeFor(runtimeId).readFile(rootPath, relativePath);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ── 变更查看(diff,只读) ──────

  /**
   * 变更查看:managed native 在本机 workspace 目录直跑 git;docker/opensandbox/
   * registered 经隧道 RPC 调 runtime 进程。rootPath 由 WorkspaceService 查出后传入。
   * 非 git 目录 → BadRequestException(可区分「非 git」);git 失败 → BadRequestException。
   */
  async listChangedFiles(
    runtimeId: string,
    rootPath: string
  ): Promise<WorkspaceChangedFilesResponse> {
    try {
      return await this.runtimeFor(runtimeId).listChangedFiles(rootPath);
    } catch (err) {
      throw this.toChangeViewError(err);
    }
  }

  /** 单文件 diff,同 listChangedFiles。 */
  async readFileDiff(
    runtimeId: string,
    rootPath: string,
    relativePath: string
  ): Promise<WorkspaceFileDiffResponse> {
    try {
      return await this.runtimeFor(runtimeId).readFileDiff(
        rootPath,
        relativePath
      );
    } catch (err) {
      throw this.toChangeViewError(err);
    }
  }

  /** 文件搜索(git ls-files，供 `@` 文件提及),同 listFiles。 */
  async searchFiles(
    runtimeId: string,
    rootPath: string
  ): Promise<WorkspaceFileSearchResponse> {
    try {
      return await this.runtimeFor(runtimeId).searchFiles(rootPath);
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
   * Phase 2:worker-manager 侧进程内 RuntimeHost(managed-native)构造时用。
   */
  getProviderRuntimeConfig(): RuntimeConfig {
    return toRuntimeConfig(this.configService);
  }

  // ── Phase 2 隧道公开面(对 RuntimeTunnelHandler 的薄转发)────────────
  //
  // worker-manager 的 RuntimeHostAdapter 经这里走隧道,不直接 reach
  // gateway 内部文件(模块边界:跨模块只调根 Service)。

  /** 向已建连的 registered Host 发一次隧道 RPC(host.* / launch/stop/destroy)。 */
  sendTunnelRequest<Result>(
    runtimeId: string,
    request: RuntimeTunnelAllRpcRequest,
    timeoutMs: number
  ): Promise<Result> {
    return this.tunnelHandler.sendRequest<Result>(
      runtimeId,
      request,
      timeoutMs
    );
  }

  /** 列出所有隧道在线的 runtime id(managed-native 不走隧道,不会出现在结果里)。 */
  listConnectedRuntimeIds(): string[] {
    return this.tunnelHandler.listConnected();
  }

  /** 向目标 Host 发一条单向隧道通知(不等回应,不在线即丢弃,best-effort)。 */
  sendTunnelNotification(
    runtimeId: string,
    notification: RuntimeTunnelHostNotification
  ): void {
    this.tunnelHandler.sendNotification(runtimeId, notification);
  }

  /** 注册 host.upstream 通知回调(Host → server 单向回流,进程内仅一个消费者)。
   *  handler 返回 Promise 时按连接串行 await,处理完成后才向 Host 回 ACK 水位。 */
  setTunnelUpstreamHandler(
    handler: (
      runtimeId: string,
      notification: HostUpstreamNotification
    ) => Promise<void> | void
  ): void {
    this.tunnelHandler.setUpstreamHandler(handler);
  }

  /**
   * 获取 runtime 的 resolved CLI 路径（override > detected > null）。
   * 供 RunLauncher 对 local 类型提取 CLI 路径写入 RunConfig。
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

/** native 没有容器,没有隔离概念,只有 workspace 独占子进程;docker/opensandbox 都有容器
 *  边界兜底,user 级共享安全,两种隔离都支持。 */
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
