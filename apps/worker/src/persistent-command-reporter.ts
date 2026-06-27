import type {
  CommandPayload,
  CommandResultPayload,
  CommandTracePayload,
  RunChannelMessage,
  UpstreamMessage,
} from "@agework/shared/protocol";

type CommandPhase = CommandTracePayload["phase"];
type CommandStatus = CommandResultPayload["status"];
type CommandEmitClient = {
  emit(runId: string, msg: UpstreamMessage): Promise<void>;
};

/**
 * Persistent worker command outcome reporter.
 *
 * The worker wire uses JSON-RPC responses for command results, while timeline
 * diagnostics still use command.trace notifications. Keeping both writes here
 * makes command handlers describe intent instead of rebuilding protocol payloads.
 */
export class PersistentCommandReporter {
  constructor(private readonly client: CommandEmitClient) {}

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

  trace(
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

  result(
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
