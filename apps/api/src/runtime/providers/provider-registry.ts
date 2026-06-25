import { Inject, Injectable } from "@nestjs/common";
import type { RuntimeProvider } from "./provider-contracts";
import type { RunEventReceiver } from "../run-event-receiver";
import { RUNTIME_PROVIDERS } from "./provider.token";

@Injectable()
export class RuntimeProviderRegistry {
  private readonly providers: Map<string, RuntimeProvider>;

  constructor(@Inject(RUNTIME_PROVIDERS) providers: RuntimeProvider[]) {
    this.providers = new Map(providers.map((p) => [p.type, p]));
  }

  resolve(type: string): RuntimeProvider {
    const provider = this.providers.get(type);
    if (!provider) {
      throw new Error(`Unknown runtime provider: ${type}`);
    }
    return provider;
  }

  all(): RuntimeProvider[] {
    return [...this.providers.values()];
  }

  /** 由 run 层在启动时注入 receiver 到所有 provider。 */
  setRunEventReceiver(receiver: RunEventReceiver): void {
    for (const provider of this.providers.values()) {
      provider.setRunEventReceiver(receiver);
    }
  }
}