import type { OpenSandboxConnectionConfig } from "./types";

/** 标准 Host loader 调用的插件私有 env 解析；显式工厂仍可直接传 config。 */
export function resolveOpenSandboxConnectionConfig(
  env: NodeJS.ProcessEnv = process.env
): OpenSandboxConnectionConfig {
  const protocol = env.AGEWORK_SANDBOX_OPENSANDBOX_PROTOCOL ?? "http";
  if (protocol !== "http" && protocol !== "https") {
    throw new Error(
      `AGEWORK_SANDBOX_OPENSANDBOX_PROTOCOL expects "http" or "https", got: ${protocol}`
    );
  }
  const proxy = env.AGEWORK_SANDBOX_OPENSANDBOX_USE_SERVER_PROXY;
  if (proxy !== undefined && proxy !== "true" && proxy !== "false") {
    throw new Error(
      `AGEWORK_SANDBOX_OPENSANDBOX_USE_SERVER_PROXY expects "true" or "false", got: ${proxy}`
    );
  }
  return {
    domain: env.AGEWORK_SANDBOX_OPENSANDBOX_DOMAIN ?? "localhost:8080",
    protocol,
    apiKey: env.AGEWORK_PRIVATE_OPENSANDBOX_API_KEY,
    useServerProxy: proxy === "true",
  };
}
