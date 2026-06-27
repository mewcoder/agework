import type {
  CommandPayload,
  RunChannelMessage,
} from "@agework/shared/protocol";

export type CommandSource = {
  pollCommands(waitMs?: number): Promise<RunChannelMessage<CommandPayload>[]>;
};

export type CommandHandler = (
  command: CommandPayload
) => Promise<void> | void;

type CommandLoopOptions = {
  waitMs: number;
  emptyRetryDelayMs: number;
  dedupeClearEveryPolls?: number;
};

/**
 * Polls worker-host commands and dispatches them exactly once per local window.
 *
 * This owns the transport loop mechanics only. It does not interpret commands
 * or know run lifecycle state; callers inject the command source and handler.
 */
export class CommandLoop {
  private readonly processedCommands = new Set<string>();
  private readonly dedupeClearEveryPolls: number;
  private pollIterations = 0;
  private stopped = false;

  constructor(
    private readonly source: CommandSource,
    private readonly handle: CommandHandler,
    private readonly options: CommandLoopOptions
  ) {
    this.dedupeClearEveryPolls = options.dedupeClearEveryPolls ?? 100;
  }

  async run(): Promise<void> {
    for (;;) {
      if (this.stopped) break;
      const commands = await this.source.pollCommands(this.options.waitMs);
      if (this.stopped) break;
      this.clearDedupeWindowIfNeeded();

      for (const message of commands) {
        if (this.stopped) break;
        const command = message.payload;
        if (this.processedCommands.has(command.commandId)) continue;
        this.processedCommands.add(command.commandId);
        await this.handle(command);
      }

      if (commands.length === 0) {
        await sleep(this.options.emptyRetryDelayMs);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private clearDedupeWindowIfNeeded(): void {
    this.pollIterations += 1;
    if (this.pollIterations < this.dedupeClearEveryPolls) return;

    this.processedCommands.clear();
    this.pollIterations = 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
