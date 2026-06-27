import { describe, expect, it, vi } from "vitest";
import type {
  CommandPayload,
  RunChannelMessage,
} from "@agework/shared/protocol";
import { CommandLoop } from "./command-loop";

function commandMessage(
  payload: CommandPayload
): RunChannelMessage<CommandPayload> {
  return {
    runId: "runId" in payload && payload.runId ? payload.runId : "run-1",
    seq: 1,
    type: "command",
    payload,
    ts: "2026-06-27T00:00:00.000Z",
  };
}

function cancelCommand(commandId: string): CommandPayload {
  return {
    type: "cancel",
    commandId,
    runId: "run-1",
    conversationId: "conversation-1",
  };
}

describe("CommandLoop", () => {
  it("dispatches each commandId once within the local dedupe window", async () => {
    const handled: CommandPayload[] = [];
    const source = {
      pollCommands: vi.fn().mockResolvedValue([
        commandMessage(cancelCommand("cmd-1")),
        commandMessage(cancelCommand("cmd-1")),
        commandMessage(cancelCommand("cmd-2")),
      ]),
    };
    const loop = new CommandLoop(
      source,
      (command) => {
        handled.push(command);
        if (command.commandId === "cmd-2") loop.stop();
      },
      {
        waitMs: 25_000,
        emptyRetryDelayMs: 0,
      }
    );

    await loop.run();

    expect(source.pollCommands).toHaveBeenCalledWith(25_000);
    expect(handled.map((command) => command.commandId)).toEqual([
      "cmd-1",
      "cmd-2",
    ]);
  });

  it("clears the dedupe window after the configured poll count", async () => {
    const handled: CommandPayload[] = [];
    const source = {
      pollCommands: vi.fn().mockResolvedValue([
        commandMessage(cancelCommand("cmd-1")),
      ]),
    };
    const loop = new CommandLoop(
      source,
      (command) => {
        handled.push(command);
        if (handled.length === 2) loop.stop();
      },
      {
        waitMs: 25_000,
        emptyRetryDelayMs: 0,
        dedupeClearEveryPolls: 2,
      }
    );

    await loop.run();

    expect(source.pollCommands).toHaveBeenCalledTimes(2);
    expect(handled.map((command) => command.commandId)).toEqual([
      "cmd-1",
      "cmd-1",
    ]);
  });
});
