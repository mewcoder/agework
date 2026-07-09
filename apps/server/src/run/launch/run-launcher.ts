import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { join, posix } from "node:path";
import type { Response } from "express";
import type {
  AgentProviderConfig,
  RecordRunEventInput,
  RunConfig,
  RuntimeSpec,
  WorkerExecutionHandle,
} from "@agework/shared/protocol";
import { isRuntimeType } from "@agework/providers";
import { RunRepository } from "../run.repository";
import { LiveRunRegistry } from "../live-run/live-run.registry";
import { WorkerManagerService } from "../../worker-manager/worker-manager.service";
import { RunDriver } from "../driver/run-driver";
import {
  type RunCliPaths,
} from "../run.types";
import { ConversationService } from "../../conversation/conversation.service";
import {
  AssistantMessageAggregator,
  type IncompleteMessageReason,
} from "../upstream/assistant-message.aggregator";
import { ConfigService } from "../../config/config.service";
import { swallow } from "../../common/swallow";
import { errorLogFields, safeLogJson } from "../../common/logging";
import {
  RunEventService,
  compactData,
} from "../../run-event/run-event.service";
import type { StartRunInput } from "../run.types";
import type { WorkspaceRunContext } from "../../workspace/workspace.types";
import { safePathPart } from "../../common/safe-path";
import { RunStream } from "../streaming/run-stream";

type SaveRun = (
  complete: boolean,
  incompleteReason?: IncompleteMessageReason
) => void;

/**
 * 已有活跃 run 时如何让位：claimRun 在 user_steered 场景需要先停掉旧 run。
 * 由 RunService 注入实现，避免 RunLauncher 反向依赖 RunService 形成环。
 */
export type StopActiveRun = (
  conversationId: string,
  options?: { reason?: IncompleteMessageReason; endResponse?: boolean }
) => Promise<boolean>;

/**
 * 一次 run 的启动准备能力：解析 placement、组装 RunConfig、并发守卫、落库 run 记录、
 * 拉起 worker、注册 live handle。从 RunService 抽出的稳定子能力，只在 run 模块内部使用。
 * RunService.start 仅按顺序委托到本 provider，不持有这些组装/持久化细节。
 */
@Injectable()
export class RunLauncher {
  private readonly logger = new Logger(RunLauncher.name);

  constructor(
    private readonly runRepository: RunRepository,
    private readonly liveRuns: LiveRunRegistry,
    private readonly workerManager: WorkerManagerService,
    private readonly driver: RunDriver,
    private readonly conversationService: ConversationService,
    private readonly runEvents: RunEventService,
    private readonly configService: ConfigService
  ) {}

  /** 启动一次 run：从 placement 解析到 live handle 注册的完整出站准备链路。 */
  async launch(
    input: StartRunInput,
    ports: { stopActiveRun: StopActiveRun }
  ): Promise<void> {
    const {
      runId,
      conversationId,
      userId,
      agentProviderConfig,
      modelProviderId,
      workspace,
      input: runInput,
      userMessage,
      userMessageId,
      res,
      interruptReason,
    } = input;
    const agentType = agentProviderConfig.agentType;
    const targetRuntimeId = workspace.runtimeId;
    const runtimeTarget = this.getPlacement({ workspace, userId });
    const runtimeType = runtimeTarget.runtimeType;
    const sandbox =
      runtimeTarget.runtimeType !== "native" ? runtimeTarget.sandbox : undefined;
    const runConfig = this.makeRunConfig({
      agentProviderConfig,
      placement: runtimeTarget,
      workspaceId: workspace.workspaceId,
      runId,
      conversationId,
      input: runInput,
      runtimeType,
      cliPaths: input.cliPaths,
    });
    const stream = new RunStream(res);

    await this.claimRun({
      conversationId,
      userId,
      runId,
      interruptReason,
      stopActiveRun: ports.stopActiveRun,
    });
    await this.saveUserTurn({
      conversationId,
      userMessage,
      agentType,
      modelProviderId,
    });

    const aggregator = new AssistantMessageAggregator();
    const saveRun = this.makeSaveRun({ conversationId, runId, aggregator });
    const onAgentSessionId = this.saveSession(conversationId);

    this.logger.log(
      `run starting ${safeLogJson({
        runId,
        conversationId,
        workspaceId: runtimeTarget.workspaceId,
        agentType,
        runtimeType,
        isolationScope: sandbox?.isolationScope,
      })}`
    );

    const runCreated = await this.createRun({
      runId,
      conversationId,
      workspaceId: runtimeTarget.workspaceId,
      agentType,
      runtimeType,
      isolationScope: sandbox?.isolationScope,
      userMessageId,
      userId,
      stream,
    });
    if (!runCreated) return;

    const runtimeHandle = await this.startWorker({
      runId,
      conversationId,
      runtimeType,
      isolationScope: sandbox?.isolationScope,
      runConfig,
      runtimeTarget,
      targetRuntimeId,
      stream,
    });
    if (!runtimeHandle) return;

    if (runtimeHandle.runtimeInstanceId) {
      await this.persistRuntimeHandle(
        runId,
        runtimeHandle.runtimeType,
        runtimeHandle.runtimeInstanceId
      );
    }
    this.registerRun({
      runId,
      conversationId,
      runtimeHandle,
      stream,
      aggregator,
      runConfig,
      agentType,
      saveRun,
      onAgentSessionId,
      res,
    });
  }

  /**
   * 解析 placement:部署默认值在这里一次性补齐并校验,传给 runtime 的是已解析入参。
   * Registered runtime 的 workspace(workspace.runtimeId 非空)跳过部署级
   * allow-list 校验——那是 Managed 专属策略,与一台具体远程机器的能力无关;
   * 这个 workspace 的 runtimeType/isolationScope 已在创建时对着该 Runtime
   * 自己的注册类型/能力矩阵校验过(见 WorkspaceService.resolveRegisteredPlacement),
   * 这里不用再查一遍部署允许列表。
   */
  private getPlacement(input: {
    workspace: WorkspaceRunContext;
    userId: string;
  }): RuntimeSpec {
    const { workspace, userId } = input;
    const isRegistered = workspace.runtimeSource !== "managed";
    const requestedRuntimeType = workspace.runtimeType;
    if (
      !isRegistered &&
      !this.configService.isRuntimeTypeAllowed(requestedRuntimeType)
    ) {
      throw new BadRequestException("当前部署不支持该工作空间的运行环境");
    }
    // Registered 分支不查部署 allow-list,但 runtimeType 仍必须是三种已知值之一——
    // 已在 workspace 创建时校验过(WorkspaceService.resolveRegisteredPlacement),
    // 这里只是把 string 收窄回字面量联合类型,不是重新做策略判断。
    if (!isRuntimeType(requestedRuntimeType)) {
      throw new BadRequestException(
        `工作空间的运行环境类型无效: ${requestedRuntimeType}`
      );
    }
    const runtimeType = requestedRuntimeType;
    const base = {
      userId,
      workspaceId: workspace.workspaceId,
      workspaceRootPath: workspace.workspaceRootPath,
      userWorkspaceRootPath: this.configService.getUserWorkspace(
        workspace.username
      ),
      runtimeLogHostPath: this.readRuntimeLogHostPath(),
    };
    if (runtimeType === "native") {
      return this.workerManager.resolveRuntimeSpec({
        ...base,
        runtimeType: "native",
      });
    }

    const requestedIsolationScope = workspace.isolationScope;
    if (
      !isRegistered &&
      !this.configService.isIsolationScopeAllowed(requestedIsolationScope)
    ) {
      throw new BadRequestException("当前部署不支持该工作空间的隔离级别");
    }
    if (
      requestedIsolationScope !== "user" &&
      requestedIsolationScope !== "workspace"
    ) {
      throw new BadRequestException(
        `工作空间的隔离级别无效: ${requestedIsolationScope}`
      );
    }
    return this.workerManager.resolveRuntimeSpec({
      ...base,
      runtimeType,
      isolationScope: requestedIsolationScope,
    });
  }

  /** 日志目录配置读取失败按启动入参问题返回 400,与 makeRunConfig 的组装错误语义一致。 */
  private readRuntimeLogHostPath(): string {
    try {
      return this.configService.getRuntimeLogDir();
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private makeRunConfig(params: {
    agentProviderConfig: AgentProviderConfig;
    placement: RuntimeSpec;
    workspaceId: string;
    runId: string;
    conversationId: string;
    input: unknown;
    runtimeType: string;
    cliPaths?: RunCliPaths;
  }): RunConfig {
    const {
      agentProviderConfig,
      placement,
      workspaceId,
      runId,
      conversationId,
      input,
      runtimeType,
      cliPaths,
    } = params;
    try {
      const logPaths = this.makeLogPaths(placement, conversationId);

      // local 类型 CLI 路径由调用方（AgentService）参数喂入，不再直接依赖 RuntimeModule。
      // container 不走此链路（镜像固定路径，经 env 注入，见 ADR-0004）。
      let claudeExecutablePath: string | undefined;
      let codexExecutablePath: string | undefined;
      if (runtimeType === "native" && cliPaths) {
        claudeExecutablePath = cliPaths.claude;
        codexExecutablePath = cliPaths.codex;
      }

      return {
        runId,
        conversationId,
        workspaceId,
        runtimePath: placement.runtimePath,
        env: {},
        input,
        agentProviderConfig,
        agentEventTrace: buildAgentEventTraceConfig({
          ...this.configService.getAgentEventTraceConfig(),
          runId,
          conversationId,
          workspaceId,
          agentType: agentProviderConfig.agentType,
          ...logPaths,
        }),
        workerLogFilePath: logPaths.workerRuntimeFilePath,
        ...(claudeExecutablePath ? { claudeExecutablePath } : {}),
        ...(codexExecutablePath ? { codexExecutablePath } : {}),
      };
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private makeLogPaths(
    placement: RuntimeSpec,
    conversationId: string
  ): RuntimeLogPaths {
    const logDir = this.configService.getRuntimeLogDir();
    const conversationFileName = safePathPart(conversationId);
    const rawFileName = `${conversationFileName}.raw.jsonl`;
    const aguiFileName = `${conversationFileName}.agui.jsonl`;
    const workerFileName = `${conversationFileName}.worker.log`;
    // 运行时侧路径基于 placement.runtimeLogDir(容器挂载点或宿主机目录由 placement
    // 决定,run 层不再区分 sandbox/local)。统一 posix join:容器必然 linux,
    // local 下 runtimeLogDir 即宿主机目录,服务端按 unix 运行时两者等价。
    const runtimeLogDir = placement.runtimeLogDir;

    return {
      logDir,
      rawFilePath: join(logDir, rawFileName),
      rawRuntimeFilePath: posix.join(runtimeLogDir, rawFileName),
      aguiFilePath: join(logDir, aguiFileName),
      aguiRuntimeFilePath: posix.join(runtimeLogDir, aguiFileName),
      workerRuntimeFilePath: posix.join(runtimeLogDir, workerFileName),
    };
  }

  private async claimRun(input: {
    conversationId: string;
    userId: string;
    runId: string;
    interruptReason?: "user_steered";
    stopActiveRun: StopActiveRun;
  }): Promise<void> {
    const { conversationId, userId, runId, interruptReason, stopActiveRun } =
      input;
    const activated = await this.conversationService.activateConversation(
      conversationId,
      userId
    );
    if (activated) return;
    if (interruptReason === "user_steered") {
      await stopActiveRun(conversationId, {
        reason: "user_steered",
        endResponse: true,
      });
      this.logger.log(
        `active run interrupted by user steering ${safeLogJson({
          conversationId,
          runId,
        })}`
      );
      return;
    }

    throw new ConflictException(
      "A run is already active for this conversation"
    );
  }

  private async saveUserTurn(input: {
    conversationId: string;
    userMessage: StartRunInput["userMessage"];
    agentType: AgentProviderConfig["agentType"];
    modelProviderId: string;
  }): Promise<void> {
    const { conversationId, userMessage, agentType, modelProviderId } = input;
    if (!userMessage) return;

    await this.conversationService.persistConversationMessage(conversationId, {
      type: "saveUserMessage",
      userMessage,
      titleContext: { agentType, modelProviderId },
    });
  }

  private makeSaveRun(input: {
    conversationId: string;
    runId: string;
    aggregator: AssistantMessageAggregator;
  }): SaveRun {
    const { conversationId, runId, aggregator } = input;
    let saveChain: Promise<void> = Promise.resolve();

    return (complete, incompleteReason) => {
      saveChain = saveChain
        .then(() => {
          const snap = aggregator.build(complete, incompleteReason);
          if (snap.content.length === 0) return;
          const contentId = snap.messageId ?? runId;
          return this.conversationService.persistConversationMessage(
            conversationId,
            {
              type: "upsertMessage",
              data: {
                id: runId,
                runId,
                parent_id: null,
                format: "assistant-ui",
                content: {
                  role: "assistant",
                  id: contentId,
                  content: snap.content,
                  status: snap.status,
                  ...(snap.metadata ? { metadata: snap.metadata } : {}),
                },
              },
            }
          );
        })
        .catch((err: unknown) => {
          this.logger.warn(
            `persist assistant message for conversation ${conversationId}: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    };
  }

  private saveSession(conversationId: string): (sessionId: string) => void {
    return (sessionId) => {
      this.conversationService
        .persistConversationMessage(conversationId, {
          type: "setAgentSessionId",
          sessionId,
        })
        .catch(
          swallow(this.logger, `persist agent session for ${conversationId}`)
        );
    };
  }

  private async createRun(input: {
    runId: string;
    conversationId: string;
    workspaceId: string;
    agentType: string;
    runtimeType: string;
    isolationScope?: string;
    userMessageId?: string;
    userId: string;
    stream: RunStream;
  }): Promise<boolean> {
    const {
      runId,
      conversationId,
      workspaceId,
      agentType,
      runtimeType,
      isolationScope,
      userMessageId,
      userId,
      stream,
    } = input;

    try {
      await this.runRepository.create({
        id: runId,
        conversationId,
        agentType,
        runtimeType,
      });
      this.recordRunEvent(
        this.runEvents.runCreated({
          runId,
          conversationId,
          workspaceId,
          agentType,
          runtimeType,
          isolationScope,
        }),
        `record run created for run ${runId}`
      );
      if (userMessageId) {
        await this.conversationService
          .persistConversationMessage(conversationId, {
            type: "attachMessageToRun",
            messageId: userMessageId,
            runId,
          })
          .catch(
            swallow(
              this.logger,
              `attach user message ${userMessageId} to run ${runId}`
            )
          );
        this.recordRunEvent(
          this.runEvents.messageAccepted({
            runId,
            conversationId,
            messageId: userMessageId,
            userId,
          }),
          `record message accepted for run ${runId}`
        );
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `create run record failed ${safeLogJson({
          runId,
          conversationId,
          ...errorLogFields(err),
        })}`
      );
      const errorMsg = err instanceof Error ? err.message : String(err);
      stream.writeError({ threadId: conversationId, runId, message: errorMsg });
      stream.end();
      return false;
    }
  }

  private async startWorker(input: {
    runId: string;
    conversationId: string;
    runtimeType: string;
    isolationScope?: string;
    runConfig: RunConfig;
    runtimeTarget: RuntimeSpec;
    targetRuntimeId: string;
    stream: RunStream;
  }): Promise<WorkerExecutionHandle | null> {
    const {
      runId,
      conversationId,
      runtimeType,
      isolationScope,
      runConfig,
      runtimeTarget,
      targetRuntimeId,
      stream,
    } = input;

    try {
      this.recordRunEvent(
        this.runEvents.runtimeStatusChanged({
          runId,
          status: "starting",
          runtimeType,
          isolationScope,
        }),
        `record runtime starting for run ${runId}`
      );
      return this.driver.start({
        runConfig,
        runtimeTarget,
        targetRuntimeId,
        onRuntimeInstanceIdReady: (runtimeInstanceId) =>
          void this.persistRuntimeHandle(runId, runtimeType, runtimeInstanceId),
      });
    } catch (err) {
      this.logger.error(
        `start worker failed ${safeLogJson({
          runId,
          conversationId,
          runtimeType,
          ...errorLogFields(err),
        })}`
      );
      await this.runRepository
        .markError(runId, "Failed to start worker")
        .catch(swallow(this.logger, `mark run ${runId} start failure`));
      this.runEvents
        .append(
          this.runEvents.runtimeStatusChanged({
            runId,
            status: "start_failed",
            error: err instanceof Error ? err.message : String(err),
            data: compactData(errorLogFields(err)),
          })
        )
        .catch(
          swallow(this.logger, `record runtime start failure for run ${runId}`)
        )
        .finally(() => this.runEvents.forgetRun(runId));
      await this.conversationService
        .setConversationRunState(conversationId, { runStatus: "error" })
        .catch(
          swallow(
            this.logger,
            `set conversation active run status to error for run ${runId}`
          )
        );
      const errorMsg = err instanceof Error ? err.message : String(err);
      stream.writeError({
        threadId: conversationId,
        runId,
        message: "启动 worker 失败: " + errorMsg,
      });
      stream.end();
      return null;
    }
  }

  /**
   * 落库 runtime handle 并记录 ready 事件。同步就绪(handle 自带 instanceId)与
   * sandbox 异步回调两条路径共用;eventKey 保证重复记录幂等。
   */
  private async persistRuntimeHandle(
    runId: string,
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<void> {
    await this.runRepository
      .updateRuntimeHandle(runId, runtimeType, runtimeInstanceId)
      .catch(swallow(this.logger, `persist runtime handle for run ${runId}`));
    this.recordRunEvent(
      this.runEvents.runtimeStatusChanged({
        runId,
        eventKey: `runtime:${runtimeInstanceId}:ready`,
        status: "ready",
        targetId: runtimeInstanceId,
        runtimeType,
        runtimeInstanceId,
      }),
      `record runtime ready for run ${runId}`
    );
  }

  /** best-effort 记录一条 run 事件:失败只打日志,不影响启动链路。 */
  private recordRunEvent(event: RecordRunEventInput, context: string): void {
    this.runEvents.append(event).catch(swallow(this.logger, context));
  }

  private registerRun(input: {
    runId: string;
    conversationId: string;
    runtimeHandle: WorkerExecutionHandle;
    stream: RunStream;
    aggregator: AssistantMessageAggregator;
    runConfig: RunConfig;
    agentType: string;
    saveRun: SaveRun;
    onAgentSessionId: (sessionId: string) => void;
    res: Response;
  }): void {
    const {
      runId,
      conversationId,
      runtimeHandle,
      stream,
      aggregator,
      runConfig,
      agentType,
      saveRun,
      onAgentSessionId,
      res,
    } = input;

    this.liveRuns.register(runId, {
      runtimeHandle,
      stream,
      aggregator,
      conversationId,
      runId,
      workspaceId: runConfig.workspaceId,
      agentType,
      agentEventTrace: runConfig.agentEventTrace,
      stopRequested: false,
      saveRun,
      onAgentSessionId,
    });

    // SSE disconnect: detach the response (don't cancel the run)
    stream.onClose(() => {
      const handle = this.liveRuns.get(runId);
      if (handle) {
        handle.stream.detach(res);
      }
    });

    this.logger.log(
      `run registered ${safeLogJson({
        runId,
        conversationId,
        runtimeType: runtimeHandle.runtimeType,
        runtimeInstanceId: runtimeHandle.runtimeInstanceId,
      })}`
    );
  }
}

type RuntimeLogPaths = {
  logDir: string;
  rawFilePath: string;
  rawRuntimeFilePath: string;
  aguiFilePath: string;
  aguiRuntimeFilePath: string;
  workerRuntimeFilePath: string;
};

// enabled 只控制 raw/agui 大 payload 是否落 JSONL 文件（"trace" 这里指完整证据，不是事件索引）。
// DB 关键事件索引（RunEventService 写入的 RunEvent）与本开关无关，始终记录，关闭本开关后 run
// 仍可在管理端看到事件摘要，只是看不到完整 raw/agui payload 原文。开关与上限由 ConfigService 提供。
function buildAgentEventTraceConfig(input: {
  enabled: boolean;
  maxFileMb: number;
  runId: string;
  conversationId: string;
  workspaceId: string;
  agentType: string;
  logDir: string;
  rawFilePath: string;
  rawRuntimeFilePath: string;
  aguiFilePath: string;
  aguiRuntimeFilePath: string;
}) {
  const { enabled } = input;
  return {
    enabled,
    logDir: enabled ? input.logDir : undefined,
    rawFilePath: enabled ? input.rawFilePath : undefined,
    rawRuntimeFilePath: enabled ? input.rawRuntimeFilePath : undefined,
    aguiFilePath: enabled ? input.aguiFilePath : undefined,
    aguiRuntimeFilePath: enabled ? input.aguiRuntimeFilePath : undefined,
    maxFileMb: input.maxFileMb,
    runId: input.runId,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    agentType: input.agentType,
  };
}
