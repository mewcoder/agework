import { describe, expect, it, vi } from "vitest";
import type { CommandPayload } from "@agework/shared/protocol";
import { PersistentCommandReporter } from "./persistent-command-reporter";

function makeReporter() {
  const client = {
    emit: vi.fn().mockResolvedValue(undefined),
  };
  return {
    client,
    reporter: new PersistentCommandReporter(client),
  };
}

const cancelCommand: CommandPayload = {
  type: "cancel",
  commandId: "cmd-1",
  runId: "run-1",
  conversationId: "conversation-1",
};

describe("PersistentCommandReporter", () => {
  it("records handled commands as trace plus ok result", () => {
    const { client, reporter } = makeReporter();

    reporter.handled("run-1", cancelCommand);

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
    const { client, reporter } = makeReporter();

    reporter.failed("run-1", cancelCommand, "no active run matched");

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
