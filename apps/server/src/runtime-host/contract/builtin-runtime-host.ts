import { Logger } from "@nestjs/common";
import type { FactoryProvider } from "@nestjs/common";
import {
  loadRuntimePlugins,
  RuntimeHost,
  WorkerHttpServer,
} from "@agework/runtime/host";
import { createRuntimePlugin as createDockerRuntimePlugin } from "@agework/runtime-docker";
import type { HostCapabilityStatus } from "@agework/shared/protocol";
import { ConfigService } from "../../config/config.service";
import { RunEventService } from "../../run-event/run-event.service";
import { RuntimeHostRepository } from "../runtime-host.repository";
import { BUILTIN_HOST_ID } from "../runtime-host.types";
import { toRuntimeConfig } from "../builtin/runtime-config";
import { resolveRuntimeHostCliPaths } from "../environment/runtime-host-environment";

/**
 * 进程内 builtin Runtime Host 的注入 token。
 *
 * Phase 3 清尾:builtin Host 自管 worker HTTP 服务器(WorkerHttpServer),
 * worker 数据面对端从 server 旧 /worker/* 端点切到 Host——与 registered
 * daemon 同构。所有内建或插件 runtime 都由这一个 Host 按 runtimeType 分派 provider。
 *
 * runtime-host 内部 provider：不 export、不进入其他 module。
 */
export const BUILTIN_RUNTIME_HOST = Symbol("BUILTIN_RUNTIME_HOST");

const logger = new Logger("BuiltinRuntimeHost");

export const builtinRuntimeHostProvider: FactoryProvider<RuntimeHost> = {
  provide: BUILTIN_RUNTIME_HOST,
  inject: [ConfigService, RuntimeHostRepository, RunEventService],
  useFactory: async (
    configService: ConfigService,
    repository: RuntimeHostRepository,
    runEvents: RunEventService
  ): Promise<RuntimeHost> => {
    const workerPort = configService.getBuiltinWorkerHttpPort();
    const apiBasePath = configService.getApiBasePath();
    const workerApiBaseUrl = `http://127.0.0.1:${workerPort}${apiBasePath}`;

    const providerConfig = toRuntimeConfig(configService, workerApiBaseUrl);
    const providerPlugins = [
      createDockerRuntimePlugin(),
      ...(await loadRuntimePlugins(configService.getRuntimePluginPackages())),
    ];
    const pluginsByType = new Map(
      providerPlugins.map((plugin) => [plugin.type, plugin])
    );
    // native 进程内恒可用；其余 provider 由各自插件声明探测能力。
    const detectCapabilities = async (): Promise<HostCapabilityStatus> => {
      const entries = await Promise.all(
        configService.getAllowedRuntimeTypes().map(async (runtimeType) => {
          const plugin = pluginsByType.get(runtimeType);
          const availability = plugin?.probe
            ? await plugin.probe()
            : { available: true };
          return [
            runtimeType,
            {
              ...availability,
              displayName:
                runtimeType === "native"
                  ? "Native"
                  : plugin?.displayName ?? runtimeType,
              scopes:
                runtimeType === "native"
                  ? ["workspace"]
                  : plugin?.scopes ?? ["user", "workspace"],
            },
          ] as const;
        })
      );
      return Object.fromEntries(entries) as HostCapabilityStatus;
    };
    const capabilities = await detectCapabilities();

    const host = new RuntimeHost({
      runtimeLogDir: configService.getRuntimeLogDir(),
      getUserWorkspace: (username) => configService.getUserWorkspace(username),
      launchTimeoutMs: configService.getLaunchTimeoutSeconds() * 1000,
      heartbeatTimeoutMs: configService.getHeartbeatTimeoutSeconds() * 1000,
      agentEventTrace: configService.getAgentEventTraceConfig(),
      cliInstallDir: configService.getHostCliDir(),
      capabilities,
      // provider 依赖中途挂掉/恢复反映到放置准入,只拦新 run
      refreshCapabilities: detectCapabilities,
      providerConfig,
      providerPlugins,
      agentPluginPackages: configService.getAgentPluginPackages(),
      resolveCliPaths: async () => {
        const row = await repository.findById(BUILTIN_HOST_ID);
        return row
          ? resolveRuntimeHostCliPaths(row)
          : { claude: null, codex: null, opencode: null, pi: null };
      },
      // 「命令已下发」是记账不是执行回流,直接落 run-event 账本(best-effort)
      onCommandDispatched: ({ runId, commandId, commandType }) => {
        void runEvents
          .append(runEvents.commandSent({ runId, commandId, commandType }))
          .catch(() => {});
      },
    });

    // builtin Host 自管 worker HTTP 服务器——worker 数据面对端不再连 server
    const httpServer = new WorkerHttpServer(host, workerPort, apiBasePath);
    await httpServer.start();
    logger.log(
      `builtin Host worker HTTP server listening on port ${workerPort}`
    );

    // 进程退出时清理(不阻塞)
    process.on("beforeExit", () => {
      host.drain();
      void httpServer.stop();
    });

    return host;
  },
};
