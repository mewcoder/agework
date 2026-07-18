import { NativeRuntimeProvider } from "./native/native-runtime.provider";
import { DockerRuntimeProvider } from "./docker/docker-runtime.provider";
import type {
  RuntimeProvider,
  RuntimeProviderPlugin,
  RuntimeType,
} from "@agework/runtime-sdk";
import { RUNTIME_PLUGIN_API_VERSION } from "@agework/runtime-sdk";
import type { RuntimeHostProviderConfig } from "./types";
import { toRuntimeProviderConfig } from "./types";

/**
 * 由 Host 喂入的 config 构造内建 provider，再装配可选插件(建一次、进程内长活),返回一个
 * 「按 runtimeType 取实现」的 resolver 函数——取不到当场抛。这是包的唯一"装配"出口:
 * 具体内建 provider 类与内部 Map 都不导出,Host 只经此拿到 (type) => RuntimeProvider。
 */
export function createRuntimeResolver(
  cfg: RuntimeHostProviderConfig,
  plugins: RuntimeProviderPlugin[] = [],
  configuredRuntimeTypes: readonly string[] = []
): (type: RuntimeType) => RuntimeProvider {
  const providers = new Map<RuntimeType, RuntimeProvider>([
    ["native", new NativeRuntimeProvider(cfg)],
    ["docker", new DockerRuntimeProvider(toRuntimeProviderConfig(cfg))],
  ]);
  for (const plugin of plugins) {
    if (plugin.apiVersion !== RUNTIME_PLUGIN_API_VERSION) {
      throw new Error(
        `Unsupported runtime plugin API version for ${plugin.type}: ${plugin.apiVersion}`
      );
    }
    if (providers.has(plugin.type)) {
      throw new Error(`Duplicate runtime provider: ${plugin.type}`);
    }
    const provider = plugin.create(toRuntimeProviderConfig(cfg));
    if (provider.type !== plugin.type) {
      throw new Error(
        `Runtime provider plugin type mismatch: declared ${plugin.type}, created ${provider.type}`
      );
    }
    providers.set(plugin.type, provider);
  }
  for (const type of configuredRuntimeTypes) {
    if (!providers.has(type)) {
      throw new Error(`Runtime provider is configured but not loaded: ${type}`);
    }
  }
  return (type) => {
    const provider = providers.get(type);
    if (!provider) {
      throw new Error(`Unknown runtime provider: ${type}`);
    }
    return provider;
  };
}
