import type { FactoryProvider } from "@nestjs/common";
import { RuntimeHost } from "@agework/runtime/host";
import { ConfigService } from "../../config/config.service";
import { RuntimeService } from "../../runtime/runtime.service";
import { RunEventService } from "../../run-event/run-event.service";

/**
 * 进程内 RuntimeHost(managed-native)的注入 token。
 *
 * Phase 2 执行面搬家:managed-native 的 worker 池/信箱/握手/fence 由
 * `@agework/runtime/host` 的 RuntimeHost 库承接(与 registered daemon 同一实现、
 * 两种宿主)。managed docker/opensandbox 是 supervisor fork 的独立 runtime 进程,
 * 本身就是跑 registered 代码的 Host,经隧道走 host.* 链路,不经此实例。
 *
 * worker-manager 内部 provider:不 export、不进其他 module。
 */
export const MANAGED_RUNTIME_HOST = Symbol("MANAGED_RUNTIME_HOST");

export const managedRuntimeHostProvider: FactoryProvider<RuntimeHost> = {
  provide: MANAGED_RUNTIME_HOST,
  inject: [ConfigService, RuntimeService, RunEventService],
  useFactory: (
    configService: ConfigService,
    runtimeService: RuntimeService,
    runEvents: RunEventService
  ) =>
    new RuntimeHost({
      runtimeLogDir: configService.getRuntimeLogDir(),
      getUserWorkspace: (username) => configService.getUserWorkspace(username),
      launchTimeoutMs: configService.getLaunchTimeoutSeconds() * 1000,
      heartbeatTimeoutMs: configService.getHeartbeatTimeoutSeconds() * 1000,
      agentEventTrace: configService.getAgentEventTraceConfig(),
      providerConfig: runtimeService.getProviderRuntimeConfig(),
      // workerApiBaseUrl 不设:builtin worker 数据面仍连 server /worker/* 旧端点,
      // controller 委托回本实例(pollCommands/postEvent/register/getRunConfig)。
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
    }),
};
