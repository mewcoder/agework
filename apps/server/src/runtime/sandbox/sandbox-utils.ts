import { resolveApiBasePath } from "../../common/path.util";
import { EnvKey } from "../../config/registry/env-key";

/**
 * worker 容器访问宿主 API 的 base URL。
 * 默认指向 `host.docker.internal:<PORT>`,并拼上与 main.ts 一致的 API 挂载前缀
 * (`<AGEWORK_CONTEXT>/api/v1`),因为 internal runtime API 也在全局前缀之下。
 */
export function resolveDockerApiBase(
  env: Partial<
    Pick<NodeJS.ProcessEnv, "PORT" | "AGEWORK_CONTEXT">
  > = process.env
): string {
  const port = env[EnvKey.PORT] ?? "3000";
  return `http://host.docker.internal:${port}${resolveApiBasePath(
    env[EnvKey.CONTEXT]
  )}`;
}
