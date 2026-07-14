import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { RuntimeHostContract } from "@agework/shared/protocol";
import { RunLauncher, type StopActiveRun } from "./run-launcher";
import { RunRepository } from "../run.repository";
import { LiveRunRegistry } from "../live-run/live-run.registry";
import type { ConversationService } from "../../conversation/conversation.service";
import { RunEventService } from "../../run-event/run-event.service";
import { ConfigService } from "../../config/config.service";
import type { StartRunInput } from "../run.types";
import type { WorkspaceRunContext } from "../../workspace/workspace.types";

function makeWorkspaceView(
  overrides: Partial<WorkspaceRunContext> = {}
): WorkspaceRunContext {
  return {
    workspaceId: "ws-1",
    workspaceRootPath: "/tmp/ws",
    runtimeType: "native",
    scope: "workspace",
    username: "admin-1",
    runtimeHostId: "builtin",
    runtimeSource: "builtin",
    ...overrides,
  };
}

describe("RunLauncher", () => {
  let launcher: RunLauncher;
  let mockRunRepository: Partial<RunRepository>;
  let mockLiveRunRegistry: Partial<LiveRunRegistry>;
  let mockRuntimeHost: Partial<RuntimeHostContract>;
  let mockConversationEffects: Partial<ConversationService>;
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
    };
    mockLiveRunRegistry = {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn().mockReturnValue(undefined),
    };
    mockRuntimeHost = {
      submitRun: vi.fn().mockResolvedValue(undefined),
    };
    mockConversationEffects = {
      activateConversation: vi.fn().mockResolvedValue(true),
      setConversationRunState: vi.fn().mockResolvedValue(undefined),
      saveUserMessage: vi.fn().mockResolvedValue(undefined),
      saveAssistantMessage: vi.fn().mockResolvedValue(undefined),
      attachMessageToRun: vi.fn().mockResolvedValue(undefined),
      setAgentSessionId: vi.fn().mockResolvedValue(undefined),
    };
    mockRunEvents = new RunEventService({} as never, {} as never, {} as never);
    vi.spyOn(mockRunEvents, "append").mockResolvedValue({} as never);
    vi.spyOn(mockRunEvents, "forgetRun").mockImplementation(() => undefined);
    mockConfigService = {
      getDefaultRuntimeType: vi.fn().mockReturnValue("native"),
      getDefaultWorkerScope: vi.fn().mockReturnValue("user"),
      isRuntimeTypeAllowed: (t: string): t is "native" | "docker" =>
        t === "native" || t === "docker",
      isWorkerScopeAllowed: (s: string): s is "user" | "workspace" =>
        s === "user" || s === "workspace",
    };
    launcher = new RunLauncher(
      mockRunRepository as RunRepository,
      mockLiveRunRegistry as LiveRunRegistry,
      mockRuntimeHost as RuntimeHostContract,
      mockConversationEffects as ConversationService,
      mockRunEvents,
      mockConfigService as ConfigService
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds placement, creates run, submits to the host and registers the handle", async () => {
    const res = makeRes();
    await launch(makeStartInput({ res }));

    expect(mockRunRepository.create).toHaveBeenCalledWith({
      id: "run-1",
      conversationId: "conversation-1",
      agentType: "claude",
      runtimeType: "native",
    });
    expect(mockRuntimeHost.submitRun).toHaveBeenCalledWith({
      runId: "run-1",
      conversationId: "conversation-1",
      placement: {
        owner: "workspace:ws-1",
        runtimeType: "native",
        runtimeHostId: "builtin",
        workspaceId: "ws-1",
        userId: "user-1",
        username: "admin-1",
        workspacePath: "/tmp/ws",
      },
      agentProviderConfig: expect.objectContaining({
        agentType: "claude",
        source: "system",
      }),
      input: { messages: [{ id: "msg-1" }] },
    });
    expect(mockLiveRunRegistry.register).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        runId: "run-1",
        conversationId: "conversation-1",
        workspaceId: "ws-1",
        agentType: "claude",
        runtimeHandle: expect.objectContaining({
          runId: "run-1",
          runtimeHostId: "builtin",
          runtimeType: "native",
        }),
        stream: expect.objectContaining({}),
      })
    );
    const registered = (
      mockLiveRunRegistry.register as ReturnType<typeof vi.fn>
    ).mock.calls[0][1];
    expect(typeof registered.saveRun).toBe("function");
    expect(typeof registered.onAgentSessionId).toBe("function");
  });

  it("derives a user owner key for user-scope sandbox workspaces", async () => {
    await launch(
      makeStartInput({
        workspace: makeWorkspaceView({
          runtimeType: "docker",
          scope: "user",
        }),
      })
    );

    expect(mockRuntimeHost.submitRun).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: expect.objectContaining({
          owner: "user:user-1",
          runtimeType: "docker",
        }),
      })
    );
  });

  it("marks the conversation running before starting", async () => {
    await launch();
    expect(mockConversationEffects.activateConversation).toHaveBeenCalledWith(
      "conversation-1",
      "user-1"
    );
  });

  it("saves the user message and triggers title generation", async () => {
    const userMessage = {
      id: "msg-1",
      role: "user",
      content: "hi",
    } satisfies Record<string, unknown>;
    await launch(makeStartInput({ userMessage, userMessageId: "msg-1" }));

    expect(mockConversationEffects.saveUserMessage).toHaveBeenCalledWith(
      "conversation-1",
      userMessage,
      { agentType: "claude", modelProviderId: "mp-1" }
    );
  });

  it("throws BadRequestException when the runtime type is not allowed", async () => {
    mockConfigService.isRuntimeTypeAllowed = (
      _t: string
    ): _t is "native" | "docker" => false;
    await expect(launch()).rejects.toThrow(BadRequestException);
    expect(mockRuntimeHost.submitRun).not.toHaveBeenCalled();
  });

  it("uses the registered Host capability snapshot instead of the builtin allow-list", async () => {
    mockConfigService.isRuntimeTypeAllowed = (
      _t: string
    ): _t is "native" | "docker" => false;

    await launch(
      makeStartInput({
        workspace: makeWorkspaceView({
          runtimeHostId: "host-remote-1",
          runtimeSource: "registered",
          runtimeType: "docker",
          scope: "workspace",
        }),
      })
    );

    expect(mockRuntimeHost.submitRun).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: expect.objectContaining({
          runtimeHostId: "host-remote-1",
          runtimeType: "docker",
        }),
      })
    );
  });

  it("attaches the accepted user message to the created run", async () => {
    await launch(makeStartInput({ userMessageId: "msg-1" }));

    expect(mockConversationEffects.attachMessageToRun).toHaveBeenCalledWith(
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

  it("continues submitting when audit event recording fails", async () => {
    mockRunEvents.append = vi.fn().mockRejectedValue(new Error("SQLITE_BUSY"));
    const res = makeRes();

    await launch(makeStartInput({ res }));

    expect(mockRuntimeHost.submitRun).toHaveBeenCalled();
    expect(mockLiveRunRegistry.register).toHaveBeenCalled();
    expect(mockRunRepository.markError).not.toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
  });

  it("rolls back on submit failure", async () => {
    mockRuntimeHost.submitRun = vi
      .fn()
      .mockRejectedValue(new Error("spawn failed"));
    const res = makeRes();

    await launch(makeStartInput({ res }));

    expect(mockLiveRunRegistry.register).not.toHaveBeenCalled();
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "Failed to start worker"
    );
    expect(
      mockConversationEffects.setConversationRunState
    ).toHaveBeenCalledWith("conversation-1", { runStatus: "error" });
  });
});
