export const RUNTIME_TYPES = ["local", "docker", "opensandbox"] as const;
export type RuntimeType = (typeof RUNTIME_TYPES)[number];

export interface ManagerConfig {
  /** server 基地址(含 API base path,如 http://host:3000/api/v1),与 worker 的 AGEWORK_SERVER_BASE_URL 同语义。 */
  serverBaseUrl: string;
  /** 配对 token(server 创建 Runtime 时下发,明文只出现一次)。 */
  token: string;
  /** 本实例定死的一种运行方式(实例专一,不做全能节点)。 */
  runtimeType: RuntimeType;
}

/**
 * manager 启动配置:CLI 参数优先,env 兜底。
 * `agework-runtime --server <url> --token <配对码> --runtime <type>`
 */
export function resolveManagerConfig(
  argv: string[],
  env: NodeJS.ProcessEnv
): ManagerConfig {
  const args = parseFlags(argv);
  const serverBaseUrl = args.get("server") ?? env.AGEWORK_SERVER_BASE_URL;
  const token = args.get("token") ?? env.AGEWORK_RUNTIME_TOKEN;
  const runtimeType = args.get("runtime") ?? env.AGEWORK_RUNTIME_TYPE;

  if (!serverBaseUrl) {
    throw new Error("missing server url: pass --server or AGEWORK_SERVER_BASE_URL");
  }
  if (!token) {
    throw new Error("missing pairing token: pass --token or AGEWORK_RUNTIME_TOKEN");
  }
  if (!runtimeType || !isRuntimeType(runtimeType)) {
    throw new Error(
      `missing or invalid runtime type: pass --runtime <${RUNTIME_TYPES.join("|")}> or AGEWORK_RUNTIME_TYPE`
    );
  }
  return {
    serverBaseUrl: serverBaseUrl.replace(/\/+$/, ""),
    token,
    runtimeType,
  };
}

function isRuntimeType(value: string): value is RuntimeType {
  return (RUNTIME_TYPES as readonly string[]).includes(value);
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`flag ${arg} requires a value`);
    }
    flags.set(arg.slice(2), value);
    i++;
  }
  return flags;
}
