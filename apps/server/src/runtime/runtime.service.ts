import { Injectable } from "@nestjs/common";
import type { RuntimeSpec } from "@agework/shared/protocol";
import { resolveRuntimeSpec, type RuntimeSpecInput } from "@agework/providers";
import { ConfigService } from "../config/config.service";
import { LocalRuntime } from "./local/local-runtime";
import type { Runtime } from "./runtime.types";

/**
 * Runtime 领域门面:解析目标 `Runtime` 实现 + placement 计算 + 运行时策略。
 * 起/停/毁 worker 的具体分发在 `Runtime` 实现内(见 `runtime.types.ts`)。
 */
@Injectable()
export class RuntimeService {
  constructor(
    private readonly configService: ConfigService,
    private readonly localRuntime: LocalRuntime
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
}
