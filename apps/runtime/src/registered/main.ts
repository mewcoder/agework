import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectEnvConfig, resolveInstalledBinPath } from "@agework/shared/cli";
import {
  resolveRegisteredRuntimeConfig,
  type RuntimeType,
} from "./config.js";
import { TunnelClient, buildCapabilities, log } from "./tunnel-client.js";
import { TunnelUpstream } from "./tunnel-upstream.js";
import { RuntimeHost, type RuntimeHostConfig } from "../host/runtime-host.js";
import { WorkerHttpServer } from "../host/worker-http-server.js";

/**
 * 启动时探测一种 runtimeType 在本机的真实可用性:
 * - native:Host 进程能跑就可用;
 * - docker:`docker info` 探测 daemon 是否可达;
 * - opensandbox:registered daemon 尚无 sandbox 接入配置,恒不可用。
 */
function detectRuntimeTypeAvailability(runtimeType: RuntimeType): {
  available: boolean;
  reason?: string;
} {
  if (runtimeType === "native") return { available: true };
  if (runtimeType === "docker") {
    const result = spawnSync("docker", ["info"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    return result.status === 0
      ? { available: true }
      : { available: false, reason: "docker daemon not reachable" };
  }
  return {
    available: false,
    reason: "opensandbox is not configured on this host",
  };
}

/** registered host 常驻入口:解析配置、装配 RuntimeHost + worker HTTP + 隧道。 */
export async function runRegisteredRuntime(): Promise<void> {
  const config = resolveRegisteredRuntimeConfig(
    process.argv.slice(2),
    process.env
  );
  const workerPort = config.workerPort ?? 7101;
  const workerApiBaseUrl = `http://127.0.0.1:${workerPort}/api/v1`;
  const userWorkspaceRoot =
    config.userWorkspaceRoot ?? "/home/agework/workspaces";
  // 与 server 侧 builtin Host 的约定一致:~/.agework/cli/<agent>/
  const cliInstallDir = join(homedir(), ".agework", "cli");
  // 启动时按类型探测一次真实可用性,register 上报 + Host 能力矩阵共用
  const capabilities = buildCapabilities(
    config.runtimeTypes,
    detectRuntimeTypeAvailability
  );

  // Phase 2: RuntimeHost 管理 worker 池、命令信箱、握手、fence。
  // providerConfig.serverBaseUrl 设为 Host 的 worker HTTP 端点——
  // provider（native/sandbox）用它设置 worker 的 AGEWORK_WORKER_API_BASE，
  // 使 worker 数据面对端从 server 切到 Host。
  const hostConfig: RuntimeHostConfig = {
    runtimeLogDir: config.runtimeLogHostPath,
    getUserWorkspace: (username) => {
      const dir = join(userWorkspaceRoot, username);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    launchTimeoutMs: 60_000,
    heartbeatTimeoutMs: 120_000,
    agentEventTrace: { enabled: false, maxFileMb: 50 },
    cliInstallDir,
    capabilities,
    providerConfig: {
      workerImage: config.workerImage ?? "",
      runtimeLogHostPath: config.runtimeLogHostPath,
      serverBaseUrl: workerApiBaseUrl,
      native: {
        runtimeEntryPath: config.runtimeEntryPath ?? process.argv[1] ?? "",
      },
      openSandbox: {
        domain: "",
        protocol: "https",
        apiKey: undefined,
        useServerProxy: false,
      },
    },
    workerApiBaseUrl,
    // native runtimeType 的 CLI 路径:Host 就是执行机器本机——
    // 一键安装目录优先(host.installCli 装的),否则按本机 PATH 检测结果
    resolveCliPaths: async () => {
      const envConfig = detectEnvConfig();
      return {
        claude:
          resolveInstalledBinPath(cliInstallDir, "claude") ??
          envConfig.claude.executablePath,
        codex:
          resolveInstalledBinPath(cliInstallDir, "codex") ??
          envConfig.codex.executablePath,
        opencode:
          resolveInstalledBinPath(cliInstallDir, "opencode") ??
          envConfig.opencode.executablePath,
      };
    },
  };
  const runtimeHost = new RuntimeHost(hostConfig);

  // 上行通知经隧道回流 server
  const tunnelUpstream = new TunnelUpstream();
  runtimeHost.setUpstream(tunnelUpstream);

  // worker HTTP 服务器——worker 的数据面对端
  const httpServer = new WorkerHttpServer(runtimeHost, workerPort);
  await httpServer.start();

  const client = new TunnelClient({
    config,
    capabilities,
    hostContract: runtimeHost,
    tunnelUpstream,
    onGone: () => process.exit(0),
    onIncompatible: () => process.exit(1),
  });
  const shutdown = () => {
    client.stop();
    // 停掉名下所有 worker 运行实例(目标架构不做跨重启容器复用),超时兜底强退
    const stopAll = runtimeHost
      .listWorkers()
      .then((workers) =>
        Promise.allSettled(
          workers.map((w) =>
            runtimeHost.stopWorker({
              runtimeHostId: w.runtimeHostId,
              key: w.workerKey,
            })
          )
        )
      );
    const timeout = new Promise((resolve) => setTimeout(resolve, 10_000));
    void Promise.race([stopAll, timeout]).then(() => {
      runtimeHost.drain();
      void httpServer.stop();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  log(
    `registered runtime starting: server=${config.serverBaseUrl} runtimes=${config.runtimeTypes.join(",")} workerPort=${workerPort}`
  );
  client.start();
  // 常驻:存活由 WS 连接/重连 timer 维持
  await new Promise(() => {});
}
