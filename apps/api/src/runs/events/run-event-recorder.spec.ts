import { describe, expect, it, vi } from "vitest";
import { RunEventRecorder, RunEventStore } from "./run-event-recorder";
import type { RecordRunEventInput } from "@agework/shared/protocol";

type StoredRunEventInput = Partial<RecordRunEventInput> & { runSeq: number };

function makeFact(
  input: Partial<RecordRunEventInput> = {}
): RecordRunEventInput {
  return {
    runId: "run-1",
    type: "system.issue",
    origin: "platform",
    ...input,
  };
}

function makeRunEventRow(input: StoredRunEventInput) {
  return {
    id: `event-${input.runSeq}`,
    runId: input.runId ?? "run-1",
    runSeq: input.runSeq,
    eventKey: input.eventKey ?? null,
    type: input.type ?? "system.issue",
    origin: input.origin ?? "platform",
    targetType: null,
    targetId: null,
    chainId: null,
    refs: null,
    summary: null,
    data: null,
    createdAt: new Date("2026-06-23T00:00:00.000Z"),
  };
}

describe("RunEventRecorder", () => {
  it("serializes concurrent appends per run and assigns monotonic runSeq", async () => {
    const store = {
      maxRunSeq: vi.fn().mockResolvedValue(0),
      insertOrGetByEventKey: vi.fn(async (input: StoredRunEventInput) =>
        makeRunEventRow(input)
      ),
    };
    const recorder = new RunEventRecorder(store as never);

    const records = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        recorder.append(makeFact({ summary: `event ${index}` }))
      )
    );

    expect(records.map((record) => record.runSeq)).toEqual([1, 2, 3, 4, 5]);
    expect(store.maxRunSeq).toHaveBeenCalledTimes(1);
    expect(
      store.insertOrGetByEventKey.mock.calls.map(([input]) => input.runSeq)
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("treats duplicate eventKey as idempotent success and allows runSeq gaps", async () => {
    const rowsByKey = new Map<string, ReturnType<typeof makeRunEventRow>>();
    const store = {
      maxRunSeq: vi.fn().mockResolvedValue(0),
      insertOrGetByEventKey: vi.fn(async (input: StoredRunEventInput) => {
        if (input.eventKey) {
          const existing = rowsByKey.get(input.eventKey);
          if (existing) return existing;
          const row = makeRunEventRow(input);
          rowsByKey.set(input.eventKey, row);
          return row;
        }
        return makeRunEventRow(input);
      }),
    };
    const recorder = new RunEventRecorder(store as never);

    const first = await recorder.append(makeFact({ eventKey: "event-key-1" }));
    const duplicate = await recorder.append(
      makeFact({ eventKey: "event-key-1" })
    );
    const next = await recorder.append(makeFact({ eventKey: "event-key-2" }));

    expect(first.runSeq).toBe(1);
    expect(duplicate.runSeq).toBe(1);
    expect(next.runSeq).toBe(3);
  });

  it("reloads max runSeq after forgetRun", async () => {
    const store = {
      maxRunSeq: vi.fn().mockResolvedValueOnce(7).mockResolvedValueOnce(10),
      insertOrGetByEventKey: vi.fn(async (input: StoredRunEventInput) =>
        makeRunEventRow(input)
      ),
    };
    const recorder = new RunEventRecorder(store as never);

    const beforeForget = await recorder.append(makeFact());
    recorder.forgetRun("run-1");
    const afterForget = await recorder.append(makeFact());

    expect(beforeForget.runSeq).toBe(8);
    expect(afterForget.runSeq).toBe(11);
    expect(store.maxRunSeq).toHaveBeenCalledTimes(2);
  });
});

describe("RunEventStore", () => {
  it("returns the existing row when an eventKey unique conflict races insert", async () => {
    const existing = makeRunEventRow({ runSeq: 1, eventKey: "event-key-1" });
    const prisma = {
      runEvent: {
        create: vi.fn().mockRejectedValue({ code: "P2002" }),
        findFirst: vi.fn().mockResolvedValue(existing),
      },
    };
    const store = new RunEventStore(prisma as never);

    const row = await store.insertOrGetByEventKey({
      runId: "run-1",
      runSeq: 2,
      eventKey: "event-key-1",
      type: "system.issue",
      origin: "platform",
    });

    expect(row).toBe(existing);
    expect(prisma.runEvent.findFirst).toHaveBeenCalledWith({
      where: { runId: "run-1", eventKey: "event-key-1" },
    });
  });
});
