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
import type { WorkerUpstreamPort } from "../worker-manager.types";

@Injectable()
export class WorkerEndpointHandler {
  private readonly logger = new Logger(WorkerEndpointHandler.name);
  /** run 层实现的上行事件 Port,由 run startup 经 WorkerManagerService 接线;接线前上报静默丢弃。 */
  private upstreamPort?: WorkerUpstreamPort;

  constructor(
    private readonly commandQueue: WorkerCommandQueue,
    private readonly configStore: WorkerConfigStore
  ) {}

  setUpstreamPort(receiver: WorkerUpstreamPort): void {
    this.upstreamPort = receiver;
  }

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
      await this.upstreamPort?.sendEvent(runId, event);
    }
    return { ok: true };
  }
}
