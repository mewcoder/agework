import { describe, expect, it, vi } from "vitest";
import type {
  RecordRunEventInput,
  RunEventRecord,
} from "@agework/shared/protocol";
import { RunEventRepository } from "./run-event.repository";
import { RunEventService, compactData } from "./run-event.service";

type StoredRunEventInput = Partial<RecordRunEventInput> & { runSeq: number };

function makeEvent(
  input: Partial<RecordRunEventInput> = {}
): RecordRunEventInput {
  return {
    runId: "run-1",
    type: "system.issue",
    origin: "platform",
    ...input,
  };
}

function makeRunEventRecord(input: StoredRunEventInput): RunEventRecord {
  return {
    id: `event-${input.runSeq}`,
    runId: input.runId ?? "run-1",
    runSeq: input.runSeq,
    eventKey: input.eventKey ?? null,
    type: input.type ?? "system.issue",
    origin: (input.origin ?? "platform") as RunEventRecord["origin"],
    targetType: null,
    targetId: null,
    chainId: null,
    refs: null,
    summary: null,
    data: null,
    createdAt: "2026-06-23T00:00:00.000Z",
  };
}

function makeDbRunEventRow(input: StoredRunEventInput) {
  return {
    ...makeRunEventRecord(input),
    createdAt: new Date("2026-06-23T00:00:00.000Z"),
  };
}

describe("compactData", () => {
  it("removes undefined values and preserves JSON-safe values", () => {
    expect(
      compactData({
        keep: "x",
        drop: undefined,
        nested: { yes: 1, no: undefined },
        arr: [1, null, "two"],
      })
    ).toEqual({
      keep: "x",
      nested: { yes: 1 },
      arr: [1, null, "two"],
    });
  });

  it("converts non-JSON-safe values to strings", () => {
    const result = compactData({ fn: () => {} });
    expect(typeof result.fn).toBe("string");
  });
});

describe("RunEventService events", () => {
  const service = new RunEventService({} as never);

  it("builds run.created events", () => {
    expect(
      service.runCreated({
        runId: "run-1",
        conversationId: "conv-1",
        workspaceId: "ws-1",
        agentType: "claude",
        runtimeType: "sandbox",
        isolationScope: "workspace",
      })
    ).toMatchObject({
      type: "run.created",
      origin: "platform",
      targetType: "run",
      targetId: "run-1",
      refs: { conversationId: "conv-1" },
      data: {
        component: "api",
        workspaceId: "ws-1",
        agentType: "claude",
        runtimeType: "sandbox",
        isolationScope: "workspace",
      },
    });
  });

  it("returns undefined for incomplete message/tool lifecycle events", () => {
    expect(service.messageStarted({ runId: "run-1" })).toBeUndefined();
    expect(service.messageCompleted({ runId: "run-1" })).toBeUndefined();
    expect(service.toolStarted({ runId: "run-1" })).toBeUndefined();
    expect(service.toolCompleted({ runId: "run-1" })).toBeUndefined();
    expect(service.toolFailed({ runId: "run-1" })).toBeUndefined();
  });

  it("builds command and tool events", () => {
    expect(
      service.commandSent({
        runId: "run-1",
        commandId: "cmd-1",
        commandType: "cancel",
      })
    ).toMatchObject({
      eventKey: "command:cmd-1:command.sent",
      type: "command.sent",
      summary: "cancel sent",
    });
    expect(
      service.toolFailed({
        runId: "run-1",
        toolCallId: "tool-1",
        error: "permission denied",
      })
    ).toMatchObject({
      eventKey: "tool:tool-1:failed",
      type: "tool.failed",
      summary: "permission denied",
    });
  });
});

describe("RunEventService normalizers", () => {
  const service = new RunEventService({} as never);

  it("normalizes run status payloads", () => {
    expect(
      service.fromRunStatusPayload("run-1", {
        status: "requires_action",
        pendingAction: "question",
      })
    ).toMatchObject({
      runId: "run-1",
      type: "run.status_changed",
      origin: "worker",
      targetType: "run",
      targetId: "run-1",
      data: {
        status: "requires_action",
        pendingAction: "question",
        reason: "question",
      },
    });
  });

  it("normalizes AG-UI tool failures into tool.failed events", () => {
    const events = service.fromAgUiEvent("run-1", "TOOL_CALL_RESULT", {
      type: "TOOL_CALL_RESULT",
      toolCallId: "tool-1",
      messageId: "msg-1",
      content: JSON.stringify({ error: "permission denied" }),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool.failed",
      origin: "worker",
      targetType: "tool_call",
      targetId: "tool-1",
      chainId: "tool-1",
      refs: {
        toolCallId: "tool-1",
        messageId: "msg-1",
      },
      data: {
        error: "permission denied",
      },
    });
  });

  it("only emits SDK raw events for error-like provider events", () => {
    expect(
      service.fromSdkRawEvent("run-1", {
        name: "sdk.claude.output",
        threadId: "thread-1",
      })
    ).toBeUndefined();

    expect(
      service.fromSdkRawEvent("run-1", {
        name: "sdk.claude.error",
        threadId: "thread-1",
      })
    ).toMatchObject({
      type: "system.issue",
      origin: "agent",
      data: {
        code: "sdk_error",
        providerEventName: "sdk.claude.error",
        threadId: "thread-1",
      },
    });
  });

  it("normalizes command traces and worker sequence gaps", () => {
    expect(
      service.fromCommandTrace("run-1", {
        commandId: "cmd-1",
        commandType: "cancel",
        phase: "handled",
      })
    ).toMatchObject({
      type: "command.handled",
      targetType: "command",
      targetId: "cmd-1",
      chainId: "cmd-1",
      data: { commandType: "cancel", phase: "handled" },
    });

    expect(
      service.fromWorkerSeqGap({
        runId: "run-1",
        expected: 2,
        got: 4,
        envelopeType: "agui.event",
      })
    ).toMatchObject({
      type: "system.issue",
      origin: "worker",
      summary: "expected seq 2, got 4",
      data: {
        code: "worker_seq_gap",
        severity: "warn",
        expected: 2,
        got: 4,
        envelopeType: "agui.event",
      },
    });
  });

  it("keeps AG-UI debug logging scoped to lifecycle boundaries", () => {
    expect(service.shouldLogAgUiEvent("TEXT_MESSAGE_START")).toBe(true);
    expect(service.shouldLogAgUiEvent("TEXT_MESSAGE_CONTENT")).toBe(false);
    expect(service.shouldLogAgUiEvent("RUN_ERROR")).toBe(true);
  });
});

describe("RunEventService append", () => {
  it("serializes concurrent appends per run and assigns monotonic runSeq", async () => {
    const repository = {
      maxRunSeq: vi.fn().mockResolvedValue(0),
      insertOrGetByEventKey: vi.fn(async (input: StoredRunEventInput) =>
        makeRunEventRecord(input)
      ),
    };
    const service = new RunEventService(repository as never);

    const records = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        service.append(makeEvent({ summary: `event ${index}` }))
      )
    );

    expect(records.map((record) => record.runSeq)).toEqual([1, 2, 3, 4, 5]);
    expect(repository.maxRunSeq).toHaveBeenCalledTimes(1);
    expect(
      repository.insertOrGetByEventKey.mock.calls.map(([input]) => input.runSeq)
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("treats duplicate eventKey as idempotent success and allows runSeq gaps", async () => {
    const rowsByKey = new Map<string, RunEventRecord>();
    const repository = {
      maxRunSeq: vi.fn().mockResolvedValue(0),
      insertOrGetByEventKey: vi.fn(async (input: StoredRunEventInput) => {
        if (input.eventKey) {
          const existing = rowsByKey.get(input.eventKey);
          if (existing) return existing;
          const row = makeRunEventRecord(input);
          rowsByKey.set(input.eventKey, row);
          return row;
        }
        return makeRunEventRecord(input);
      }),
    };
    const service = new RunEventService(repository as never);

    const first = await service.append(makeEvent({ eventKey: "event-key-1" }));
    const duplicate = await service.append(
      makeEvent({ eventKey: "event-key-1" })
    );
    const next = await service.append(makeEvent({ eventKey: "event-key-2" }));

    expect(first.runSeq).toBe(1);
    expect(duplicate.runSeq).toBe(1);
    expect(next.runSeq).toBe(3);
  });

  it("reloads max runSeq after forgetRun", async () => {
    const repository = {
      maxRunSeq: vi.fn().mockResolvedValueOnce(7).mockResolvedValueOnce(10),
      insertOrGetByEventKey: vi.fn(async (input: StoredRunEventInput) =>
        makeRunEventRecord(input)
      ),
    };
    const service = new RunEventService(repository as never);

    const beforeForget = await service.append(makeEvent());
    service.forgetRun("run-1");
    const afterForget = await service.append(makeEvent());

    expect(beforeForget.runSeq).toBe(8);
    expect(afterForget.runSeq).toBe(11);
    expect(repository.maxRunSeq).toHaveBeenCalledTimes(2);
  });
});

describe("RunEventRepository", () => {
  it("returns the existing row when an eventKey unique conflict races insert", async () => {
    const existing = makeDbRunEventRow({
      runSeq: 1,
      eventKey: "event-key-1",
    });
    const prisma = {
      runEvent: {
        create: vi.fn().mockRejectedValue({ code: "P2002" }),
        findFirst: vi.fn().mockResolvedValue(existing),
      },
    };
    const repository = new RunEventRepository(prisma as never);

    const record = await repository.insertOrGetByEventKey({
      runId: "run-1",
      runSeq: 2,
      eventKey: "event-key-1",
      type: "system.issue",
      origin: "platform",
    });

    expect(record.id).toBe(existing.id);
    expect(record.createdAt).toBe("2026-06-23T00:00:00.000Z");
    expect(prisma.runEvent.findFirst).toHaveBeenCalledWith({
      where: { runId: "run-1", eventKey: "event-key-1" },
    });
  });
});
