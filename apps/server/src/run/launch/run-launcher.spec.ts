import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { RunLauncher, type StopActiveRun } from "./run-launcher";
import { RunRepository } from "../run.repository";
import { LiveRunRegistry } from "../live-run/live-run.registry";
import { WorkerManagerService } from "../../worker-manager/worker-manager.service";
import { WorkerRunExecutor } from "../execution/worker-run.executor";
import { ConversationService } from "../../conversation/conversation.service";
import { RunEventService } from "../../run-event/run-event.service";
import { ConfigService } from "../../config/config.service";
import type { StartRunInput } from "../run.types";
import type { WorkspaceRunContext } from "../../workspace/workspace.types";
import type { RuntimePlacement, RuntimeTarget } from "@agework/shared/protocol";
import { CONTAINER_RUNTIME_LOG_DIR } from "../../config/registry/defaults";

const RUNTIME_LOG_DIR = "/tmp/agework-logs/runtime";

function makePlacement(runtimeType: "local" | "docker"): RuntimePlacement {
  const common = {
    userId: "user-1",
    workspaceId: "ws-1",
    hostPath: "/tmp/ws",
  };
  if (runtimeType === "local") {
    return {
      ...common,
      runtimeType: "local",
      runtimePath: "/tmp/ws",
      runtimeLogDir: RUNTIME_LOG_DIR,
    };
  }
  return {
    ...common,
    runtimeType: "docker",
    runtimePath: "/workspace",
    runtimeLogDir: CONTAINER_RUNTIME_LOG_DIR,
    sandbox: {
      isolationScope: "workspace",
      mountTarget: "/workspace",
      sandboxEngineType: "docker",
    },
  };
}

function makeRuntimeTarget(placement = makePlacement("local")): RuntimeTarget {
  return {
    ...placement,
    ownerId:
      placement.runtimeType !== "local" &&
      placement.sandbox.isolationScope === "user"
        ? placement.userId
        : placement.workspaceId,
  };
}

const AGENT_EVENT_TRACE = {
  enabled: true,
  logDir: RUNTIME_LOG_DIR,
  rawFilePath: `${RUNTIME_LOG_DIR}/conversation-1.raw.jsonl`,
  rawRuntimeFilePath: `${RUNTIME_LOG_DIR}/conversation-1.raw.jsonl`,
  aguiFilePath: `${RUNTIME_LOG_DIR}/conversation-1.agui.jsonl`,
  aguiRuntimeFilePath: `${RUNTIME_LOG_DIR}/conversation-1.agui.jsonl`,
  maxFileMb: 5,
  runId: "run-1",
  conversationId: "conversation-1",
  workspaceId: "ws-1",
  agentType: "claude",
};

function makeWorkspaceView(
  overrides: Partial<WorkspaceRunContext> = {}
): WorkspaceRunContext {
  return {
    workspaceId: "ws-1",
    workspaceRootPath: "/tmp/ws",
    runtimeType: "local",
    isolationScope: null,
    sandboxEngine: null,
    username: "admin-1",
    ...overrides,
  };
}

describe("RunLauncher", () => {
  let launcher: RunLauncher;
  let mockRunRepository: Partial<RunRepository>;
  let mockLiveRunRegistry: Partial<LiveRunRegistry>;
  let mockWorkerManager: Partial<WorkerManagerService>;
  let mockExecutor: Partial<WorkerRunExecutor>;
  let mockConversations: Partial<ConversationService>;
  let mockRunEvents: RunEventService;
  let mockConfigService: Partial<ConfigService>;
  let stopActiveRun: ReturnType<typeof vi.fn>;

  function makeRes() {
    return {
      on: vi.fn(),
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      writableEnded: false,
    } as any;
  }

  function makeStartInput(
    overrides: Partial<StartRunInput> = {}
  ): StartRunInput {
    return {
      runId: "run-1",
      conversationId: "conversation-1",
      userId: "user-1",
      agentProviderConfig: {
        agentType: "claude",
        source: "system",
      },
      modelProviderId: "mp-1",
      workspace: makeWorkspaceView(),
      input: { messages: [{ id: "msg-1" }] },
      res: makeRes(),
      ...overrides,
    };
  }

  function launch(input: StartRunInput = makeStartInput()) {
    return launcher.launch(input, {
      stopActiveRun: stopActiveRun as unknown as StopActiveRun,
    });
  }

  beforeEach(() => {
    stopActiveRun = vi.fn().mockResolvedValue(true);
    mockRunRepository = {
      create: vi.fn().mockResolvedValue({ id: "run-1" }),
      findActiveByConversationId: vi.fn().mockResolvedValue(null),
      markError: vi.fn().mockResolvedValue(undefined),
      markCancelling: vi.fn().mockResolvedValue(undefined),
      markFinished: vi.fn().mockResolvedValue(undefined),
      markCancelled: vi.fn().mockResolvedValue(undefined),
      updateRuntimeHandle: vi.fn().mockResolvedValue(undefined),
    };
    mockLiveRunRegistry = {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn().mockReturnValue(undefined),
    };
    mockWorkerManager = {
      resolveRuntimeTarget: vi
        .fn()
        .mockReturnValue(makeRuntimeTarget(makePlacement("local"))),
    };
    mockExecutor = {
      start: vi.fn().mockReturnValue({
        runId: "run-1",
        runtimeType: "local",
        runtimeInstanceId: "1:token",
      }),
      sendCommand: vi.fn(),
      cancel: vi.fn(),
      cleanup: vi.fn(),
    };
    mockConversations = {
      findById: vi.fn().mockResolvedValue(undefined),
      setRunStatus: vi.fn().mockResolvedValue(true),
      setAgentSessionId: vi.fn().mockResolvedValue(undefined),
      attachMessageToRun: vi.fn().mockResolvedValue({ count: 1 }),
      saveUserMessage: vi.fn().mockResolvedValue(undefined),
      upsertMessage: vi.fn().mockResolvedValue(undefined),
    };
    mockRunEvents = new RunEventService({} as never, {} as never);
    vi.spyOn(mockRunEvents, "append").mockResolvedValue({} as never);
    vi.spyOn(mockRunEvents, "forgetRun").mockImplementation(() => undefined);
    mockConfigService = {
      getDefaultRuntimeType: vi.fn().mockReturnValue("local"),
      getDefaultIsolationScope: vi.fn().mockReturnValue("user"),
      isRuntimeTypeAllowed: (t: string): t is "local" | "docker" =>
        t === "local" || t === "docker",
      isIsolationScopeAllowed: (s: string): s is "user" | "workspace" =>
        s === "user" || s === "workspace",
      getUserWorkspace: vi.fn().mockReturnValue("/root-user"),
      getRuntimeLogDir: vi.fn().mockReturnValue(RUNTIME_LOG_DIR),
      getAgentEventTraceConfig: vi
        .fn()
        .mockReturnValue({ enabled: true, maxFileMb: 5 }),
    };
    launcher = new RunLauncher(
      mockRunRepository as RunRepository,
      mockLiveRunRegistry as LiveRunRegistry,
      mockWorkerManager as WorkerManagerService,
      mockExecutor as WorkerRunExecutor,
      mockConversations as ConversationService,
      mockRunEvents,
      mockConfigService as ConfigService
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves placement, creates run, starts the worker and registers the handle", async () => {
    const res = makeRes();
    await launch(makeStartInput({ res }));

    expect(mockWorkerManager.resolveRuntimeTarget).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", runtimeType: "local" })
    );
    expect(mockRunRepository.create).toHaveBeenCalledWith({
      id: "run-1",
      conversationId: "conversation-1",
      agentType: "claude",
      runtimeType: "local",
    });
    expect(mockExecutor.start).toHaveBeenCalledWith(
      expect.objectContaining({
        runConfig: expect.objectContaining({ runId: "run-1" }),
        runtimeTarget: expect.objectContaining({
          runtimeType: "local",
          ownerId: "ws-1",
        }),
      })
    );
    expect(mockExecutor.start).toHaveBeenCalledWith(
      expect.objectContaining({
        runConfig: expect.objectContaining({
          runId: "run-1",
          conversationId: "conversation-1",
          workspaceId: "ws-1",
          runtimePath: "/tmp/ws",
          input: { messages: [{ id: "msg-1" }] },
          agentProviderConfig: expect.objectContaining({
            agentType: "claude",
            source: "system",
          }),
          agentEventTrace: AGENT_EVENT_TRACE,
          workerLogFilePath: `${RUNTIME_LOG_DIR}/conversation-1.worker.log`,
        }),
      })
    );
    expect(mockLiveRunRegistry.register).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        runId: "run-1",
        conversationId: "conversation-1",
        workspaceId: "ws-1",
        agentType: "claude",
        agentEventTrace: AGENT_EVENT_TRACE,
        stream: expect.objectContaining({}),
      })
    );
    expect(mockRunRepository.updateRuntimeHandle).toHaveBeenCalledWith(
      "run-1",
      "local",
      "1:token"
    );
    const registered = (
      mockLiveRunRegistry.register as ReturnType<typeof vi.fn>
    ).mock.calls[0][1];
    expect(typeof registered.saveRun).toBe("function");
    expect(typeof registered.onAgentSessionId).toBe("function");
  });

  it("marks the conversation running before starting", async () => {
    await launch();
    expect(mockConversations.setRunStatus).toHaveBeenCalledWith(
      "conversation-1",
      "running"
    );
  });

  it("saves the user message and triggers title generation", async () => {
    const userMessage = { id: "msg-1", role: "user", content: "hi" } as any;
    await launch(makeStartInput({ userMessage, userMessageId: "msg-1" }));

    expect(mockConversations.saveUserMessage).toHaveBeenCalledWith(
      "conversation-1",
      userMessage,
      { agentType: "claude", modelProviderId: "mp-1" }
    );
  });

  it("throws BadRequestException when the runtime type is not allowed", async () => {
    mockConfigService.isRuntimeTypeAllowed = (
      _t: string
    ): _t is "local" | "docker" => false;
    await expect(launch()).rejects.toThrow(BadRequestException);
    expect(mockWorkerManager.resolveRuntimeTarget).not.toHaveBeenCalled();
  });

  it("wraps RunConfig assembly errors as BadRequestException", async () => {
    mockConfigService.getRuntimeLogDir = vi.fn().mockImplementation(() => {
      throw new Error("模型服务不可用");
    });
    await expect(launch()).rejects.toThrow(BadRequestException);
  });

  it("attaches the accepted user message to the created run", async () => {
    await launch(makeStartInput({ userMessageId: "msg-1" }));

    expect(mockConversations.attachMessageToRun).toHaveBeenCalledWith(
      "conversation-1",
      "msg-1",
      "run-1"
    );
    expect(mockRunEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "message:msg-1:accepted",
        type: "message.accepted",
      })
    );
  });

  it("continues starting the worker when audit event recording fails", async () => {
    mockRunEvents.append = vi.fn().mockRejectedValue(new Error("SQLITE_BUSY"));
    const res = makeRes();

    await launch(makeStartInput({ res }));

    expect(mockExecutor.start).toHaveBeenCalled();
    expect(mockLiveRunRegistry.register).toHaveBeenCalled();
    expect(mockRunRepository.markError).not.toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
  });

  it("persists the runtime handle once a docker provider resolves the container id asynchronously", async () => {
    // placement.runtimeType=docker，runtimeInstanceId 由 container provider 异步解析
    mockWorkerManager.resolveRuntimeTarget = vi
      .fn()
      .mockReturnValue(makeRuntimeTarget(makePlacement("docker")));
    mockExecutor.start = vi
      .fn()
      .mockImplementation(({ onRuntimeInstanceIdReady }) => {
        const handle = {
          runId: "run-1",
          runtimeType: "docker",
          runtimeInstanceId: "",
          conversationId: "conversation-1",
        };
        queueMicrotask(() => onRuntimeInstanceIdReady?.("container-abc"));
        return handle;
      });
    await launch(
      makeStartInput({
        workspace: makeWorkspaceView({ runtimeType: "docker" }),
      })
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(mockRunRepository.updateRuntimeHandle).toHaveBeenCalledWith(
      "run-1",
      "docker",
      "container-abc"
    );
    expect(mockExecutor.start).toHaveBeenCalledWith(
      expect.objectContaining({
        runConfig: expect.objectContaining({
          runtimePath: "/workspace",
          agentEventTrace: expect.objectContaining({
            rawRuntimeFilePath: `${CONTAINER_RUNTIME_LOG_DIR}/conversation-1.raw.jsonl`,
          }),
          workerLogFilePath: `${CONTAINER_RUNTIME_LOG_DIR}/conversation-1.worker.log`,
        }),
      })
    );
  });

  it("rolls back on worker start failure", async () => {
    mockExecutor.start = vi.fn().mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const res = makeRes();

    await launch(makeStartInput({ res }));

    expect(mockLiveRunRegistry.register).not.toHaveBeenCalled();
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "Failed to start worker"
    );
    expect(mockConversations.setRunStatus).toHaveBeenCalledWith(
      "conversation-1",
      "error"
    );
    await Promise.resolve();
    expect(mockRunEvents.forgetRun).toHaveBeenCalledWith("run-1");
  });
});
