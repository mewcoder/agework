import type { RuntimeConfig } from "@agework/runtime";
import { ConfigService } from "../config/config.service";
import { DEFAULT_WORKER_IMAGE } from "../config/registry/defaults";
import { EnvKey } from "../config/registry/env-key";
import { resolveApiBasePath } from "../common/path.util";

/**
 * 把 server 的 ConfigService 拼成 `@agework/runtime` 需要的 RuntimeConfig。
 * runtime 包不认识 ConfigService / process.env / @agework/worker——所有值在这里备好后注入:
 * - serverBaseUrl:worker 回连 server 的地址。默认 loopback,docker/opensandbox
 *   provider 自行把 loopback 换成 host.docker.internal;远程部署设 AGEWORK_SERVER_BASE_URL
 *   覆盖成真实可达地址,三种 runtime 都直接用。
 * - worker 入口 / tsx CLI 路径由 server require.resolve 后传入。
 */
export function toRuntimeConfig(configService: ConfigService): RuntimeConfig {
  const port = process.env[EnvKey.PORT] ?? "3000";
  const apiBasePath = resolveApiBasePath(process.env[EnvKey.CONTEXT]);
  const serverBaseUrlOverride = process.env[EnvKey.SERVER_BASE_URL]?.trim();
  const openSandbox = configService.getOpenSandboxConfig();

  return {
    workerImage: DEFAULT_WORKER_IMAGE,
    runtimeLogHostPath: configService.getRuntimeLogDir(),
    serverBaseUrl:
      serverBaseUrlOverride || `http://127.0.0.1:${port}${apiBasePath}`,
    local: {
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
