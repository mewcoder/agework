import { describe, expect, it, vi } from "vitest";
import type { CommandPayload } from "@agework/shared/protocol";
import { PersistentRunManager } from "./persistent-run-manager";

function makeManager() {
  const client = {
    emit: vi.fn().mockResolvedValue(undefined),
    fetchRunConfig: vi.fn(),
    cleanup: vi.fn(),
  };

  return {
    client,
    manager: new PersistentRunManager(client),
  };
}

describe("PersistentRunManager", () => {
  it("fails cancel commands that do not match an active run", async () => {
    const { client, manager } = makeManager();
    const command: CommandPayload = {
      type: "cancel",
      commandId: "cmd-cancel",
      runId: "run-1",
      conversationId: "conversation-1",
    };

    await manager.handle(command);

    expect(client.emit).toHaveBeenNthCalledWith(
      1,
      "run-1",
      expect.objectContaining({
        type: "command.trace",
        payload: expect.objectContaining({
          phase: "received",
          commandId: "cmd-cancel",
        }),
      })
    );
    expect(client.emit).toHaveBeenNthCalledWith(
      2,
      "run-1",
      expect.objectContaining({
        type: "command.trace",
        payload: expect.objectContaining({
          phase: "failed",
          error: "no active run matched",
        }),
      })
    );
    expect(client.emit).toHaveBeenNthCalledWith(
      3,
      "run-1",
      expect.objectContaining({
        type: "command.result",
        payload: expect.objectContaining({
          status: "error",
          error: "no active run matched",
        }),
      })
    );
  });

  it("fails interrupt commands that do not match an active run", async () => {
    const { client, manager } = makeManager();
    const command: CommandPayload = {
      type: "interrupt",
      commandId: "cmd-interrupt",
      runId: "run-1",
    };

    await manager.handle(command);

    expect(client.emit).toHaveBeenNthCalledWith(
      1,
      "run-1",
      expect.objectContaining({
        type: "command.trace",
        payload: expect.objectContaining({
          phase: "received",
          commandId: "cmd-interrupt",
        }),
      })
    );
    expect(client.emit).toHaveBeenNthCalledWith(
      3,
      "run-1",
      expect.objectContaining({
        type: "command.result",
        payload: expect.objectContaining({
          status: "error",
          error: "no active run matched",
        }),
      })
    );
  });

  it("reports a terminal error when run config cannot be fetched", async () => {
    const { client, manager } = makeManager();
    client.fetchRunConfig.mockRejectedValue(new Error("missing config"));
    const command: CommandPayload = {
      type: "user_message",
      commandId: "cmd-user",
      runId: "run-1",
      input: { threadId: "conversation-1" },
    };

    await manager.handle(command);

    expect(client.emit).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        type: "command.result",
        payload: expect.objectContaining({
          commandId: "cmd-user",
          status: "error",
        }),
      })
    );
    expect(client.emit).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        type: "run.status",
        payload: expect.objectContaining({
          status: "error",
          error: "Failed to fetch run config: Error: missing config",
        }),
      })
    );
  });
});
