import { describe, expect, it, vi } from "vitest";
import type { RunConfig } from "@agework/shared/protocol";
import { WorkerCommandDispatcher } from "./command-dispatcher";

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
    pushByWorkerId: vi.fn(),
    cleanupByWorkerId: vi.fn(),
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
      workerId: "worker-1",
      runConfig: makeRunConfig(),
    });

    expect(configStore.register).toHaveBeenCalledWith("run-1", makeRunConfig());
    // 首个 user_message 由 run 侧 RunDriver 显式下发，openSession 不再代发。
    expect(commandQueue.pushByWorkerId).not.toHaveBeenCalled();
  });

  it("increments command sequence per owner", () => {
    const { service, commandQueue } = makeService();

    service.sendCommand("worker-1", "run-1", {
      type: "user_message",
      commandId: "command-1",
      runId: "run-1",
    });
    service.sendCommand("worker-1", "run-1", {
      type: "cancel",
      commandId: "command-2",
      runId: "run-1",
      conversationId: "conversation-1",
    });

    expect(commandQueue.pushByWorkerId).toHaveBeenNthCalledWith(
      1,
      "worker-1",
      expect.objectContaining({ runId: "run-1", seq: 1 })
    );
    expect(commandQueue.pushByWorkerId).toHaveBeenNthCalledWith(
      2,
      "worker-1",
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
    service.cleanupByWorkerId("worker-1");

    expect(configStore.unregister).toHaveBeenCalledWith("run-1");
    expect(commandQueue.cleanupByWorkerId).toHaveBeenCalledWith("worker-1");
  });
});
