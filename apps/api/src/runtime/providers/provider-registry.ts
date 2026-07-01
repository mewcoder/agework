import { Inject, Injectable } from "@nestjs/common";
import type { RuntimeProvider } from "./provider-contracts";

const LOCAL_RUNTIME_PROVIDER: RuntimeProvider = {
  type: "local",
  async recoverOrphan(): Promise<void> {
    // local 没有持久 runtime resource；残留 DB 行只需要上层标记 stopped。
  },
  shutdownRuntimeInstanceByOwnerId(): void {
    // no-op
  },
};

/**
 * DI token：聚合所有已注册的 runtime instance manager 实现。
 * 新增 runtime resource 类型时，只需新建一个实现类并加入 runtime.module.ts
 * 的 providers 数组与本 token 的 inject 列表，registry 不再需要改动。
 */
export const RUNTIME_PROVIDERS = Symbol("RUNTIME_PROVIDERS");

@Injectable()
export class RuntimeProviderRegistry {
  private readonly providers: Map<string, RuntimeProvider>;

  constructor(@Inject(RUNTIME_PROVIDERS) providers: RuntimeProvider[]) {
    this.providers = new Map(providers.map((p) => [p.type, p]));
  }

  resolve(type: string): RuntimeProvider {
    if (type === "local") return LOCAL_RUNTIME_PROVIDER;
    const provider = this.providers.get(type);
    if (!provider) {
      throw new Error(`Unknown runtime provider: ${type}`);
    }
    return provider;
  }

  all(): RuntimeProvider[] {
    return [...this.providers.values()];
  }
}
