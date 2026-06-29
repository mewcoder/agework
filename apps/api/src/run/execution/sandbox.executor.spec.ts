import { describe, it, expect, vi, beforeEach } from "vitest";
import { SandboxRunExecutor } from "./sandbox.executor";
import { RuntimeService } from "../../runtime/runtime.service";
import type {
  CommandPayload,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";

/**
 * 适配器只负责把 RunExecutor 契约薄转发到 RuntimeService 门面；
 * sandbox 执行编排本身的行为测试在 runtime/sandbox/sandbox-worker.executor.spec.ts。
 */
describe("SandboxRunExecutor — delegates to RuntimeService", () => {
  let runtimeService: {
    setSandboxWorkerEventPort: ReturnType<typeof vi.fn>;
    startSandboxWorker: ReturnType<typeof vi.fn>;
    sendSandboxCommand: ReturnType<typeof vi.fn>;
    cancelSandboxRun: ReturnType<typeof vi.fn>;
    terminateSandboxRun: ReturnType<typeof vi.fn>;
    cleanupSandboxRun: ReturnType<typeof vi.fn>;
    recoverSandboxOrphan: ReturnType<typeof vi.fn>;
  };
  let executor: SandboxRunExecutor;

  const handle = {
    runId: "run-1",
    runtimeType: "sandbox",
    runtimeInstanceId: "",
    conversationId: "conversation-1",
  } as WorkerExecutionHandle;

  beforeEach(() => {
    runtimeService = {
      setSandboxWorkerEventPort: vi.fn(),
      startSandboxWorker: vi.fn().mockReturnValue(handle),
      sendSandboxCommand: vi.fn(),
      cancelSandboxRun: vi.fn(),
      terminateSandboxRun: vi.fn(),
      cleanupSandboxRun: vi.fn(),
      recoverSandboxOrphan: vi.fn().mockResolvedValue(undefined),
    };
    executor = new SandboxRunExecutor(runtimeService as unknown as RuntimeService);
  });

  it("declares the sandbox runtime type", () => {
    expect(executor.type).toBe("sandbox");
  });

  it("forwards the run event receiver as the sandbox worker event sink", () => {
    const receiver = { notifyWorkerError: vi.fn() } as never;
    executor.setRunEventPort(receiver);
    expect(runtimeService.setSandboxWorkerEventPort).toHaveBeenCalledWith(
      receiver
    );
  });

  it("forwards start and returns the runtime handle", () => {
    const input = { runConfig: {}, runtimeTarget: {} } as WorkerExecutionStartInput;
    expect(executor.start(input)).toBe(handle);
    expect(runtimeService.startSandboxWorker).toHaveBeenCalledWith(input);
  });

  it("forwards command, cancel, terminate, cleanup and orphan recovery", async () => {
    const command = { type: "cancel" } as CommandPayload;
    executor.sendCommand(handle, command);
    executor.cancel(handle);
    executor.terminateExecution("run-1", "shutdown");
    executor.cleanup("run-1");
    await executor.cleanupInterruptedExecution("container-1");

    expect(runtimeService.sendSandboxCommand).toHaveBeenCalledWith(
      handle,
      command
    );
    expect(runtimeService.cancelSandboxRun).toHaveBeenCalledWith(handle);
    expect(runtimeService.terminateSandboxRun).toHaveBeenCalledWith(
      "run-1",
      "shutdown"
    );
    expect(runtimeService.cleanupSandboxRun).toHaveBeenCalledWith("run-1");
    expect(runtimeService.recoverSandboxOrphan).toHaveBeenCalledWith(
      "container-1"
    );
  });
});
