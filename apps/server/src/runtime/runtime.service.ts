import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { RuntimeSpec } from "@agework/shared/protocol";
import type {
  CreateRuntimeResponse,
  RuntimeResponse,
} from "@agework/shared/api";
import { resolveRuntimeSpec, type RuntimeSpecInput } from "@agework/providers";
import { ConfigService, type RuntimeType } from "../config/config.service";
import { LocalRuntime } from "./local/local-runtime";
import { RemoteRuntime } from "./remote/remote-runtime";
import { RuntimeRepository, type RuntimeRow } from "./runtime.repository";
import { RuntimeTunnelHandler } from "./gateway/runtime-tunnel.handler";
import type { Runtime } from "./runtime.types";
import { builtinRuntimeId, isBuiltinRuntimeId } from "./runtime.types";

/**
 * Runtime 领域门面:解析目标 `Runtime` 实现 + placement 计算 + 运行时策略
 * + Registered Runtime 的配对管理(create/list/revoke)+ builtin Runtime 的注册表。
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

  /** 启动时按部署允许的 runtimeType upsert 对应的 builtin Runtime 行(id 固定,幂等)。 */
  async onApplicationBootstrap(): Promise<void> {
    for (const runtimeType of this.configService.getAllowedRuntimeTypes()) {
      await this.upsertBuiltin(runtimeType, {
        isolationScopes: builtinIsolationScopes(runtimeType),
      });
    }
    this.logger.log(
      `builtin runtimes ready: ${this.configService.getAllowedRuntimeTypes().join(", ")}`
    );
  }

  /**
   * 解析目标 `Runtime` 实现(server 起/停/毁 worker 的唯一入口)。builtin id
   * (本机 in-process)→ Managed;其余 → Registered,经隧道转 RPC 给对应 manager。
   * RemoteRuntime 每次都新建,不持有连接本身(连接归 RuntimeTunnelHandler 管),
   * 构造零开销。
   */
  runtimeFor(runtimeId: string): Runtime {
    if (isBuiltinRuntimeId(runtimeId)) {
      return this.localRuntime;
    }
    return new RemoteRuntime(
      runtimeId,
      this.tunnelHandler,
      this.configService.getLaunchTimeoutSeconds() * 1000
    );
  }

  /** 是否是 builtin(本机 in-process)Runtime id。供上层判断 Managed/Registered。 */
  isManaged(runtimeId: string): boolean {
    return isBuiltinRuntimeId(runtimeId);
  }

  /** builtin Runtime 的固定 id(不查库,纯计算)。供 workspace 创建时解析目标 runtimeId。 */
  getBuiltinRuntimeId(runtimeType: RuntimeType): string {
    return builtinRuntimeId(runtimeType);
  }

  /** 从 run 输入解析出目标运行环境(纯计算,不启动 worker;默认值由 run 层补齐)。 */
  resolveRuntimeSpec(input: RuntimeSpecInput): RuntimeSpec {
    return resolveRuntimeSpec(input);
  }

  /** 返回当前运行时策略配置(默认/可选 runtimeType、isolationScope、空闲超时秒数),供前端展示与校验用。 */
  getRuntimePolicy() {
    return {
      runtimeType: this.configService.getDefaultRuntimeType(),
      allowedRuntimeTypes: this.configService.getAllowedRuntimeTypes(),
      isolationScope: this.configService.getDefaultIsolationScope(),
      allowedIsolationScopes: this.configService.getAllowedIsolationScopes(),
      idleTimeoutSeconds: this.configService.getIdleTimeoutSeconds(),
    };
  }

  /** 服务启动时 upsert 一个 builtin Runtime 行(id 固定,幂等)。 */
  private upsertBuiltin(
    runtimeType: RuntimeType,
    capabilities: { isolationScopes: string[] }
  ) {
    return this.repository.upsertBuiltin({
      id: builtinRuntimeId(runtimeType),
      name: builtinRuntimeId(runtimeType),
      runtimeType,
      capabilities,
    });
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

  /** 列出当前用户可见的 Runtime:自己的 Registered + 全局 builtin。 */
  async list(ownerId: string): Promise<{ list: RuntimeResponse[] }> {
    const rows = await this.repository.listVisibleToOwner(ownerId);
    return { list: rows.map(toRuntimeResponse) };
  }

  /**
   * 查询 Runtime 是否存在且对该用户可见(自己的 Registered 或全局 builtin,且未注销);
   * 返回 null 表示不存在/不可见/已注销。供上层入口(如创建 workspace 时校验目标 runtime)
   * 做归属校验,由调用方决定如何处理 null。
   */
  getOwned(ownerId: string, id: string): Promise<RuntimeRow | null> {
    return this.repository.findVisibleToOwner(ownerId, id);
  }

  /**
   * 注销 Runtime(撤 token,软删除,行永久保留):只拦"以后不能再绑定新 workspace",
   * 不主动踢断在线隧道连接——这台机器上可能还有活跃 Worker 在跑,断连接等于强制判死,
   * 跟"放任其自然结束"的设计矛盾(见 runtime 模块 ADR-0001)。连接的存活/掉线继续按
   * 心跳机制走,不因注销而改变。builtin 行 ownerId=null,不会匹配任何真实 userId,
   * 天然不可被此方法注销。
   */
  async delete(ownerId: string, id: string): Promise<void> {
    const revoked = await this.repository.revokeByOwner(ownerId, id);
    if (!revoked) {
      throw new NotFoundException(`runtime not found: ${id}`);
    }
  }
}

function toRuntimeResponse(row: RuntimeRow): RuntimeResponse {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    ownerId: row.ownerId,
    runtimeType: row.runtimeType,
    status: row.status === "online" ? "online" : "offline",
    capabilities:
      (row.capabilities as RuntimeResponse["capabilities"] | null) ?? null,
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** local 没有容器,没有隔离概念,只有 workspace 独占子进程;docker/opensandbox 都有容器
 *  边界兜底,user 级共享安全,两种隔离都支持。 */
function builtinIsolationScopes(runtimeType: RuntimeType): string[] {
  return runtimeType === "local" ? ["workspace"] : ["user", "workspace"];
}

function isPrismaUniqueError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}
