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
  const access = {
    registerRun: vi.fn(),
    revokeAccess: vi.fn(),
    revokeOwner: vi.fn(),
  };
  const commandQueue = {
    pushByOwnerId: vi.fn(),
    cleanupByOwnerId: vi.fn(),
  };
  const service = new WorkerCommandDispatcher(
    configStore as never,
    access as never,
    commandQueue as never
  );
  return { service, configStore, access, commandQueue };
}

describe("WorkerCommandDispatcher", () => {
  it("opens a session: stores config, binds access, enqueues first user_message", () => {
    const { service, configStore, access, commandQueue } = makeService();

    service.openSession({
      runId: "run-1",
      ownerId: "owner-1",
      accessKey: "owner-key",
      runConfig: makeRunConfig(),
    });

    expect(configStore.register).toHaveBeenCalledWith("run-1", makeRunConfig());
    expect(access.registerRun).toHaveBeenCalledWith("run-1", "owner-key");
    expect(commandQueue.pushByOwnerId).toHaveBeenCalledWith(
      "owner-1",
      expect.objectContaining({
        runId: "run-1",
        seq: 1,
        payload: expect.objectContaining({
          type: "user_message",
          runId: "run-1",
          input: { prompt: "hello" },
        }),
      })
    );
  });

  it("increments command sequence per owner", () => {
    const { service, commandQueue } = makeService();

    service.openSession({
      runId: "run-1",
      ownerId: "owner-1",
      accessKey: "owner-key",
      runConfig: makeRunConfig(),
    });
    service.sendCommand("owner-1", "run-1", {
      type: "cancel",
      commandId: "command-2",
      runId: "run-1",
      conversationId: "conversation-1",
    });

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
    const { service, configStore, access, commandQueue } = makeService();

    service.cleanupRun("run-1");
    service.cleanupByOwnerId("owner-1");

    expect(configStore.unregister).toHaveBeenCalledWith("run-1");
    expect(access.revokeAccess).toHaveBeenCalledWith("run-1");
    expect(commandQueue.cleanupByOwnerId).toHaveBeenCalledWith("owner-1");
    expect(access.revokeOwner).toHaveBeenCalledWith("owner-1");
  });
});
