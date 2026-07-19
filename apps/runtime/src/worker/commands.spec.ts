import { describe, expect, it, vi } from "vitest";
import type {
  CommandPayload,
  RunChannelMessage,
} from "@agework/shared/protocol";
import { WorkerCommands } from "./commands";

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

function makeClient(commands: RunChannelMessage<CommandPayload>[] = []) {
  return {
    pollCommands: vi.fn().mockResolvedValue({ commands, fileCommands: [] }),
    emit: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCommands(
  client = makeClient(),
  options: { dedupeClearEveryPolls?: number } = {}
) {
  return new WorkerCommands(client, {
    waitMs: 25_000,
    emptyRetryDelayMs: 0,
    ...options,
  });
}

describe("WorkerCommands", () => {
  it("dispatches each commandId once within the local dedupe window", async () => {
    const handled: CommandPayload[] = [];
    const client = makeClient([
        commandMessage(cancelCommand("cmd-1")),
        commandMessage(cancelCommand("cmd-1")),
        commandMessage(cancelCommand("cmd-2")),
    ]);
    const commands = makeCommands(client);

    await commands.run((command) => {
        handled.push(command);
        if (command.commandId === "cmd-2") commands.stop();
      });

    expect(client.pollCommands).toHaveBeenCalledWith(25_000);
    expect(handled.map((command) => command.commandId)).toEqual([
      "cmd-1",
      "cmd-2",
    ]);
  });

  it("clears the dedupe window after the configured poll count", async () => {
    const handled: CommandPayload[] = [];
    const client = makeClient([commandMessage(cancelCommand("cmd-1"))]);
    const commands = makeCommands(client, { dedupeClearEveryPolls: 2 });

    await commands.run((command) => {
        handled.push(command);
        if (handled.length === 2) commands.stop();
      });

    expect(client.pollCommands).toHaveBeenCalledTimes(2);
    expect(handled.map((command) => command.commandId)).toEqual([
      "cmd-1",
      "cmd-1",
    ]);
  });

  it("records handled commands as trace plus ok result", () => {
    const client = makeClient();
    const commands = makeCommands(client);

    commands.handled("run-1", cancelCommand("cmd-1"));

    expect(client.emit).toHaveBeenNthCalledWith(
      1,
      "run-1",
      expect.objectContaining({
        type: "command.trace",
        payload: {
          phase: "handled",
          commandId: "cmd-1",
          commandType: "cancel",
        },
      })
    );
    expect(client.emit).toHaveBeenNthCalledWith(
      2,
      "run-1",
      expect.objectContaining({
        type: "command.result",
        payload: {
          commandId: "cmd-1",
          commandType: "cancel",
          status: "ok",
        },
      })
    );
  });

  it("records failed commands as trace plus error result", () => {
    const client = makeClient();
    const commands = makeCommands(client);

    commands.failed("run-1", cancelCommand("cmd-1"), "no active run matched");

    expect(client.emit).toHaveBeenNthCalledWith(
      1,
      "run-1",
      expect.objectContaining({
        type: "command.trace",
        payload: {
          phase: "failed",
          commandId: "cmd-1",
          commandType: "cancel",
          error: "no active run matched",
        },
      })
    );
    expect(client.emit).toHaveBeenNthCalledWith(
      2,
      "run-1",
      expect.objectContaining({
        type: "command.result",
        payload: {
          commandId: "cmd-1",
          commandType: "cancel",
          status: "error",
          error: "no active run matched",
        },
      })
    );
  });
});
