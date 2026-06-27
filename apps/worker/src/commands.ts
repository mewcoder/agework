import type {
  CommandPayload,
  CommandResultPayload,
  CommandTracePayload,
  RunChannelMessage,
  UpstreamMessage,
} from "@agework/shared/protocol";

export type CommandSource = {
  pollCommands(waitMs?: number): Promise<RunChannelMessage<CommandPayload>[]>;
};

export type CommandSink = {
  emit(runId: string, msg: UpstreamMessage): Promise<void>;
};

export type CommandClient = CommandSource & CommandSink;

export type CommandHandler = (
  command: CommandPayload
) => Promise<void> | void;

export type CommandOptions = {
  waitMs: number;
  emptyRetryDelayMs: number;
  dedupeClearEveryPolls?: number;
};

export type CommandReceipts = Pick<
  WorkerCommands,
  "received" | "handled" | "failed"
>;

type CommandPhase = CommandTracePayload["phase"];
type CommandStatus = CommandResultPayload["status"];

/**
 * Owns the keep-alive worker command lifecycle:
 * poll commands, dedupe them, dispatch them, and report command receipts.
 */
export class WorkerCommands {
  private readonly processedCommands = new Set<string>();
  private readonly dedupeClearEveryPolls: number;
  private pollIterations = 0;
  private stopped = false;

  constructor(
    private readonly client: CommandClient,
    private readonly options: CommandOptions
  ) {
    this.dedupeClearEveryPolls = options.dedupeClearEveryPolls ?? 100;
  }

  async run(handle: CommandHandler): Promise<void> {
    for (;;) {
      if (this.stopped) break;
      const commands = await this.client.pollCommands(this.options.waitMs);
      if (this.stopped) break;
      this.clearDedupeWindowIfNeeded();

      for (const message of commands) {
        if (this.stopped) break;
        const command = message.payload;
        if (this.processedCommands.has(command.commandId)) continue;
        this.processedCommands.add(command.commandId);
        await handle(command);
      }

      if (commands.length === 0) {
        await sleep(this.options.emptyRetryDelayMs);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  received(runId: string, command: CommandPayload): void {
    this.trace(runId, "received", command);
  }

  handled(runId: string, command: CommandPayload): void {
    this.trace(runId, "handled", command);
    this.result(runId, command, "ok");
  }

  failed(runId: string, command: CommandPayload, error: string): void {
    this.trace(runId, "failed", command, error);
    this.result(runId, command, "error", error);
  }

  private clearDedupeWindowIfNeeded(): void {
    this.pollIterations += 1;
    if (this.pollIterations < this.dedupeClearEveryPolls) return;

    this.processedCommands.clear();
    this.pollIterations = 0;
  }

  private trace(
    runId: string,
    phase: CommandPhase,
    command: CommandPayload,
    error?: string
  ): void {
    void this.client
      .emit(runId, {
        runId,
        seq: 0,
        type: "command.trace",
        payload: {
          phase,
          commandId: command.commandId,
          commandType: command.type,
          ...(error ? { error } : {}),
        },
        ts: "",
      } satisfies RunChannelMessage<CommandTracePayload>)
      .catch(() => {});
  }

  private result(
    runId: string,
    command: CommandPayload,
    status: CommandStatus,
    error?: string
  ): void {
    void this.client
      .emit(runId, {
        runId,
        seq: 0,
        type: "command.result",
        payload: {
          commandId: command.commandId,
          commandType: command.type,
          status,
          ...(error ? { error } : {}),
        },
        ts: "",
      } satisfies RunChannelMessage<CommandResultPayload>)
      .catch(() => {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
