import { describe, it, expect, vi, beforeEach } from "vitest";
import { SandboxRunExecutor } from "./sandbox.executor";
import { RuntimeService } from "../../runtime/runtime.service";
import type { RunEventPort } from "./executor";
import type {
  CommandPayload,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";

/**
 * 适配器把 RunExecutor 契约薄转发到 RuntimeService 门面；sandbox 执行编排本身的
 * 行为测试在 runtime/sandbox/sandbox-worker.executor.spec.ts。本类额外负责命令下发的
 * command.sent trace（run 侧记录）与首个 user_message 的显式下发。
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
  let receiver: { recordCommandSent: ReturnType<typeof vi.fn> };
  let executor: SandboxRunExecutor;

  const handle = {
    runId: "run-1",
    runtimeType: "sandbox",
    runtimeInstanceId: "",
    conversationId: "conversation-1",
  };

  beforeEach(() => {
    runtimeService = {
      setSandboxWorkerEventPort: vi.fn(),
      startSandboxWorker: vi.fn().mockReturnValue(handle),
      sendSandboxCommand: vi.fn().mockReturnValue(true),
      cancelSandboxRun: vi.fn(),
      terminateSandboxRun: vi.fn(),
      cleanupSandboxRun: vi.fn(),
      recoverSandboxOrphan: vi.fn().mockResolvedValue(undefined),
    };
    receiver = { recordCommandSent: vi.fn().mockResolvedValue(undefined) };
    executor = new SandboxRunExecutor(
      runtimeService as unknown as RuntimeService
    );
    executor.setRunEventPort(receiver as unknown as RunEventPort);
  });

  it("declares the sandbox runtime type", () => {
    expect(executor.type).toBe("sandbox");
  });

  it("forwards the run event receiver as the sandbox worker event port", () => {
    expect(runtimeService.setSandboxWorkerEventPort).toHaveBeenCalledWith(
      receiver
    );
  });

  it("starts the runtime then dispatches the first user_message", () => {
    const input = {
      runConfig: {},
      runtimeTarget: {},
    } as WorkerExecutionStartInput;

    expect(executor.start(input)).toBe(handle);
    expect(runtimeService.startSandboxWorker).toHaveBeenCalledWith(input);
    expect(runtimeService.sendSandboxCommand).toHaveBeenCalledWith(
      handle,
      expect.objectContaining({ type: "user_message", runId: "run-1" })
    );
    expect(receiver.recordCommandSent).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", commandType: "user_message" })
    );
  });

  it("records a command.sent trace when dispatching a command", () => {
    const command = {
      type: "approval_resolved",
      commandId: "cmd-1",
      conversationId: "conversation-1",
    } as unknown as CommandPayload;

    executor.sendCommand(handle, command);

    expect(runtimeService.sendSandboxCommand).toHaveBeenCalledWith(
      handle,
      command
    );
    expect(receiver.recordCommandSent).toHaveBeenCalledWith({
      runId: "run-1",
      commandId: "cmd-1",
      commandType: "approval_resolved",
    });
  });

  it("does not record a command.sent trace when the command is dropped", () => {
    runtimeService.sendSandboxCommand.mockReturnValueOnce(false);
    const command = {
      type: "approval_resolved",
      commandId: "cmd-1",
      conversationId: "conversation-1",
    } as unknown as CommandPayload;

    executor.sendCommand(handle, command);

    expect(runtimeService.sendSandboxCommand).toHaveBeenCalledWith(
      handle,
      command
    );
    expect(receiver.recordCommandSent).not.toHaveBeenCalled();
  });

  it("records a command.sent trace for a cancel only when one was dispatched", () => {
    const cancelCommand = {
      type: "cancel",
      commandId: "cancel-1",
      runId: "run-1",
      conversationId: "conversation-1",
    } as CommandPayload;
    runtimeService.cancelSandboxRun.mockReturnValueOnce(cancelCommand);

    executor.cancel(handle);

    expect(runtimeService.cancelSandboxRun).toHaveBeenCalledWith(handle);
    expect(receiver.recordCommandSent).toHaveBeenCalledWith({
      runId: "run-1",
      commandId: "cancel-1",
      commandType: "cancel",
    });
  });

  it("does not record a cancel trace when cancelled before ready", () => {
    runtimeService.cancelSandboxRun.mockReturnValueOnce(undefined);

    executor.cancel(handle);

    expect(runtimeService.cancelSandboxRun).toHaveBeenCalledWith(handle);
    expect(receiver.recordCommandSent).not.toHaveBeenCalled();
  });

  it("forwards terminate, cleanup and orphan recovery", async () => {
    executor.terminateExecution("run-1", "shutdown");
    executor.cleanup("run-1");
    await executor.cleanupInterruptedExecution("container-1");

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
