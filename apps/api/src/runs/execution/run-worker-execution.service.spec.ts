import { describe, expect, it, vi } from "vitest";
import type {
  CommandPayload,
  RunConfig,
  RuntimePlacement,
  RuntimeTarget,
  WorkerExecutionHandle,
} from "@agework/shared/protocol";
import { RuntimeProviderRegistry } from "../../runtime/providers/provider-registry";
import { RunWorkerExecutionService } from "./run-worker-execution.service";

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

describe("RunWorkerExecutionService", () => {
  it("resolves the provider by runtimeType and starts worker execution", () => {
    const provider = makeProvider();
    provider.startWorkerExecution.mockReturnValue(handle);
    const registry = makeRegistry(provider);
    const service = new RunWorkerExecutionService(registry);

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

    const result = service.start({
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

  it("dispatches command and cancel by handle.runtimeType", () => {
    const provider = makeProvider();
    const registry = makeRegistry(provider);
    const service = new RunWorkerExecutionService(registry);
    const command = {
      type: "approval_resolved",
      commandId: "command-1",
      conversationId: "conversation-1",
      answers: {},
    } as CommandPayload;

    service.sendCommand(handle, command);
    service.cancel(handle);

    expect(registry.resolve).toHaveBeenCalledWith("local");
    expect(provider.sendCommand).toHaveBeenCalledWith(handle, command);
    expect(provider.cancel).toHaveBeenCalledWith(handle);
  });

  it("heartbeat / cleanup dispatch by the runId registered at start", () => {
    const provider = makeProvider();
    provider.startWorkerExecution.mockReturnValue(handle);
    const registry = makeRegistry(provider);
    const service = new RunWorkerExecutionService(registry);

    service.start({
      runConfig: { runId: "run-1" } as RunConfig,
      runtimeTarget: { runtimeType: "local" } as RuntimeTarget,
    });

    service.heartbeat("run-1");
    expect(provider.heartbeat).toHaveBeenCalledWith("run-1");

    service.cleanup("run-1");
    expect(provider.cleanup).toHaveBeenCalledWith("run-1");

    // after cleanup the handle is unregistered → no further dispatch
    service.heartbeat("run-1");
    expect(provider.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("heartbeat / cleanup are no-ops for an unknown runId", () => {
    const provider = makeProvider();
    const registry = makeRegistry(provider);
    const service = new RunWorkerExecutionService(registry);

    service.heartbeat("ghost");
    service.cleanup("ghost");

    expect(provider.heartbeat).not.toHaveBeenCalled();
    expect(provider.cleanup).not.toHaveBeenCalled();
  });
});
