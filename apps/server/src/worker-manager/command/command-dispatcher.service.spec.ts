import { describe, expect, it, vi } from "vitest";
import type { RunConfig } from "@agework/shared/protocol";
import { WorkerCommandDispatcher } from "./command-dispatcher.service";

function makeRunConfig(): RunConfig {
  return {
    runId: "run-1",
    conversationId: "conversation-1",
    workspaceId: "ws-1",
    input: { prompt: "hello" },
  } as RunConfig;
}

function makeService() {
  const configStore = { register: vi.fn(), unregister: vi.fn() };
  const commandQueue = {
    pushByOwnerId: vi.fn(),
    cleanupByOwnerId: vi.fn(),
  };
  const service = new WorkerCommandDispatcher(
    configStore as never,
    commandQueue as never
  );
  return { service, configStore, commandQueue };
}

describe("WorkerCommandDispatcher", () => {
  it("opens a session: stores config without enqueuing a command", () => {
    const { service, configStore, commandQueue } = makeService();

    service.openSession({
      runId: "run-1",
      ownerId: "owner-1",
      runConfig: makeRunConfig(),
    });

    expect(configStore.register).toHaveBeenCalledWith("run-1", makeRunConfig());
    // 首个 user_message 由 run 侧 RunDriver 显式下发，openSession 不再代发。
    expect(commandQueue.pushByOwnerId).not.toHaveBeenCalled();
  });

  it("increments command sequence per owner", () => {
    const { service, commandQueue } = makeService();

    service.sendCommand("owner-1", "run-1", {
      type: "user_message",
      commandId: "command-1",
      runId: "run-1",
    });
    service.sendCommand("owner-1", "run-1", {
      type: "cancel",
      commandId: "command-2",
      runId: "run-1",
      conversationId: "conversation-1",
    });

    expect(commandQueue.pushByOwnerId).toHaveBeenNthCalledWith(
      1,
      "owner-1",
      expect.objectContaining({ runId: "run-1", seq: 1 })
    );
    expect(commandQueue.pushByOwnerId).toHaveBeenNthCalledWith(
      2,
      "owner-1",
      expect.objectContaining({
        runId: "run-1",
        seq: 2,
        payload: expect.objectContaining({ type: "cancel" }),
      })
    );
  });

  it("cleans run and owner session state", () => {
    const { service, configStore, commandQueue } = makeService();

    service.cleanupRun("run-1");
    service.cleanupByOwnerId("owner-1");

    expect(configStore.unregister).toHaveBeenCalledWith("run-1");
    expect(commandQueue.cleanupByOwnerId).toHaveBeenCalledWith("owner-1");
  });
});
