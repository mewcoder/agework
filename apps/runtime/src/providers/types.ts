import type { RuntimeProviderConfig } from "@agework/runtime-sdk";

export const BUILTIN_RUNTIME_TYPES = ["native", "docker"] as const;
export type BuiltinRuntimeType = (typeof BUILTIN_RUNTIME_TYPES)[number];

export type NativeProviderConfig = {
  /** agework-runtime-host 产物入口；provider 以 worker role fork 同一 bundle。 */
  runtimeEntryPath: string;
};

/** Runtime Host 的内建配置；插件只会收到其中的通用 RuntimeProviderConfig 部分。 */
export type RuntimeHostProviderConfig = RuntimeProviderConfig & {
  native: NativeProviderConfig;
};

export function toRuntimeProviderConfig(
  config: RuntimeHostProviderConfig
): RuntimeProviderConfig {
  return {
    workerImage: config.workerImage,
    runtimeLogHostPath: config.runtimeLogHostPath,
    workerApiBaseUrl: config.workerApiBaseUrl,
  };
}
