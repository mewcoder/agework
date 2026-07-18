import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectEnvConfig, resolveInstalledBinPath } from "@agework/shared/cli";
import type { HostCapabilityStatus } from "@agework/shared/protocol";
import type { RuntimeProviderPlugin } from "@agework/runtime-sdk";
import {
  resolveRegisteredRuntimeHostConfig,
  type RuntimeType,
} from "./config.js";
import { TunnelClient, buildCapabilities, log } from "./tunnel-client.js";
import { TunnelUpstream } from "./tunnel-upstream.js";
import { RuntimeHost, type RuntimeHostConfig } from "../host/runtime-host.js";
import {
  probeDockerDaemon,
  type CapabilityAvailability,
} from "../host/capability-probe.js";
import { WorkerHttpServer } from "../host/worker-http-server.js";
import { loadRuntimePlugins } from "../plugins/runtime-plugin-loader.js";

/**
 * 探测一种 runtimeType 在本机的当前可用性(启动 + 定期刷新共用):
 * - native:Host 进程能跑就可用;
 * - docker:`docker info` 探测 daemon 是否可达;
 * - plugin:插件已成功装配即声明可用，进一步连接错误由 provider 启动时暴露。
 */
async function detectRuntimeTypeAvailability(
  runtimeType: RuntimeType,
  pluginsByType: ReadonlyMap<RuntimeType, RuntimeProviderPlugin>
): Promise<CapabilityAvailability> {
  if (runtimeType === "native") return { available: true };
  if (runtimeType === "docker") return probeDockerDaemon();
  const plugin = pluginsByType.get(runtimeType);
  if (plugin?.probe) return plugin.probe();
  return { available: true };
}

/** 全类型探测一轮,拼出当前能力矩阵。 */
async function detectCapabilities(
  runtimeTypes: RuntimeType[],
  pluginsByType: ReadonlyMap<RuntimeType, RuntimeProviderPlugin>
): Promise<HostCapabilityStatus> {
  const availability = new Map(
    await Promise.all(
      runtimeTypes.map(
        async (runtimeType) =>
          [
            runtimeType,
            await detectRuntimeTypeAvailability(runtimeType, pluginsByType),
          ] as const
      )
    )
  );
  return buildCapabilities(
    runtimeTypes,
    (runtimeType) => availability.get(runtimeType)!,
    (runtimeType) => pluginsByType.get(runtimeType)?.scopes,
    (runtimeType) => pluginsByType.get(runtimeType)?.displayName
  );
}

/** registered host 常驻入口:解析配置、装配 RuntimeHost + worker HTTP + 隧道。 */
export async function runRegisteredRuntimeHost(): Promise<void> {
  const config = resolveRegisteredRuntimeHostConfig(
    process.argv.slice(2),
    process.env
  );
  const workerPort = config.workerPort ?? 7101;
  const workerApiBaseUrl = `http://127.0.0.1:${workerPort}/api/v1`;
  const userWorkspaceRoot =
    config.userWorkspaceRoot ?? "/home/agework/workspaces";
  // 与 builtin Host 的约定一致:~/.agework/cli/<agent>/
  const cliInstallDir = join(homedir(), ".agework", "cli");
  const providerPlugins = await loadRuntimePlugins(config.pluginPackages);
  const pluginsByType = new Map(
    providerPlugins.map((plugin) => [plugin.type, plugin])
  );
  // 启动探测一次真实可用性;Host 用同一探测定期刷新,register(含重连)上报当前矩阵
  const capabilities = await detectCapabilities(
    config.runtimeTypes,
    pluginsByType
  );

  // Phase 2: RuntimeHost 管理 worker 池、命令信箱、握手、fence。
  // providerConfig.workerApiBaseUrl 指向 Host 的 worker HTTP 端点——
  // provider（native/sandbox）用它设置 worker 的 AGEWORK_WORKER_API_BASE，
  // Worker 数据面只连接自己的 Host。
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
    // docker daemon 中途挂掉/恢复要反映到放置准入,只拦新 run 不动存量
    refreshCapabilities: () =>
      detectCapabilities(config.runtimeTypes, pluginsByType),
    providerConfig: {
      workerImage: config.workerImage ?? "",
      runtimeLogHostPath: config.runtimeLogHostPath,
      workerApiBaseUrl,
      native: {
        runtimeEntryPath: config.runtimeEntryPath ?? process.argv[1] ?? "",
      },
    },
    providerPlugins,
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
        pi:
          resolveInstalledBinPath(cliInstallDir, "pi") ??
          envConfig.pi.executablePath,
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
    // 每次 register(含重连)上报 Host 的当前矩阵,不用启动快照
    capabilities: () => runtimeHost.getCapabilities(),
    hostContract: runtimeHost,
    tunnelUpstream,
    onGone: () => process.exit(0),
    onIncompatible: () => process.exit(1),
  });
  const shutdown = () => {
    client.stop();
    // 停掉名下所有 worker 运行实例(目标架构不做跨重启容器复用),超时兜底强退
    const stopAll = runtimeHost.listWorkers().then((workers) =>
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
    `registered runtime host starting: server=${config.serverBaseUrl} runtimeTypes=${config.runtimeTypes.join(",")} workerPort=${workerPort}`
  );
  client.start();
  // 常驻:存活由 WS 连接/重连 timer 维持
  await new Promise(() => {});
}
