import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  AcquireInstanceResult,
  RuntimeSpec,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import { RunDriver } from "./run-driver";
import { WorkerManagerService } from "../../worker-manager/worker-manager.service";
import { RunEventService } from "../../run-event/run-event.service";

function makeWorkerManager() {
  return {
    resolveInstance: vi.fn(),
    releaseInstanceForRun: vi.fn(),
    openSession: vi.fn(),
    sendCommand: vi.fn(),
    cleanupRun: vi.fn(),
  };
}

function makeRunEvents() {
  return {
    append: vi.fn().mockResolvedValue(undefined),
    commandSent: vi.fn((input: Record<string, unknown>) => ({
      runId: input.runId,
      type: "command.sent",
      data: input,
    })),
  };
}

function makeRuntimeSpec(runtimeType: "native" | "docker"): RuntimeSpec {
  return {
    runtimeType,
    ownerId: "ws-1",
    userId: "user-1",
    workspaceId: "ws-1",
    hostPath: "/tmp/ws-1",
    runtimePath: "/tmp/ws-1",
    runtimeLogDir: "/tmp/logs",
    ...(runtimeType === "docker"
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
  runtimeType: "native" | "docker"
): WorkerExecutionStartInput {
  return {
    runConfig: {
      runId: "run-1",
      conversationId: "conversation-1",
    } as WorkerExecutionStartInput["runConfig"],
    runtimeTarget: makeRuntimeSpec(runtimeType),
    targetRuntimeId: "managed-native",
  };
}

describe.each(["native", "docker"] as const)(
  "RunDriver (%s)",
  (runtimeType) => {
    let workerManager: ReturnType<typeof makeWorkerManager>;
    let runEvents: ReturnType<typeof makeRunEvents>;
    let executor: RunDriver;
    let runEventPort: {
      notifyWorkerError: ReturnType<typeof vi.fn>;
      notifyCancelledBeforeReady: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      workerManager = makeWorkerManager();
      runEvents = makeRunEvents();
      executor = new RunDriver(
        workerManager as unknown as WorkerManagerService,
        runEvents as unknown as RunEventService
      );
      runEventPort = {
        notifyWorkerError: vi.fn().mockResolvedValue(undefined),
        notifyCancelledBeforeReady: vi.fn().mockResolvedValue(undefined),
      };
      executor.setRunEventPort(runEventPort as never);
    });

    it("calls resolveInstance and opens the session once the instance is ready", async () => {
      const ready: AcquireInstanceResult = {
        outcome: "ready",
        workerId: "worker-1",
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
        workerId: "worker-1",
        runConfig: input.runConfig,
      });
      expect(workerManager.sendCommand).toHaveBeenCalledWith(
        "worker-1",
        "run-1",
        expect.objectContaining({ type: "user_message" })
      );
      // 命令下发记账直接落 run-event 账本,不再经反向端口
      expect(runEvents.commandSent).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run-1", commandType: "user_message" })
      );
      expect(runEvents.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: "command.sent" })
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

      expect(runEventPort.notifyWorkerError).toHaveBeenCalledWith(
        "run-1",
        "boom"
      );
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
