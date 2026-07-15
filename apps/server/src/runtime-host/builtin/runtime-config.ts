import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RuntimeConfig } from "@agework/providers";
import { ConfigService } from "../../config/config.service";

/**
 * builtin Host 的 native provider fork 的 agework-runtime 产物入口（纯 JS bundle, ESM, `.mjs`）。
 * 解析顺序:
 * 1. AGEWORK_RUNTIME_LOCAL_ENTRY 显式覆盖(部署/排障用);
 * 2. 随 server build 内嵌的产物(scripts/embed-runtime.mjs 复制到 dist/agework-runtime/main.mjs,
 *    prod/desktop 走这条,与 server 同版本);
 * 3. dev 回退:从 workspace 里已构建的 @agework/runtime 产物解析(需先 `pnpm --filter
 *    @agework/runtime build`,turbo `^build` 会带上)。
 * server 因此不 import @agework/worker,只消费 agework-runtime 这个外部产物。
 */
export function resolveRuntimeEntry(entryOverride?: string): string {
  if (entryOverride) return entryOverride;

  // dist/src/runtime-host/builtin/runtime-config.js → dist/agework-runtime/main.mjs
  const embedded = join(__dirname, "../../../agework-runtime/main.mjs");
  if (existsSync(embedded)) return embedded;

  // dev:@agework/runtime 的 "." 导出是 src/main.ts,取其包目录下已构建的 dist/main.js
  const runtimeSrcEntry = require.resolve("@agework/runtime");
  return join(dirname(runtimeSrcEntry), "../dist/main.js");
}

/**
 * 把 server 的 ConfigService 与 builtin Host 的 Worker HTTP 地址拼成
 * `@agework/providers` 需要的 RuntimeConfig。
 * `@agework/runtime` 包不认识 ConfigService / process.env——所有值在这里备好后注入:
 * - workerApiBaseUrl:worker 回连所属 builtin Host 的地址。docker/opensandbox
 *   provider 自行把 loopback 换成 host.docker.internal。
 * - native.runtimeEntryPath:agework-runtime 产物入口(见 resolveRuntimeEntry)。
 */
export function toRuntimeConfig(
  configService: ConfigService,
  workerApiBaseUrl: string
): RuntimeConfig {
  const openSandbox = configService.getOpenSandboxConfig();

  return {
    workerImage: configService.getWorkerImage(),
    runtimeLogHostPath: configService.getRuntimeLogDir(),
    workerApiBaseUrl,
    native: {
      runtimeEntryPath: resolveRuntimeEntry(
        configService.getRuntimeLocalEntryOverride()
      ),
    },
    openSandbox: {
      domain: openSandbox.domain,
      protocol: openSandbox.protocol,
      apiKey: openSandbox.apiKey,
      useServerProxy: openSandbox.useServerProxy,
    },
  };
}
