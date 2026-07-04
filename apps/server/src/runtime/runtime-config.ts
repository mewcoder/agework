import type { RuntimeConfig } from "@agework/runtime";
import { ConfigService } from "../config/config.service";
import { DEFAULT_WORKER_IMAGE } from "../config/registry/defaults";
import { EnvKey } from "../config/registry/env-key";
import { resolveApiBasePath } from "../common/path.util";

/**
 * 把 server 的 ConfigService 拼成 `@agework/runtime` 需要的 RuntimeConfig。
 * runtime 包不认识 ConfigService / process.env / @agework/worker——所有值在这里备好后注入:
 * - apiBase 由 server 算(容器走 host.docker.internal,local 走 loopback)。
 * - worker 入口 / tsx CLI 路径由 server require.resolve 后传入。
 */
export function toRuntimeConfig(configService: ConfigService): RuntimeConfig {
  const port = process.env[EnvKey.PORT] ?? "3000";
  const apiBasePath = resolveApiBasePath(process.env[EnvKey.CONTEXT]);
  const openSandbox = configService.getOpenSandboxConfig();

  return {
    workerImage: DEFAULT_WORKER_IMAGE,
    runtimeLogHostPath: configService.getRuntimeLogDir(),
    containerApiBaseUrl: `http://host.docker.internal:${port}${apiBasePath}`,
    local: {
      apiBaseUrl: `http://127.0.0.1:${port}${apiBasePath}`,
      workerEntryPath: require.resolve("@agework/worker"),
      tsxCliPath: require.resolve("tsx/cli"),
    },
    openSandbox: {
      domain: openSandbox.domain,
      protocol: openSandbox.protocol,
      apiKey: openSandbox.apiKey,
      useServerProxy: openSandbox.useServerProxy,
    },
  };
}
