import type {
  RuntimeProviderPlugin,
  RuntimeType,
} from "@agework/runtime-sdk";
import { defineRuntimePlugin } from "@agework/runtime-sdk";
import { OpenSandboxRuntimeProvider } from "./opensandbox-runtime.provider";
import type { OpenSandboxConnectionConfig } from "./types";
import { resolveOpenSandboxConnectionConfig } from "./config";

export const OPENSANDBOX_RUNTIME_TYPE = "opensandbox" satisfies RuntimeType;

/** 创建延迟实例化的 OpenSandbox runtime 插件描述。 */
export function createOpenSandboxRuntimePlugin(
  connectionConfig: OpenSandboxConnectionConfig
): RuntimeProviderPlugin {
  return defineRuntimePlugin({
    apiVersion: 1,
    type: OPENSANDBOX_RUNTIME_TYPE,
    displayName: "OpenSandbox",
    scopes: ["user", "workspace"],
    probe: async () => {
      try {
        const response = await fetch(
          `${connectionConfig.protocol}://${connectionConfig.domain}/health`
        );
        return response.ok
          ? { available: true }
          : {
              available: false,
              reason: `OpenSandbox health check returned ${response.status}`,
            };
      } catch (error) {
        return {
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    create: (runtimeConfig) =>
      new OpenSandboxRuntimeProvider(runtimeConfig, connectionConfig),
  });
}

/** Runtime Host 通用 loader 约定的标准无参出口。 */
export function createRuntimePlugin(): RuntimeProviderPlugin {
  return createOpenSandboxRuntimePlugin(resolveOpenSandboxConnectionConfig());
}

export type { OpenSandboxConnectionConfig } from "./types";
