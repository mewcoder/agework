import { LocalRuntimeProvider } from "./local/local-runtime.provider";
import { DockerRuntimeProvider } from "./docker/docker-runtime.provider";
import { OpenSandboxRuntimeProvider } from "./opensandbox/opensandbox-runtime.provider";
import type { RuntimeConfig, RuntimeProvider, RuntimeType } from "./types";

/**
 * 由 server 喂入的 config 构造三个 peer provider(建一次、进程内长活),返回一个
 * 「按 runtimeType 取实现」的 resolver 函数——取不到当场抛。这是包的唯一"装配"出口:
 * 具体 provider 类与内部 Map 都不导出,server 只经此拿到 (type) => RuntimeProvider。
 * 每个 provider 直接吃整份 RuntimeConfig,自己取需要的字段,resolver 不预拆 config。
 */
export function createRuntimeResolver(
  cfg: RuntimeConfig
): (type: RuntimeType) => RuntimeProvider {
  const providers = new Map<RuntimeType, RuntimeProvider>([
    ["local", new LocalRuntimeProvider(cfg)],
    ["docker", new DockerRuntimeProvider(cfg)],
    ["opensandbox", new OpenSandboxRuntimeProvider(cfg)],
  ]);
  return (type) => {
    const provider = providers.get(type);
    if (!provider) {
      throw new Error(`Unknown runtime provider: ${type}`);
    }
    return provider;
  };
}
