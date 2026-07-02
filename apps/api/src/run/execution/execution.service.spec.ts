import { describe, expect, it, vi } from "vitest";
import type {
  CommandPayload,
  RunConfig,
  RuntimeTarget,
  WorkerExecutionHandle,
} from "@agework/shared/protocol";
import { ExecutionService } from "./execution.service";
import { WorkerRunExecutor } from "./worker-run.executor";

function makeExecutor() {
  return {
    start: vi.fn(),
    sendCommand: vi.fn(),
    cancel: vi.fn(),
    terminateExecution: vi.fn(),
    cleanup: vi.fn(),
    setRunEventPort: vi.fn(),
  };
}

const handle: WorkerExecutionHandle = {
  runId: "run-1",
  runtimeType: "local",
  runtimeInstanceId: "1:token",
  conversationId: "conversation-1",
};

describe("ExecutionService", () => {
  it("forwards start to the executor", () => {
    const executor = makeExecutor();
    executor.start.mockReturnValue(handle);
    const service = new ExecutionService(
      executor as unknown as WorkerRunExecutor
    );

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

    expect(executor.start).toHaveBeenCalledWith({
      runConfig,
      runtimeTarget,
      onRuntimeInstanceIdReady: onReady,
    });
    expect(result).toBe(handle);
  });

  it("forwards command / cancel / terminate / cleanup to the executor", () => {
    const executor = makeExecutor();
    const service = new ExecutionService(
      executor as unknown as WorkerRunExecutor
    );
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

    expect(executor.sendCommand).toHaveBeenCalledWith(handle, command);
    expect(executor.cancel).toHaveBeenCalledWith(handle);
    expect(executor.terminateExecution).toHaveBeenCalledWith(
      "run-1",
      "run timeout"
    );
    expect(executor.cleanup).toHaveBeenCalledWith("run-1");
  });

  it("wires the run event receiver through to the executor during module setup", () => {
    const executor = makeExecutor();
    const service = new ExecutionService(
      executor as unknown as WorkerRunExecutor
    );
    const receiver = {} as never;

    service.setRunEventPort(receiver);

    expect(executor.setRunEventPort).toHaveBeenCalledWith(receiver);
  });
});
