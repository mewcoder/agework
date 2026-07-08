import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type {
  RunConfig,
  WorkerCommandRpcRequest,
  OwnerCommand,
  WorkspaceFileCommandPayload,
  WorkspaceFileCommandResult,
} from "@agework/shared/protocol";
import { commandMessageToRpcRequest } from "@agework/shared/protocol/rpc";
import { safeLogJson } from "../../common/logging";
import { WorkerCommandQueue } from "./command-queue";
import { WorkerConfigStore } from "./worker-config.store";
import { parseWorkerEventPostBody } from "./worker-event.parser";
import { WorkerUpstreamRegistry } from "./worker-upstream.registry";
import { WorkspaceFileCommandStore } from "./workspace-file-command.store";

@Injectable()
export class WorkerEndpointHandler {
  private readonly logger = new Logger(WorkerEndpointHandler.name);

  constructor(
    private readonly commandQueue: WorkerCommandQueue,
    private readonly configStore: WorkerConfigStore,
    private readonly upstream: WorkerUpstreamRegistry,
    private readonly fileCommandStore: WorkspaceFileCommandStore
  ) {}

  async pollCommands(
    ownerId: string,
    query: { afterSeq?: number; waitMs?: number }
  ): Promise<{
    messages: WorkerCommandRpcRequest[];
    fileCommands: OwnerCommand<WorkspaceFileCommandPayload>[];
    queueEpoch: number;
  }> {
    const seq = query.afterSeq ?? 0;
    const wait = query.waitMs ?? 0;
    const commands =
      wait > 0
        ? await this.commandQueue.waitForOwnerId(ownerId, seq, wait)
        : this.commandQueue.pollByOwnerId(ownerId, seq);
    // 排空文件命令队列(与 run 命令共用同一条长轮询连接,见 ADR-0004)。
    const fileCommands = this.commandQueue.pollFileCommands(ownerId);
    if (commands.length > 0 || fileCommands.length > 0) {
      this.logger.debug(
        `owner commands fetched ${safeLogJson({
          ownerId,
          afterSeq: seq,
          count: commands.length,
          fileCommandCount: fileCommands.length,
          commands: commands.map((command) => ({
            seq: command.seq,
            runId: command.runId,
            type: command.payload.type,
          })),
        })}`
      );
    }
    return {
      messages: commands.map(commandMessageToRpcRequest),
      fileCommands,
      queueEpoch: this.commandQueue.epochFor(ownerId),
    };
  }

  getRunConfig(runId: string): { config: RunConfig } {
    const config = this.configStore.get(runId);
    if (!config) {
      this.logger.warn(`Run config not found runId=${runId}`);
      throw new NotFoundException(`Run config not found: ${runId}`);
    }
    this.logger.debug(
      `run config fetched ${safeLogJson({
        runId,
        conversationId: config.conversationId,
        workspaceId: config.workspaceId,
        agentType: config.agentProviderConfig.agentType,
        agentProviderSource: config.agentProviderConfig.source,
      })}`
    );
    return { config };
  }

  async postEvent(runId: string, body: unknown): Promise<{ ok: boolean }> {
    const events = parseWorkerEventPostBody(body, runId);
    if (!events || events.length === 0) {
      throw new BadRequestException("Invalid worker event body");
    }
    if (events.some((event) => event.runId !== runId)) {
      throw new BadRequestException("Worker event runId mismatch");
    }
    for (const event of events) {
      await this.upstream.sendEvent(runId, event);
    }
    return { ok: true };
  }

  /** worker 经独立结果端点回传文件命令结果,按 commandId 收敛(见 ADR-0004)。 */
  resolveFileCommandResult(result: WorkspaceFileCommandResult): boolean {
    return this.fileCommandStore.resolveResult(result);
  }
}
