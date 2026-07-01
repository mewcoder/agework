import { describe, it, expect, vi, beforeEach } from "vitest";
import { SandboxRunExecutor } from "./sandbox.executor";
import { WorkerHostService } from "../../worker-host/worker-host.service";
import type { RunEventPort } from "./executor";
import type {
  AcquireInstanceResult,
  CommandPayload,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";

/**
 * SandboxRunExecutor 是 sandbox 执行编排器:向 worker-host 取得持久容器实例后,直接对
 * worker-host 完成 openSession / 命令下发 / cleanup;就绪/早取消/失败由 acquire 结果回流。
 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("SandboxRunExecutor — orchestrates worker-host", () => {
  let workerHost: {
    acquireSandboxInstanceForRun: ReturnType<typeof vi.fn>;
    releaseSandboxInstanceForRun: ReturnType<typeof vi.fn>;
    recoverOrphanSandboxInstance: ReturnType<typeof vi.fn>;
    openSession: ReturnType<typeof vi.fn>;
    sendCommand: ReturnType<typeof vi.fn>;
    cleanupRun: ReturnType<typeof vi.fn>;
  };
  let receiver: {
    recordCommandSent: ReturnType<typeof vi.fn>;
    notifyWorkerError: ReturnType<typeof vi.fn>;
    notifyCancelledBeforeReady: ReturnType<typeof vi.fn>;
  };
  let executor: SandboxRunExecutor;
  let onRuntimeInstanceIdReady: ReturnType<typeof vi.fn>;

  const input = {
    runConfig: { runId: "run-1", conversationId: "conversation-1" },
    runtimeTarget: { runtimeType: "sandbox", ownerId: "owner-1" },
    onRuntimeInstanceIdReady: undefined,
  } as unknown as WorkerExecutionStartInput;

  const ready: AcquireInstanceResult = {
    outcome: "ready",
    runtimeInstanceId: "inst-1",
  };

  beforeEach(() => {
    workerHost = {
      acquireSandboxInstanceForRun: vi.fn().mockResolvedValue(ready),
      releaseSandboxInstanceForRun: vi.fn(),
      recoverOrphanSandboxInstance: vi.fn().mockResolvedValue(undefined),
      openSession: vi.fn(),
      sendCommand: vi.fn(),
      cleanupRun: vi.fn(),
    };
    receiver = {
      recordCommandSent: vi.fn().mockResolvedValue(undefined),
      notifyWorkerError: vi.fn().mockResolvedValue(undefined),
      notifyCancelledBeforeReady: vi.fn().mockResolvedValue(undefined),
    };
    onRuntimeInstanceIdReady = vi.fn();
    (input as { onRuntimeInstanceIdReady?: unknown }).onRuntimeInstanceIdReady =
      onRuntimeInstanceIdReady;
    executor = new SandboxRunExecutor(
      workerHost as unknown as WorkerHostService
    );
    executor.setRunEventPort(receiver as unknown as RunEventPort);
  });

  it("declares the sandbox runtime type", () => {
    expect(executor.type).toBe("sandbox");
  });

  it("returns a handle synchronously and acquires the instance", () => {
    const handle = executor.start(input);
    expect(handle.runId).toBe("run-1");
    expect(handle.runtimeInstanceId).toBe("");
    expect(workerHost.acquireSandboxInstanceForRun).toHaveBeenCalledWith(input);
  });

  it("on ready: opens the worker session and dispatches the first user_message", async () => {
    const handle = executor.start(input);
    await flush();

    expect(handle.runtimeInstanceId).toBe("inst-1");
    expect(onRuntimeInstanceIdReady).toHaveBeenCalledWith("inst-1");
    expect(workerHost.openSession).toHaveBeenCalledWith({
      runId: "run-1",
      ownerId: "owner-1",
      runConfig: input.runConfig,
    });
    expect(workerHost.sendCommand).toHaveBeenCalledWith(
      "owner-1",
      "run-1",
      expect.objectContaining({ type: "user_message", runId: "run-1" })
    );
    expect(receiver.recordCommandSent).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", commandType: "user_message" })
    );
  });

  it("on cancelledBeforeReady: notifies run, never opens a session", async () => {
    workerHost.acquireSandboxInstanceForRun.mockResolvedValueOnce({
      outcome: "cancelledBeforeReady",
    });
    executor.start(input);
    await flush();

    expect(workerHost.openSession).not.toHaveBeenCalled();
    expect(receiver.notifyCancelledBeforeReady).toHaveBeenCalledWith("run-1");
  });

  it("on error: notifies run, never opens a session", async () => {
    workerHost.acquireSandboxInstanceForRun.mockResolvedValueOnce({
      outcome: "error",
      error: "sandbox create failed",
    });
    executor.start(input);
    await flush();

    expect(workerHost.openSession).not.toHaveBeenCalled();
    expect(receiver.notifyWorkerError).toHaveBeenCalledWith(
      "run-1",
      "sandbox create failed"
    );
  });

  it("cancel before ready: releases the instance and skips the session even if ready arrives later", async () => {
    let resolveAcquire!: (result: AcquireInstanceResult) => void;
    workerHost.acquireSandboxInstanceForRun.mockReturnValueOnce(
      new Promise<AcquireInstanceResult>((resolve) => {
        resolveAcquire = resolve;
      })
    );
    const handle = executor.start(input);

    executor.cancel(handle);
    expect(workerHost.releaseSandboxInstanceForRun).toHaveBeenCalledWith(
      "run-1"
    );

    resolveAcquire(ready);
    await flush();

    expect(workerHost.openSession).not.toHaveBeenCalled();
    expect(receiver.notifyCancelledBeforeReady).toHaveBeenCalledWith("run-1");
  });

  it("cancel after ready: dispatches a cancel command and records its trace", async () => {
    const handle = executor.start(input);
    await flush();
    workerHost.sendCommand.mockClear();
    receiver.recordCommandSent.mockClear();

    executor.cancel(handle);

    expect(workerHost.sendCommand).toHaveBeenCalledWith(
      "owner-1",
      "run-1",
      expect.objectContaining({ type: "cancel", runId: "run-1" })
    );
    expect(receiver.recordCommandSent).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", commandType: "cancel" })
    );
  });

  it("sendCommand forwards to worker-host and records a command.sent trace", async () => {
    const handle = executor.start(input);
    await flush();
    workerHost.sendCommand.mockClear();
    receiver.recordCommandSent.mockClear();

    const command = {
      type: "approval_resolved",
      commandId: "cmd-1",
      conversationId: "conversation-1",
    } as unknown as CommandPayload;
    executor.sendCommand(handle, command);

    expect(workerHost.sendCommand).toHaveBeenCalledWith(
      "owner-1",
      "run-1",
      command
    );
    expect(receiver.recordCommandSent).toHaveBeenCalledWith({
      runId: "run-1",
      commandId: "cmd-1",
      commandType: "approval_resolved",
    });
  });

  it("sendCommand without active state is dropped and not recorded", () => {
    const command = {
      type: "approval_resolved",
      commandId: "cmd-1",
      conversationId: "conversation-1",
    } as unknown as CommandPayload;
    executor.sendCommand(
      {
        runId: "ghost",
        runtimeType: "sandbox",
        runtimeInstanceId: "",
        conversationId: "c",
      },
      command
    );

    expect(workerHost.sendCommand).not.toHaveBeenCalled();
    expect(receiver.recordCommandSent).not.toHaveBeenCalled();
  });

  it("cleanup releases the worker session and the runtime instance", async () => {
    executor.start(input);
    await flush();

    executor.cleanup("run-1");

    expect(workerHost.cleanupRun).toHaveBeenCalledWith("run-1");
    expect(workerHost.releaseSandboxInstanceForRun).toHaveBeenCalledWith(
      "run-1"
    );
  });

  it("terminateExecution cleans up the run session", async () => {
    executor.start(input);
    await flush();

    executor.terminateExecution("run-1", "shutdown");

    expect(workerHost.cleanupRun).toHaveBeenCalledWith("run-1");
    expect(workerHost.releaseSandboxInstanceForRun).toHaveBeenCalledWith(
      "run-1"
    );
  });

  it("cleanupInterruptedExecution recovers the orphan runtime instance", async () => {
    await executor.cleanupInterruptedExecution("inst-9");
    expect(workerHost.recoverOrphanSandboxInstance).toHaveBeenCalledWith(
      "inst-9"
    );
  });
});
