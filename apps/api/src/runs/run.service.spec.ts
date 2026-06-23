import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { RunService } from "./run.service";
import { RunRepository } from "./run.repository";
import { RunActiveStore } from "./execution/run-active.store";
import { RuntimeService } from "../runtime/runtime.service";
import { ConversationService } from "../conversations/conversation.service";
import { RunEventRecorder } from "./events/run-event-recorder";
import { RunConfigAssembler } from "./run-config.assembler";
import { TitleService } from "./title.service";
import { ConfigService } from "../config/config.service";
import type { StartRunInput } from "./run-service.types";

function makePlacement(runtimeType: string) {
  const runtimePath = runtimeType === "local" ? "/tmp/ws" : "/workspace";
  return {
    runtimeType,
    isolationScope: "workspace" as const,
    userId: "user-1",
    workspaceId: "ws-1",
    hostPath: "/tmp/ws",
    runtimePath,
    mountTarget: runtimePath,
  };
}

const AGENT_EVENT_TRACE = {
  enabled: true,
  rawFilePath: "/tmp/conversation-1.raw.jsonl",
  aguiFilePath: "/tmp/conversation-1.agui.jsonl",
  runId: "run-1",
  conversationId: "conversation-1",
  workspaceId: "ws-1",
  agentType: "claude",
};

describe("RunService", () => {
  let service: RunService;
  let mockRunRepository: Partial<RunRepository>;
  let mockRunActiveStore: Partial<RunActiveStore>;
  let mockRuntimeService: Partial<RuntimeService>;
  let mockConversationService: Partial<ConversationService>;
  let mockRunEventRecorder: Partial<RunEventRecorder>;
  let mockRunConfigAssembler: Partial<RunConfigAssembler>;
  let mockTitleService: Partial<TitleService>;
  let mockConfigService: Partial<ConfigService>;

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
      agentSpec: {
        agentType: "claude",
        adapter: { kind: "claude", isEnvironmentConfig: true },
      },
      modelProviderId: "mp-1",
      input: { messages: [{ id: "msg-1" }] },
      workspace: {
        workspaceId: "ws-1",
        workspaceRootPath: "/tmp/ws",
        runtimeType: "local",
      },
      res: makeRes(),
      ...overrides,
    };
  }

  beforeEach(() => {
    mockRunRepository = {
      create: vi.fn().mockResolvedValue({ id: "run-1" }),
      findActiveByConversationId: vi.fn().mockResolvedValue(null),
      markError: vi.fn().mockResolvedValue(undefined),
      markCancelling: vi.fn().mockResolvedValue(undefined),
      markFinished: vi.fn().mockResolvedValue(undefined),
      markCancelled: vi.fn().mockResolvedValue(undefined),
      updateRuntimeHandle: vi.fn().mockResolvedValue(undefined),
    };
    mockRunActiveStore = {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn().mockReturnValue(undefined),
    };
    mockRuntimeService = {
      resolvePlacement: vi.fn().mockReturnValue(makePlacement("local")),
      startWorker: vi.fn().mockReturnValue({
        runId: "run-1",
        runtimeType: "local",
        runtimeResourceId: "1:token",
      }),
      sendControl: vi.fn(),
      cancel: vi.fn(),
      heartbeat: vi.fn(),
      cleanup: vi.fn(),
    };
    mockConversationService = {
      attachMessageToRun: vi.fn().mockResolvedValue({ count: 1 }),
      setActiveRunStatus: vi.fn().mockResolvedValue({ count: 1 }),
      saveUserMessage: vi.fn().mockResolvedValue(undefined),
      upsertMessage: vi.fn().mockResolvedValue(undefined),
      setAgentSessionId: vi.fn().mockResolvedValue(undefined),
      findOne: vi.fn().mockResolvedValue({}),
    };
    mockRunEventRecorder = {
      append: vi.fn().mockResolvedValue({} as never),
      forgetRun: vi.fn(),
    };
    mockRunConfigAssembler = {
      assemble: vi.fn().mockReturnValue({
        runId: "run-1",
        conversationId: "conversation-1",
        workspaceId: "ws-1",
        agentEventTrace: AGENT_EVENT_TRACE,
      }),
    };
    mockTitleService = { maybeGenerate: vi.fn().mockResolvedValue(undefined) };
    mockConfigService = {
      getDefaultRuntimeType: vi.fn().mockReturnValue("local"),
      getDefaultIsolationScope: vi.fn().mockReturnValue("user"),
      isRuntimeTypeAllowed: (t: string): t is "local" | "sandbox" =>
        t === "local" || t === "sandbox",
      isIsolationScopeAllowed: (s: string): s is "user" | "workspace" =>
        s === "user" || s === "workspace",
      getUserWorkspace: vi.fn().mockReturnValue("/root-user"),
    };

    service = new RunService(
      mockRunRepository as RunRepository,
      mockRunActiveStore as RunActiveStore,
      mockRuntimeService as RuntimeService,
      mockConversationService as ConversationService,
      mockRunEventRecorder as RunEventRecorder,
      mockRunConfigAssembler as RunConfigAssembler,
      mockTitleService as TitleService,
      mockConfigService as ConfigService
    );
  });

  describe("start()", () => {
    it("resolves placement, creates run, starts the worker and registers the handle", async () => {
      const res = makeRes();
      await service.start(makeStartInput({ res }));

      expect(mockRuntimeService.resolvePlacement).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "ws-1", runtimeType: "local" })
      );
      expect(mockRunConfigAssembler.assemble).toHaveBeenCalled();
      expect(mockRunRepository.create).toHaveBeenCalledWith({
        id: "run-1",
        conversationId: "conversation-1",
        agentType: "claude",
        runtimeType: "local",
      });
      expect(mockRuntimeService.startWorker).toHaveBeenCalled();
      expect(mockRunActiveStore.register).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({
          runId: "run-1",
          conversationId: "conversation-1",
          workspaceId: "ws-1",
          agentType: "claude",
          agentEventTrace: AGENT_EVENT_TRACE,
          res,
        })
      );
      expect(mockRunRepository.updateRuntimeHandle).toHaveBeenCalledWith(
        "run-1",
        "local",
        "1:token"
      );
      const registered = (
        mockRunActiveStore.register as ReturnType<typeof vi.fn>
      ).mock.calls[0][1];
      expect(typeof registered.saveRun).toBe("function");
      expect(typeof registered.onAgentSessionId).toBe("function");
    });

    it("marks the conversation running before starting", async () => {
      await service.start(makeStartInput());
      expect(mockConversationService.setActiveRunStatus).toHaveBeenCalledWith(
        "conversation-1",
        "running"
      );
    });

    it("saves the user message and triggers title generation", async () => {
      const userMessage = { id: "msg-1", role: "user", content: "hi" } as any;
      await service.start(
        makeStartInput({ userMessage, userMessageId: "msg-1" })
      );

      expect(mockConversationService.saveUserMessage).toHaveBeenCalledWith(
        "conversation-1",
        userMessage
      );
      expect(mockTitleService.maybeGenerate).toHaveBeenCalledWith(
        "conversation-1",
        "claude",
        "mp-1"
      );
    });

    it("throws BadRequestException when the runtime type is not allowed", async () => {
      mockConfigService.isRuntimeTypeAllowed = (
        _t: string
      ): _t is "local" | "sandbox" => false;
      await expect(service.start(makeStartInput())).rejects.toThrow(
        BadRequestException
      );
      expect(mockRuntimeService.resolvePlacement).not.toHaveBeenCalled();
    });

    it("wraps RunConfig assembly errors as BadRequestException", async () => {
      mockRunConfigAssembler.assemble = vi.fn().mockImplementation(() => {
        throw new Error("模型服务不可用");
      });
      await expect(service.start(makeStartInput())).rejects.toThrow(
        BadRequestException
      );
    });

    it("attaches the accepted user message to the created run", async () => {
      await service.start(makeStartInput({ userMessageId: "msg-1" }));

      expect(mockConversationService.attachMessageToRun).toHaveBeenCalledWith(
        "conversation-1",
        "msg-1",
        "run-1"
      );
      expect(mockRunEventRecorder.append).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: "message:msg-1:accepted",
          type: "message.accepted",
        })
      );
    });

    it("continues starting the worker when audit event recording fails", async () => {
      mockRunEventRecorder.append = vi
        .fn()
        .mockRejectedValue(new Error("SQLITE_BUSY"));
      const res = makeRes();

      await service.start(makeStartInput({ res }));

      expect(mockRuntimeService.startWorker).toHaveBeenCalled();
      expect(mockRunActiveStore.register).toHaveBeenCalled();
      expect(mockRunRepository.markError).not.toHaveBeenCalled();
      expect(res.write).not.toHaveBeenCalled();
    });

    it("persists the runtime handle once a sandbox provider resolves the container id asynchronously", async () => {
      // placement.runtimeType=docker（sandbox engine 解析结果），用于 body 内的 runtimeType
      mockRuntimeService.resolvePlacement = vi
        .fn()
        .mockReturnValue(makePlacement("docker"));
      mockRuntimeService.startWorker = vi
        .fn()
        .mockImplementation((_runConfig, _placement, onReady) => {
          const handle = {
            runId: "run-1",
            runtimeType: "docker",
            runtimeResourceId: "",
            conversationId: "conversation-1",
          };
          queueMicrotask(() => onReady?.("container-abc"));
          return handle;
        });

      await service.start(
        makeStartInput({
          workspace: {
            workspaceId: "ws-1",
            workspaceRootPath: "/tmp/ws",
            runtimeType: "sandbox",
          },
        })
      );
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      expect(mockRunRepository.updateRuntimeHandle).toHaveBeenCalledWith(
        "run-1",
        "docker",
        "container-abc"
      );
    });

    it("rolls back on worker start failure", async () => {
      mockRuntimeService.startWorker = vi.fn().mockImplementation(() => {
        throw new Error("spawn failed");
      });
      const res = makeRes();

      await service.start(makeStartInput({ res }));

      expect(mockRunActiveStore.register).not.toHaveBeenCalled();
      expect(mockRunRepository.markError).toHaveBeenCalledWith(
        "run-1",
        "Failed to start worker"
      );
      expect(mockConversationService.setActiveRunStatus).toHaveBeenCalledWith(
        "conversation-1",
        "error"
      );
      await Promise.resolve();
      expect(mockRunEventRecorder.forgetRun).toHaveBeenCalledWith("run-1");
    });
  });

  describe("resolveApproval()", () => {
    it("should throw NotFoundException when no active run found", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue(null);
      await expect(
        service.resolveApproval("conversation-1", {})
      ).rejects.toThrow();
    });
  });

  describe("stop()", () => {
    it("should mark cancelled and return false when no active handle but run record exists", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1" });
      mockRunActiveStore.get = vi.fn().mockReturnValue(undefined);

      const hadHandle = await service.stop("conversation-1");

      expect(mockRunRepository.markCancelled).toHaveBeenCalledWith("run-1");
      expect(hadHandle).toBe(false);
    });

    it("should cancel and return true when an active handle exists", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1" });
      const handle = {
        runtimeHandle: {
          runId: "run-1",
          runtimeType: "local",
          runtimeResourceId: "1:token",
          conversationId: "conversation-1",
        },
        stopRequested: false,
      };
      mockRunActiveStore.get = vi.fn().mockReturnValue(handle);

      const hadHandle = await service.stop("conversation-1");

      expect(mockRunRepository.markCancelling).toHaveBeenCalledWith("run-1");
      expect(mockRuntimeService.cancel).toHaveBeenCalledWith(
        handle.runtimeHandle
      );
      expect(hadHandle).toBe(true);
    });
  });

  describe("resumeStream()", () => {
    it("无活跃 run 时发终态 complete 快照并 end", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue(null);
      const res = {
        setHeader: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        writableEnded: false,
        on: vi.fn(),
      } as any;

      await service.resumeStream("conversation-1", res);

      const writes = (res.write as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as string
      );
      expect(writes.length).toBeGreaterThan(0);
      const last = JSON.parse(writes.at(-1)!.slice(6).trim());
      expect(last.status).toEqual({ type: "complete", reason: "unknown" });
      expect(res.end).toHaveBeenCalled();
    });

    it("requires_action 的 run 返回 409 不接 stream", async () => {
      mockRunRepository.findActiveByConversationId = vi
        .fn()
        .mockResolvedValue({ id: "run-1", status: "requires_action" });
      mockRunActiveStore.get = vi.fn().mockReturnValue({ runId: "run-1" });
      const res = {
        setHeader: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        writableEnded: false,
        on: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as any;

      await service.resumeStream("conversation-1", res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.write).not.toHaveBeenCalled();
    });
  });
});
