import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type {
  RunConfig,
  WorkerCommandRpcRequest,
} from "@agework/shared/protocol";
import { commandMessageToRpcRequest } from "@agework/shared/protocol/rpc";
import { WorkerCommandQueue } from "./command-queue";
import { WorkerConfigStore } from "./worker-config.store";
import { parseWorkerEventPostBody } from "./worker-event.parser";
import { WorkerUpstreamRegistry } from "./worker-upstream.registry";

@Injectable()
export class WorkerEndpointHandler {
  private readonly logger = new Logger(WorkerEndpointHandler.name);

  constructor(
    private readonly commandQueue: WorkerCommandQueue,
    private readonly configStore: WorkerConfigStore,
    private readonly upstream: WorkerUpstreamRegistry
  ) {}

  async pollCommands(
    workerId: string,
    query: { afterSeq?: number; waitMs?: number }
  ): Promise<{
    messages: WorkerCommandRpcRequest[];
    queueEpoch: number;
  }> {
    const seq = query.afterSeq ?? 0;
    const wait = query.waitMs ?? 0;
    const commands =
      wait > 0
        ? await this.commandQueue.waitForWorkerId(workerId, seq, wait)
        : this.commandQueue.pollByWorkerId(workerId, seq);
    if (commands.length > 0) {
      this.logger.debug("worker commands fetched", {
        workerId,
        afterSeq: seq,
        count: commands.length,
        commands: commands.map((command) => ({
          seq: command.seq,
          runId: command.runId,
          type: command.payload.type,
        })),
      });
    }
    return {
      messages: commands.map(commandMessageToRpcRequest),
      queueEpoch: this.commandQueue.epochFor(workerId),
    };
  }

  getRunConfig(runId: string): { config: RunConfig } {
    const config = this.configStore.get(runId);
    if (!config) {
      this.logger.warn(`Run config not found runId=${runId}`);
      throw new NotFoundException(`Run config not found: ${runId}`);
    }
    this.logger.debug("run config fetched", {
      runId,
      conversationId: config.conversationId,
      workspaceId: config.workspaceId,
      agentType: config.agentProviderConfig.agentType,
      agentProviderSource: config.agentProviderConfig.source,
    });
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
}
