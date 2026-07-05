import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { RuntimeSpec } from "@agework/shared/protocol";
import type {
  CreateRuntimeResponse,
  RuntimeResponse,
} from "@agework/shared/api";
import { resolveRuntimeSpec, type RuntimeSpecInput } from "@agework/providers";
import { ConfigService } from "../config/config.service";
import { LocalRuntime } from "./local/local-runtime";
import { RuntimeRepository, type RuntimeRow } from "./runtime.repository";
import { RuntimeTunnelHandler } from "./gateway/runtime-tunnel.handler";
import type { Runtime } from "./runtime.types";

/**
 * Runtime 领域门面:解析目标 `Runtime` 实现 + placement 计算 + 运行时策略
 * + Registered Runtime 的配对管理(create/list/delete)。
 * 起/停/毁 worker 的具体分发在 `Runtime` 实现内(见 `runtime.types.ts`)。
 */
@Injectable()
export class RuntimeService {
  constructor(
    private readonly configService: ConfigService,
    private readonly localRuntime: LocalRuntime,
    private readonly repository: RuntimeRepository,
    private readonly tunnelHandler: RuntimeTunnelHandler
  ) {}

  /**
   * 解析目标 `Runtime` 实现(server 起/停/毁 worker 的唯一入口)。
   * `runtimeId=null` = Managed(本机 in-process,现状唯一路径);
   * 非 null 的 Registered runtime(`RemoteRuntime`)Phase 2 接入。
   */
  runtimeFor(runtimeId: string | null): Runtime {
    if (runtimeId !== null) {
      throw new Error(`Registered runtime not supported yet: ${runtimeId}`);
    }
    return this.localRuntime;
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

  /** 列出当前用户的 Registered Runtime。 */
  async list(ownerId: string): Promise<{ list: RuntimeResponse[] }> {
    const rows = await this.repository.listByOwner(ownerId);
    return { list: rows.map(toRuntimeResponse) };
  }

  /** 删除 Runtime(撤 token):踢掉在线隧道连接,manager 收 4410 退出、不再重连。 */
  async delete(ownerId: string, id: string): Promise<void> {
    const deleted = await this.repository.deleteByOwner(ownerId, id);
    if (!deleted) {
      throw new NotFoundException(`runtime not found: ${id}`);
    }
    this.tunnelHandler.closeConnection(id);
  }
}

function toRuntimeResponse(row: RuntimeRow): RuntimeResponse {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    runtimeType: row.runtimeType,
    status: row.status === "online" ? "online" : "offline",
    capabilities:
      (row.capabilities as RuntimeResponse["capabilities"] | null) ?? null,
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function isPrismaUniqueError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}
