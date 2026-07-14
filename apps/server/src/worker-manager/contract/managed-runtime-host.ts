import { Logger } from "@nestjs/common";
import type { FactoryProvider } from "@nestjs/common";
import { RuntimeHost, WorkerHttpServer } from "@agework/runtime/host";
import type { HostCapabilityStatus } from "@agework/shared/protocol";
import { ConfigService } from "../../config/config.service";
import { RuntimeService } from "../../runtime/runtime.service";
import { RunEventService } from "../../run-event/run-event.service";
import { resolveApiBasePath } from "../../common/api-path";
import { EnvKey } from "../../config/registry/env-key";

/**
 * 进程内 builtin RuntimeHost 的注入 token。
 *
 * Phase 3 清尾:builtin Host 自管 worker HTTP 服务器(WorkerHttpServer),
 * worker 数据面对端从 server 旧 /worker/* 端点切到 Host——与 registered
 * daemon 同构。native/docker/opensandbox 都由这一个 Host 按 runtimeType 分派 provider。
 *
 * worker-manager 内部 provider:不 export、不进其他 module。
 */
export const MANAGED_RUNTIME_HOST = Symbol("MANAGED_RUNTIME_HOST");

const logger = new Logger("ManagedRuntimeHost");

export const managedRuntimeHostProvider: FactoryProvider<RuntimeHost> = {
  provide: MANAGED_RUNTIME_HOST,
  inject: [ConfigService, RuntimeService, RunEventService],
  useFactory: async (
    configService: ConfigService,
    runtimeService: RuntimeService,
    runEvents: RunEventService
  ): Promise<RuntimeHost> => {
    const workerPort = configService.getBuiltinWorkerHttpPort();
    const apiBasePath = resolveApiBasePath(process.env[EnvKey.CONTEXT]);
    const workerApiBaseUrl = `http://127.0.0.1:${workerPort}${apiBasePath}`;

    const providerConfig = runtimeService.getProviderRuntimeConfig();
    // provider（native/sandbox）用 RuntimeConfig.serverBaseUrl 覆盖 worker 的
    // AGEWORK_WORKER_API_BASE env——因此 providerConfig.serverBaseUrl 也必须
    // 指向 Host 的 worker HTTP 端点,而非 server 的主端口。
    providerConfig.serverBaseUrl = workerApiBaseUrl;
    const capabilities = Object.fromEntries(
      configService.getAllowedRuntimeTypes().map((runtimeType) => [
        runtimeType,
        {
          available: true,
          scopes:
            runtimeType === "native" ? ["workspace"] : ["user", "workspace"],
        },
      ])
    ) as HostCapabilityStatus;

    const host = new RuntimeHost({
      runtimeLogDir: configService.getRuntimeLogDir(),
      getUserWorkspace: (username) => configService.getUserWorkspace(username),
      launchTimeoutMs: configService.getLaunchTimeoutSeconds() * 1000,
      heartbeatTimeoutMs: configService.getHeartbeatTimeoutSeconds() * 1000,
      agentEventTrace: configService.getAgentEventTraceConfig(),
      capabilities,
      providerConfig,
      workerApiBaseUrl,
      resolveCliPaths: async () => {
        const resolved = await runtimeService.getResolvedCliPaths(
          runtimeService.getManagedRuntimeId("native")
        );
        return {
          claude: resolved?.claude ?? null,
          codex: resolved?.codex ?? null,
          opencode: resolved?.opencode ?? null,
        };
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
