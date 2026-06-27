import { describe, expect, it, vi } from "vitest";
import type {
  CommandPayload,
  RunConfig,
  RuntimeTarget,
  WorkerExecutionHandle,
} from "@agework/shared/protocol";
import { ExecutionService } from "./execution.service";
import { RunExecutorRegistry } from "./executor.registry";

function makeExecutor() {
  return {
    type: "local",
    start: vi.fn(),
    sendCommand: vi.fn(),
    cancel: vi.fn(),
    terminateExecution: vi.fn(),
    cleanup: vi.fn(),
  };
}

function makeRegistry(executor: ReturnType<typeof makeExecutor>) {
  return {
    resolve: vi.fn().mockReturnValue(executor),
  } as unknown as RunExecutorRegistry;
}

const handle: WorkerExecutionHandle = {
  runId: "run-1",
  runtimeType: "local",
  runtimeInstanceId: "1:token",
  conversationId: "conversation-1",
};

describe("ExecutionService", () => {
  it("resolves the executor by runtimeType and starts worker execution", () => {
    const executor = makeExecutor();
    executor.start.mockReturnValue(handle);
    const registry = makeRegistry(executor);
    const service = new ExecutionService(registry);

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
    expect(executor.start).toHaveBeenCalledWith({
      runConfig,
      runtimeTarget,
      onRuntimeInstanceIdReady: onReady,
    });
    expect(result).toBe(handle);
  });

  it("dispatches command / cancel / terminate / cleanup by handle.runtimeType (stateless)", () => {
    const executor = makeExecutor();
    const registry = makeRegistry(executor);
    const service = new ExecutionService(registry);
    const command = {
      type: "approval_resolved",
      commandId: "command-1",
      conversationId: "conversation-1",
      answers: {},
    } as CommandPayload;

    service.sendCommand(handle, command);
    service.cancel(handle);
    service.terminateExecution(handle, "run timeout");
    service.cleanup(handle);

    expect(registry.resolve).toHaveBeenCalledWith("local");
    expect(executor.sendCommand).toHaveBeenCalledWith(handle, command);
    expect(executor.cancel).toHaveBeenCalledWith(handle);
    expect(executor.terminateExecution).toHaveBeenCalledWith(
      "run-1",
      "run timeout"
    );
    expect(executor.cleanup).toHaveBeenCalledWith("run-1");
  });
});
