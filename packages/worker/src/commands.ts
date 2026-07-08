import type {
  CommandPayload,
  CommandResultPayload,
  CommandTracePayload,
  RunChannelMessage,
  UpstreamMessage,
  WorkspaceFileCommandPayload,
  OwnerCommand,
} from "@agework/shared/protocol";

export type CommandPollResult = {
  commands: RunChannelMessage<CommandPayload>[];
  fileCommands: OwnerCommand<WorkspaceFileCommandPayload>[];
};

export type CommandSource = {
  pollCommands(waitMs?: number): Promise<CommandPollResult>;
};

export type CommandSink = {
  emit(runId: string, msg: UpstreamMessage): Promise<void>;
};

export type CommandClient = CommandSource & CommandSink;

export type CommandHandler = (
  command: CommandPayload
) => Promise<void> | void;

export type FileCommandHandler = (
  command: WorkspaceFileCommandPayload
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
 * Owns the resident worker command lifecycle:
 * poll commands, dedupe them, dispatch them, and report command receipts.
 *
 * 文件命令走独立分支:fire-and-forget(不 await),避免拖慢同一批次里排在后面的
 * cancel/interrupt。文件命令的 dedupe 用同一个 processedCommands 集合。
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

  async run(
    handle: CommandHandler,
    fileHandle?: FileCommandHandler
  ): Promise<void> {
    for (;;) {
      if (this.stopped) break;
      const { commands, fileCommands } = await this.client.pollCommands(
        this.options.waitMs
      );
      if (this.stopped) break;
      this.clearDedupeWindowIfNeeded();

      for (const message of commands) {
        if (this.stopped) break;
        const command = message.payload;
        if (this.processedCommands.has(command.commandId)) continue;
        this.processedCommands.add(command.commandId);
        await handle(command);
      }

      // 文件命令:fire-and-forget,不 await,不拖慢后面的 run 命令
      if (fileHandle) {
        for (const ownerCommand of fileCommands) {
          if (this.stopped) break;
          const command = ownerCommand.payload;
          if (this.processedCommands.has(command.commandId)) continue;
          this.processedCommands.add(command.commandId);
          void Promise.resolve(fileHandle(command)).catch(() => {
            // handler 内部已有 try/catch,这里兜底防 unhandled rejection
          });
        }
      }

      if (commands.length === 0 && fileCommands.length === 0) {
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
