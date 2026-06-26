import { describe, expect, it, vi } from "vitest";
import type {
  CommandPayload,
  RunConfig,
  RuntimeTarget,
  WorkerExecutionHandle,
} from "@agework/shared/protocol";
import { RuntimeProviderRegistry } from "../../runtime/providers/provider-registry";
import { RunDriver } from "./run-driver";

function makeProvider() {
  return {
    type: "local",
    startWorkerExecution: vi.fn(),
    sendCommand: vi.fn(),
    cancel: vi.fn(),
    heartbeat: vi.fn(),
    cleanup: vi.fn(),
  };
}

function makeRegistry(provider: ReturnType<typeof makeProvider>) {
  return {
    resolve: vi.fn().mockReturnValue(provider),
  } as unknown as RuntimeProviderRegistry;
}

const handle: WorkerExecutionHandle = {
  runId: "run-1",
  runtimeType: "local",
  runtimeInstanceId: "1:token",
  conversationId: "conversation-1",
};

describe("RunDriver", () => {
  it("resolves the provider by runtimeType and starts worker execution", () => {
    const provider = makeProvider();
    provider.startWorkerExecution.mockReturnValue(handle);
    const registry = makeRegistry(provider);
    const driver = new RunDriver(registry);

    const runConfig = { runId: "run-1" } as RunConfig;
    const runtimeTarget = {
      runtimeType: "local",
      ownerId: "ws-1",
      userId: "user-1",
      workspaceId: "ws-1",
      hostPath: "/tmp/ws",
      runtimePath: "/tmp/ws",
    } as RuntimeTarget;
    const onReady = vi.fn();

    const result = driver.start({
      runConfig,
      runtimeTarget,
      onRuntimeInstanceIdReady: onReady,
    });

    expect(registry.resolve).toHaveBeenCalledWith("local");
    expect(provider.startWorkerExecution).toHaveBeenCalledWith({
      runConfig,
      runtimeTarget,
      onRuntimeInstanceIdReady: onReady,
    });
    expect(result).toBe(handle);
  });

  it("dispatches command / cancel / heartbeat / cleanup by handle.runtimeType (stateless)", () => {
    const provider = makeProvider();
    const registry = makeRegistry(provider);
    const driver = new RunDriver(registry);
    const command = {
      type: "approval_resolved",
      commandId: "command-1",
      conversationId: "conversation-1",
      answers: {},
    } as CommandPayload;

    driver.sendCommand(handle, command);
    driver.cancel(handle);
    driver.heartbeat(handle);
    driver.cleanup(handle);

    expect(registry.resolve).toHaveBeenCalledWith("local");
    expect(provider.sendCommand).toHaveBeenCalledWith(handle, command);
    expect(provider.cancel).toHaveBeenCalledWith(handle);
    expect(provider.heartbeat).toHaveBeenCalledWith("run-1");
    expect(provider.cleanup).toHaveBeenCalledWith("run-1");
  });
});
