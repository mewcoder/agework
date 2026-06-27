import { it, expect, vi } from "vitest";
import { Observable } from "rxjs";
import { RunRouter } from "./run-router";
import type { AgentRunInput } from "./agent-driver";

function runInput(threadId: string): AgentRunInput {
  return {
    aguiThreadId: threadId,
    payload: { threadId },
  };
}

function fakeDriver() {
  const subjects = new Map<string, { next: (e: unknown) => void; complete: () => void; error: (e: Error) => void }>();
  const interrupt = vi.fn().mockResolvedValue(undefined);
  const cancel = vi.fn().mockResolvedValue(undefined);
  const resolveControl = vi.fn().mockReturnValue(false);
  const driver = {
    run: (input: AgentRunInput) =>
      new Observable((sub) => {
        subjects.set(input.aguiThreadId, {
          next: (e) => sub.next(e),
          complete: () => sub.complete(),
          error: (e) => sub.error(e),
        });
      }),
    interrupt,
    cancel,
    resolveControl,
  };
  return { driver, subjects, interrupt, cancel, resolveControl };
}

it("emits events tagged with the run's runId", () => {
  const { driver, subjects } = fakeDriver();
  const emit = vi.fn();
  const status = vi.fn();
  const mux = new RunRouter(emit, status);
  mux.setDriver("claude", driver as never);

  mux.startRun("run-1", "claude", runInput("t-1"));
  subjects.get("t-1")!.next({ type: "X" });

  expect(emit).toHaveBeenCalledWith("run-1", { type: "X" });
});

it("runs two AG-UI threads concurrently and isolates their events", () => {
  const { driver, subjects } = fakeDriver();
  const emit = vi.fn();
  const mux = new RunRouter(emit, vi.fn());
  mux.setDriver("claude", driver as never);

  mux.startRun("run-1", "claude", runInput("t-1"));
  mux.startRun("run-2", "claude", runInput("t-2"));
  subjects.get("t-2")!.next({ type: "B" });
  subjects.get("t-1")!.next({ type: "A" });

  expect(emit).toHaveBeenCalledWith("run-2", { type: "B" });
  expect(emit).toHaveBeenCalledWith("run-1", { type: "A" });
  expect(mux.size()).toBe(2);
});

it("reports finished and drops the run on complete", () => {
  const { driver, subjects } = fakeDriver();
  const status = vi.fn();
  const mux = new RunRouter(vi.fn(), status);
  mux.setDriver("claude", driver as never);

  mux.startRun("run-1", "claude", runInput("t-1"));
  subjects.get("t-1")!.complete();

  expect(status).toHaveBeenCalledWith("run-1", { status: "finished" });
  expect(mux.has("run-1")).toBe(false);
});

it("cancelRun cancels only that thread", async () => {
  const { driver, cancel } = fakeDriver();
  const mux = new RunRouter(vi.fn(), vi.fn());
  mux.setDriver("claude", driver as never);

  mux.startRun("run-1", "claude", runInput("t-1"));
  await mux.cancelRun("run-1", "t-1");

  expect(cancel).toHaveBeenCalledWith("t-1");
});

it("interruptRun interrupts only that thread", async () => {
  const { driver, interrupt } = fakeDriver();
  const mux = new RunRouter(vi.fn(), vi.fn());
  mux.setDriver("claude", driver as never);

  mux.startRun("run-1", "claude", runInput("t-1"));
  await mux.interruptRun("run-1");

  expect(interrupt).toHaveBeenCalledWith("t-1");
});

it("routes each run to its own agentType driver", async () => {
  const claude = fakeDriver();
  const codex = fakeDriver();
  const emit = vi.fn();
  const mux = new RunRouter(emit, vi.fn());
  mux.setDriver("claude", claude.driver as never);
  mux.setDriver("codex", codex.driver as never);

  mux.startRun("run-c", "claude", runInput("t-c"));
  mux.startRun("run-x", "codex", runInput("t-x"));

  // claude run 的事件只来自 claude driver
  claude.subjects.get("t-c")!.next({ type: "from-claude" });
  codex.subjects.get("t-x")!.next({ type: "from-codex" });

  expect(emit).toHaveBeenCalledWith("run-c", { type: "from-claude" });
  expect(emit).toHaveBeenCalledWith("run-x", { type: "from-codex" });

  // 取消 codex run 只打断 codex driver，不碰 claude
  await mux.cancelRun("run-x", "t-x");
  expect(codex.cancel).toHaveBeenCalledWith("t-x");
  expect(claude.cancel).not.toHaveBeenCalled();
});

it("does not broadcast cancel when the run is unknown", async () => {
  const claude = fakeDriver();
  const codex = fakeDriver();
  const mux = new RunRouter(vi.fn(), vi.fn());
  mux.setDriver("claude", claude.driver as never);
  mux.setDriver("codex", codex.driver as never);

  const cancelled = await mux.cancelRun("missing-run", "t-x");

  expect(cancelled).toBe(false);
  expect(claude.cancel).not.toHaveBeenCalled();
  expect(codex.cancel).not.toHaveBeenCalled();
});

it("routes control resolution to the run's driver", async () => {
  const claude = fakeDriver();
  const codex = fakeDriver();
  codex.resolveControl.mockReturnValue(true);
  const mux = new RunRouter(vi.fn(), vi.fn());
  mux.setDriver("claude", claude.driver as never);
  mux.setDriver("codex", codex.driver as never);

  mux.startRun("run-c", "claude", runInput("t-c"));
  mux.startRun("run-x", "codex", runInput("t-x"));

  const command = {
    type: "approval_resolved",
    commandId: "cmd-1",
    conversationId: "t-x",
    answers: {},
  } as const;

  await expect(mux.resolveControl("run-x", command)).resolves.toBe(true);
  expect(codex.resolveControl).toHaveBeenCalledWith(command);
  expect(claude.resolveControl).not.toHaveBeenCalled();
});

it("shutdownAll cancels active runs and reports the supplied terminal status", async () => {
  const claude = fakeDriver();
  const codex = fakeDriver();
  const status = vi.fn();
  const mux = new RunRouter(vi.fn(), status);
  mux.setDriver("claude", claude.driver as never);
  mux.setDriver("codex", codex.driver as never);

  mux.startRun("run-c", "claude", runInput("t-c"));
  mux.startRun("run-x", "codex", runInput("t-x"));

  await mux.shutdownAll({ status: "error", error: "worker received SIGTERM" });

  expect(claude.cancel).toHaveBeenCalledWith("t-c");
  expect(codex.cancel).toHaveBeenCalledWith("t-x");
  expect(status).toHaveBeenCalledWith("run-c", {
    status: "error",
    error: "worker received SIGTERM",
  });
  expect(status).toHaveBeenCalledWith("run-x", {
    status: "error",
    error: "worker received SIGTERM",
  });
  expect(mux.size()).toBe(0);
});

it("shutdownAll waits for async terminal report started by cancel completion", async () => {
  let completeRun: (() => void) | undefined;
  const cancel = vi.fn().mockImplementation(async () => {
    completeRun?.();
  });
  const driver = {
    run: () =>
      new Observable((sub) => {
        completeRun = () => sub.complete();
      }),
    interrupt: vi.fn().mockResolvedValue(undefined),
    cancel,
    resolveControl: vi.fn().mockReturnValue(false),
  };
  let resolveReport: (() => void) | undefined;
  const status = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveReport = resolve;
      })
  );
  const mux = new RunRouter(vi.fn(), status);
  mux.setDriver("claude", driver as never);
  mux.startRun("run-1", "claude", runInput("t-1"));

  let shutdownSettled = false;
  const shutdown = mux
    .shutdownAll({ status: "error", error: "worker received SIGTERM" })
    .then(() => {
      shutdownSettled = true;
    });

  await Promise.resolve();

  expect(status).toHaveBeenCalledWith("run-1", {
    status: "error",
    error: "worker received SIGTERM",
  });
  expect(shutdownSettled).toBe(false);

  resolveReport?.();
  await shutdown;

  expect(shutdownSettled).toBe(true);
  expect(mux.size()).toBe(0);
});

it("shutdownAll starts terminal reporting before waiting for a stuck cancel", async () => {
  const cancel = vi.fn(
    () =>
      new Promise<void>(() => {
        // never settles
      })
  );
  const driver = {
    run: () =>
      new Observable(() => {
        // keep the run active
      }),
    interrupt: vi.fn().mockResolvedValue(undefined),
    cancel,
    resolveControl: vi.fn().mockReturnValue(false),
  };
  let resolveReport: (() => void) | undefined;
  const status = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveReport = resolve;
      })
  );
  const mux = new RunRouter(vi.fn(), status);
  mux.setDriver("claude", driver as never);
  mux.startRun("run-1", "claude", runInput("t-1"));

  let shutdownSettled = false;
  void mux
    .shutdownAll({ status: "error", error: "worker received SIGTERM" })
    .then(() => {
      shutdownSettled = true;
    });

  await Promise.resolve();

  expect(status).toHaveBeenCalledWith("run-1", {
    status: "error",
    error: "worker received SIGTERM",
  });
  expect(cancel).toHaveBeenCalledWith("t-1");
  expect(shutdownSettled).toBe(false);

  resolveReport?.();
  await Promise.resolve();

  expect(shutdownSettled).toBe(false);
  expect(mux.size()).toBe(0);
});

it("reports error when no driver registered for agentType", () => {
  const status = vi.fn();
  const mux = new RunRouter(vi.fn(), status);

  mux.startRun("run-1", "codex", runInput("t-1"));

  expect(status).toHaveBeenCalledWith("run-1", {
    status: "error",
    error: expect.stringContaining("codex"),
  });
});
