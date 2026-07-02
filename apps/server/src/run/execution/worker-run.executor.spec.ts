import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  AcquireInstanceResult,
  RuntimeTarget,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import { WorkerRunExecutor } from "./worker-run.executor";
import { WorkerHostService } from "../../worker-host/worker-host.service";

function makeWorkerHost() {
  return {
    resolveInstance: vi.fn(),
    releaseInstanceForRun: vi.fn(),
    openSession: vi.fn(),
    sendCommand: vi.fn(),
    cleanupRun: vi.fn(),
  };
}

function makeRuntimeTarget(runtimeType: "local" | "sandbox"): RuntimeTarget {
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
            sandboxEngineType: "docker" as const,
          },
        }
      : {}),
  } as RuntimeTarget;
}

function makeInput(
  runtimeType: "local" | "sandbox"
): WorkerExecutionStartInput {
  return {
    runConfig: {
      runId: "run-1",
      conversationId: "conversation-1",
    } as WorkerExecutionStartInput["runConfig"],
    runtimeTarget: makeRuntimeTarget(runtimeType),
  };
}

describe.each(["local", "sandbox"] as const)(
  "WorkerRunExecutor (%s)",
  (runtimeType) => {
    let workerHost: ReturnType<typeof makeWorkerHost>;
    let executor: WorkerRunExecutor;
    let receiver: {
      recordCommandSent: ReturnType<typeof vi.fn>;
      notifyWorkerError: ReturnType<typeof vi.fn>;
      notifyCancelledBeforeReady: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      workerHost = makeWorkerHost();
      executor = new WorkerRunExecutor(
        workerHost as unknown as WorkerHostService
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
      workerHost.resolveInstance.mockResolvedValue(ready);
      const input = makeInput(runtimeType);

      const handle = executor.start(input);
      expect(handle.runtimeType).toBe(runtimeType);
      expect(workerHost.resolveInstance).toHaveBeenCalledWith(input);

      await Promise.resolve();
      await Promise.resolve();

      expect(workerHost.openSession).toHaveBeenCalledWith({
        runId: "run-1",
        ownerId: "ws-1",
        runConfig: input.runConfig,
      });
      expect(workerHost.sendCommand).toHaveBeenCalledWith(
        "ws-1",
        "run-1",
        expect.objectContaining({ type: "user_message" })
      );
    });

    it("notifies worker error when resolveInstance settles as error", async () => {
      workerHost.resolveInstance.mockResolvedValue({
        outcome: "error",
        error: "boom",
      });
      executor.start(makeInput(runtimeType));

      await Promise.resolve();
      await Promise.resolve();

      expect(receiver.notifyWorkerError).toHaveBeenCalledWith("run-1", "boom");
    });

    it("releases the instance through releaseInstanceForRun on cleanup", () => {
      workerHost.resolveInstance.mockResolvedValue(
        new Promise(() => {
          /* never resolves */
        })
      );
      executor.start(makeInput(runtimeType));

      executor.cleanup("run-1");

      expect(workerHost.cleanupRun).toHaveBeenCalledWith("run-1");
      expect(workerHost.releaseInstanceForRun).toHaveBeenCalledWith(
        runtimeType,
        "run-1"
      );
    });
  }
);
