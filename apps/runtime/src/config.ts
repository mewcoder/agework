import {
  SUPPORTED_RUNTIME_TYPES,
  isRuntimeType,
  type RuntimeType,
} from "@agework/providers";

// RuntimeType / isRuntimeType / SUPPORTED_RUNTIME_TYPES 的权威来源是
// @agework/providers（design §4.2）。re-export RuntimeType 保持现有消费者
// 从 config.js 引入的路径不破。
export type { RuntimeType };

const DEFAULT_LOG_DIR = "/home/agework/.agework/logs/runtime";

export interface RegisteredRuntimeConfig {
  /** server 基地址(含 API base path,如 http://host:3000/api/v1),与 worker 的 AGEWORK_SERVER_BASE_URL 同语义。 */
  serverBaseUrl: string;
  /** 配对 token(server 创建 Runtime 时下发,明文只出现一次)。 */
  token: string;
  /** 本实例定死的一种运行方式(实例专一,不做全能节点)。 */
  runtimeType: RuntimeType;
  /** 载体日志目录(容器内/宿主机路径,按 runtimeType 语义同 packages/providers)。 */
  runtimeLogHostPath: string;
  /** docker/opensandbox 起 worker 载体用的镜像 tag;native 不用。 */
  workerImage?: string;
  /** native 专用:fork worker 用的 agework-runtime 产物入口(纯 JS bundle,ESM)。
 *  不传则默认 fork Registered Runtime 自身(process.argv[1])——它与 worker 是同一
 *  产物,注入 AGEWORK_WORKER_ROLE=worker 即以 worker 角色启动,见 packages/providers
 *  的 NativeProviderConfig。Registered+native 场景下镜像里只有一份 bundle,默认即正确。 */
  runtimeEntryPath?: string;
  /** Phase 2: worker HTTP 服务器监听端口(worker 回连 Host 的端口)。
 *  默认 7101。worker 的 AGEWORK_WORKER_API_BASE 会被设为 `http://127.0.0.1:<port>/api/v1`。 */
  workerPort?: number;
}

/**
 * Registered Runtime 启动配置:CLI 参数优先,env 兜底。
 * `agework-runtime --server <url> --token <配对码> --runtime <type>
 *   [--worker-image <tag>] [--log-dir <path>] [--runtime-entry <path>]`
 */
export function resolveRegisteredRuntimeConfig(
  argv: string[],
  env: NodeJS.ProcessEnv
): RegisteredRuntimeConfig {
  const args = parseFlags(argv);
  const serverBaseUrl = args.get("server") ?? env.AGEWORK_SERVER_BASE_URL;
  const token = args.get("token") ?? env.AGEWORK_RUNTIME_TOKEN;
  const runtimeType = args.get("runtime") ?? env.AGEWORK_RUNTIME_TYPE;
  const runtimeLogHostPath =
    args.get("log-dir") ?? env.AGEWORK_RUNTIME_LOG_DIR ?? DEFAULT_LOG_DIR;
  const workerImage = args.get("worker-image") ?? env.AGEWORK_RUNTIME_WORKER_IMAGE;
  const runtimeEntryPath =
    args.get("runtime-entry") ?? env.AGEWORK_RUNTIME_ENTRY;
  const workerPortStr = args.get("worker-port") ?? env.AGEWORK_RUNTIME_WORKER_PORT;
  const workerPort = workerPortStr ? parseInt(workerPortStr, 10) : undefined;

  if (!serverBaseUrl) {
    throw new Error("missing server url: pass --server or AGEWORK_SERVER_BASE_URL");
  }
  if (!token) {
    throw new Error("missing pairing token: pass --token or AGEWORK_RUNTIME_TOKEN");
  }
  if (!runtimeType || !isRuntimeType(runtimeType)) {
    throw new Error(
      `missing or invalid runtime type: pass --runtime <${SUPPORTED_RUNTIME_TYPES.join("|")}> or AGEWORK_RUNTIME_TYPE`
    );
  }
  if (runtimeType !== "native" && !workerImage) {
    throw new Error(
      `missing worker image for --runtime ${runtimeType}: pass --worker-image or AGEWORK_RUNTIME_WORKER_IMAGE`
    );
  }

  return {
    serverBaseUrl: serverBaseUrl.replace(/\/+$/, ""),
    token,
    runtimeType,
    runtimeLogHostPath,
    ...(workerImage ? { workerImage } : {}),
    ...(runtimeEntryPath ? { runtimeEntryPath } : {}),
    ...(workerPort ? { workerPort } : {}),
  };
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
