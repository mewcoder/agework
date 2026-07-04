import { LocalRuntimeProvider } from "./local/local-runtime.provider";
import { DockerRuntimeProvider } from "./docker/docker-runtime.provider";
import { OpenSandboxRuntimeProvider } from "./opensandbox/opensandbox-runtime.provider";
import { OpenSandboxClient } from "./opensandbox/opensandbox-client";
import type {
  RuntimeConfig,
  RuntimeProvider,
  RuntimeType,
  SandboxProviderConfig,
} from "./types";

/**
 * 由 server 喂入的 config 构造三个 peer provider,返回 type → provider 的映射表。
 * 这是包的唯一"装配"出口——具体 provider 类不导出,server 只经此拿到 RuntimeProvider 接口实例。
 */
export function createRuntimeProviders(
  cfg: RuntimeConfig
): Map<RuntimeType, RuntimeProvider> {
  const sandboxConfig: SandboxProviderConfig = {
    workerImage: cfg.workerImage,
    runtimeLogHostPath: cfg.runtimeLogHostPath,
    apiBaseUrl: cfg.containerApiBaseUrl,
  };
  const providers: RuntimeProvider[] = [
    new LocalRuntimeProvider(cfg.local),
    new DockerRuntimeProvider(sandboxConfig),
    new OpenSandboxRuntimeProvider(
      sandboxConfig,
      new OpenSandboxClient(cfg.openSandbox)
    ),
  ];
  return new Map(providers.map((p) => [p.type, p]));
}
