import {
  isRuntimeType,
  type RuntimeType,
} from "@agework/runtime-sdk";

// RuntimeType / isRuntimeType 的权威来源是 @agework/runtime-sdk。
// re-export RuntimeType 保持现有消费者
// 从 config.js 引入的路径不破。
export type { RuntimeType };

const DEFAULT_LOG_DIR = "/home/agework/.agework/logs/runtime";

export interface RegisteredRuntimeHostConfig {
  /** server 基地址(含 API base path,如 http://host:3000/api/v1),与 worker 的 AGEWORK_SERVER_BASE_URL 同语义。 */
  serverBaseUrl: string;
  /** 配对 token(server 创建 Runtime Host 时下发,明文只出现一次)。 */
  token: string;
  /** 这台 Host 支持的运行方式(≥1;一台机器可以同时提供多种 runtime)。 */
  runtimeTypes: RuntimeType[];
  /** 运行实例日志目录(容器内/宿主机路径,按 runtime provider 语义解释)。 */
  runtimeLogHostPath: string;
  /** 非 native provider 起 worker 运行实例用的默认镜像 tag。 */
  workerImage?: string;
  /** 显式允许加载的 runtime 插件包。 */
  pluginPackages: string[];
  /** 显式允许 Worker 加载的 Agent Adapter 插件包。 */
  agentPluginPackages: string[];
  /** native 专用:fork worker 用的 agework-runtime 产物入口(纯 JS bundle,ESM)。
   *  不传则默认 fork registered Runtime Host 自身(process.argv[1])——它与 worker 是同一
   *  产物,注入 AGEWORK_WORKER_ROLE=worker 即以 worker 角色启动。registered Host + native
   *  场景下镜像里只有一份 bundle,默认即正确。 */
  runtimeEntryPath?: string;
  /** Phase 2: worker HTTP 服务器监听端口(worker 回连 Host 的端口)。
   *  默认 7101。worker 的 AGEWORK_WORKER_API_BASE 会被设为 `http://127.0.0.1:<port>/api/v1`。 */
  workerPort?: number;
  /** 用户工作空间根目录(user-scope 挂载根)。builtin 场景由 server
   *  supervisor 注入自己的配置值;registered 默认 /home/agework/workspaces。 */
  userWorkspaceRoot?: string;
}

/**
 * registered Runtime Host 启动配置:CLI 参数优先,env 兜底。
 * `agework-runtime --server <url> --token <配对码> --runtime <type[,type...]>
 *   [--worker-image <tag>] [--log-dir <path>] [--runtime-entry <path>]
 *   [--plugins <package[,package...]>] [--agent-plugins <package[,package...]>]`
 * 运行方式支持逗号分隔多值(如 `--runtime native,docker`);
 * env 读 AGEWORK_RUNTIME_TYPES,单数 AGEWORK_RUNTIME_TYPE 作兼容别名。
 */
export function resolveRegisteredRuntimeHostConfig(
  argv: string[],
  env: NodeJS.ProcessEnv
): RegisteredRuntimeHostConfig {
  const args = parseFlags(argv);
  const serverBaseUrl = args.get("server") ?? env.AGEWORK_SERVER_BASE_URL;
  const token = args.get("token") ?? env.AGEWORK_RUNTIME_TOKEN;
  const runtimeTypesRaw =
    args.get("runtime") ??
    env.AGEWORK_RUNTIME_TYPES ??
    env.AGEWORK_RUNTIME_TYPE;
  const runtimeLogHostPath =
    args.get("log-dir") ?? env.AGEWORK_RUNTIME_LOG_DIR ?? DEFAULT_LOG_DIR;
  const workerImage =
    args.get("worker-image") ?? env.AGEWORK_RUNTIME_WORKER_IMAGE;
  const runtimeEntryPath =
    args.get("runtime-entry") ?? env.AGEWORK_RUNTIME_ENTRY;
  const workerPortStr =
    args.get("worker-port") ?? env.AGEWORK_RUNTIME_WORKER_PORT;
  const workerPort = workerPortStr ? parseInt(workerPortStr, 10) : undefined;
  const userWorkspaceRoot =
    args.get("user-workspace-root") ?? env.AGEWORK_RUNTIME_USER_WORKSPACE_ROOT;
  const pluginPackages = [
    ...new Set(
      (args.get("plugins") ?? env.AGEWORK_RUNTIME_PLUGINS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
  const agentPluginPackages = [
    ...new Set(
      (args.get("agent-plugins") ?? env.AGEWORK_AGENT_PLUGINS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];

  if (!serverBaseUrl) {
    throw new Error(
      "missing server url: pass --server or AGEWORK_SERVER_BASE_URL"
    );
  }
  if (!token) {
    throw new Error(
      "missing pairing token: pass --token or AGEWORK_RUNTIME_TOKEN"
    );
  }
  const runtimeTypes = [
    ...new Set(
      (runtimeTypesRaw ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    ),
  ];
  if (runtimeTypes.length === 0 || !runtimeTypes.every(isRuntimeType)) {
    throw new Error(
      "missing or invalid runtime type: pass --runtime <runtime-type>[,...] or AGEWORK_RUNTIME_TYPES"
    );
  }
  const containerTypes = runtimeTypes.filter((type) => type !== "native");
  if (containerTypes.length > 0 && !workerImage) {
    throw new Error(
      `missing worker image for --runtime ${containerTypes.join(",")}: pass --worker-image or AGEWORK_RUNTIME_WORKER_IMAGE`
    );
  }

  return {
    serverBaseUrl: serverBaseUrl.replace(/\/+$/, ""),
    token,
    runtimeTypes,
    runtimeLogHostPath,
    pluginPackages,
    agentPluginPackages,
    ...(workerImage ? { workerImage } : {}),
    ...(runtimeEntryPath ? { runtimeEntryPath } : {}),
    ...(workerPort ? { workerPort } : {}),
    ...(userWorkspaceRoot ? { userWorkspaceRoot } : {}),
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
