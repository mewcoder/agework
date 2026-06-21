import { Inject, Injectable } from "@nestjs/common";
import type { RuntimeProvider } from "@agework/shared/protocol";
import { RUNTIME_PROVIDERS } from "./runtime-provider.token";

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
}