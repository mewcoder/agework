import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  AcquireInstanceResult,
  RuntimeSpec,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import { RunDriver } from "./run-driver";
import { WorkerManagerService } from "../../worker-manager/worker-manager.service";

function makeWorkerManager() {
  return {
    resolveInstance: vi.fn(),
    releaseInstanceForRun: vi.fn(),
    openSession: vi.fn(),
    sendCommand: vi.fn(),
    cleanupRun: vi.fn(),
  };
}

function makeRuntimeSpec(runtimeType: "local" | "sandbox"): RuntimeSpec {
  return {
    runtimeType,
    ownerId: "ws-1",
    userId: "user-1",
    workspaceId: "ws-1",
    hostPath: "/tmp/ws-1",
    runtimePath: "/tmp/ws-1",
    ...(runtimeType === "sandbox"
      ? {
          sandbox: {
            isolationScope: "workspace" as const,
            mountTarget: "/workspace",
          },
        }
      : {}),
  } as RuntimeSpec;
}

function makeInput(
  runtimeType: "local" | "sandbox"
): WorkerExecutionStartInput {
  return {
    runConfig: {
      runId: "run-1",
      conversationId: "conversation-1",
    } as WorkerExecutionStartInput["runConfig"],
    runtimeTarget: makeRuntimeSpec(runtimeType),
    targetRuntimeId: "builtin-local",
  };
}

describe.each(["local", "sandbox"] as const)(
  "RunDriver (%s)",
  (runtimeType) => {
    let workerManager: ReturnType<typeof makeWorkerManager>;
    let executor: RunDriver;
    let receiver: {
      recordCommandSent: ReturnType<typeof vi.fn>;
      notifyWorkerError: ReturnType<typeof vi.fn>;
      notifyCancelledBeforeReady: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      workerManager = makeWorkerManager();
      executor = new RunDriver(
        workerManager as unknown as WorkerManagerService
      );
      receiver = {
        recordCommandSent: vi.fn().mockResolvedValue(undefined),
        notifyWorkerError: vi.fn().mockResolvedValue(undefined),
        notifyCancelledBeforeReady: vi.fn().mockResolvedValue(undefined),
      };
      executor.setRunEventPort(receiver as never);
    });

    it("calls resolveInstance and opens the session once the instance is ready", async () => {
      const ready: AcquireInstanceResult = {
        outcome: "ready",
        runtimeInstanceId: "instance-1",
      };
      workerManager.resolveInstance.mockResolvedValue(ready);
      const input = makeInput(runtimeType);

      const handle = executor.start(input);
      expect(handle.runtimeType).toBe(runtimeType);
      expect(workerManager.resolveInstance).toHaveBeenCalledWith(input);

      await Promise.resolve();
      await Promise.resolve();

      expect(workerManager.openSession).toHaveBeenCalledWith({
        runId: "run-1",
        ownerId: "ws-1",
        runConfig: input.runConfig,
      });
      expect(workerManager.sendCommand).toHaveBeenCalledWith(
        "ws-1",
        "run-1",
        expect.objectContaining({ type: "user_message" })
      );
    });

    it("notifies worker error when resolveInstance settles as error", async () => {
      workerManager.resolveInstance.mockResolvedValue({
        outcome: "error",
        error: "boom",
      });
      executor.start(makeInput(runtimeType));

      await Promise.resolve();
      await Promise.resolve();

      expect(receiver.notifyWorkerError).toHaveBeenCalledWith("run-1", "boom");
    });

    it("releases the instance through releaseInstanceForRun on cleanup", () => {
      workerManager.resolveInstance.mockResolvedValue(
        new Promise(() => {
          /* never resolves */
        })
      );
      executor.start(makeInput(runtimeType));

      executor.cleanup("run-1");

      expect(workerManager.cleanupRun).toHaveBeenCalledWith("run-1");
      expect(workerManager.releaseInstanceForRun).toHaveBeenCalledWith("run-1");
    });
  }
);
