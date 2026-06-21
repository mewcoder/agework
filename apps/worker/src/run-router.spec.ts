import { it, expect, vi } from "vitest";
import { Observable } from "rxjs";
import { RunRouter } from "./run-router";

function fakeAdapter() {
  const subjects = new Map<string, { next: (e: unknown) => void; complete: () => void; error: (e: Error) => void }>();
  const interrupt = vi.fn().mockResolvedValue(undefined);
  const adapter = {
    run: (input: any) =>
      new Observable((sub) => {
        subjects.set(input.threadId, {
          next: (e) => sub.next(e),
          complete: () => sub.complete(),
          error: (e) => sub.error(e),
        });
      }),
    interrupt,
  };
  return { adapter, subjects, interrupt };
}

it("emits events tagged with the run's runId", () => {
  const { adapter, subjects } = fakeAdapter();
  const emit = vi.fn();
  const status = vi.fn();
  const mux = new RunRouter(emit, status);
  mux.setAdapter("claude", adapter as never);

  mux.startRun("run-1", "claude", { threadId: "t-1" });
  subjects.get("t-1")!.next({ type: "X" });

  expect(emit).toHaveBeenCalledWith("run-1", { type: "X" });
});

it("runs two AG-UI threads concurrently and isolates their events", () => {
  const { adapter, subjects } = fakeAdapter();
  const emit = vi.fn();
  const mux = new RunRouter(emit, vi.fn());
  mux.setAdapter("claude", adapter as never);

  mux.startRun("run-1", "claude", { threadId: "t-1" });
  mux.startRun("run-2", "claude", { threadId: "t-2" });
  subjects.get("t-2")!.next({ type: "B" });
  subjects.get("t-1")!.next({ type: "A" });

  expect(emit).toHaveBeenCalledWith("run-2", { type: "B" });
  expect(emit).toHaveBeenCalledWith("run-1", { type: "A" });
  expect(mux.size()).toBe(2);
});

it("reports finished and drops the run on complete", () => {
  const { adapter, subjects } = fakeAdapter();
  const status = vi.fn();
  const mux = new RunRouter(vi.fn(), status);
  mux.setAdapter("claude", adapter as never);

  mux.startRun("run-1", "claude", { threadId: "t-1" });
  subjects.get("t-1")!.complete();

  expect(status).toHaveBeenCalledWith("run-1", { status: "finished" });
  expect(mux.has("run-1")).toBe(false);
});

it("cancelRun interrupts only that thread", async () => {
  const { adapter, interrupt } = fakeAdapter();
  const mux = new RunRouter(vi.fn(), vi.fn());
  mux.setAdapter("claude", adapter as never);

  mux.startRun("run-1", "claude", { threadId: "t-1" });
  await mux.cancelRun("run-1", "t-1");

  expect(interrupt).toHaveBeenCalledWith("t-1");
});

it("routes each run to its own agentType adapter", async () => {
  const claude = fakeAdapter();
  const codex = fakeAdapter();
  const emit = vi.fn();
  const mux = new RunRouter(emit, vi.fn());
  mux.setAdapter("claude", claude.adapter as never);
  mux.setAdapter("codex", codex.adapter as never);

  mux.startRun("run-c", "claude", { threadId: "t-c" });
  mux.startRun("run-x", "codex", { threadId: "t-x" });

  // claude run 的事件只来自 claude adapter
  claude.subjects.get("t-c")!.next({ type: "from-claude" });
  codex.subjects.get("t-x")!.next({ type: "from-codex" });

  expect(emit).toHaveBeenCalledWith("run-c", { type: "from-claude" });
  expect(emit).toHaveBeenCalledWith("run-x", { type: "from-codex" });

  // 取消 codex run 只打断 codex adapter，不碰 claude
  await mux.cancelRun("run-x", "t-x");
  expect(codex.interrupt).toHaveBeenCalledWith("t-x");
  expect(claude.interrupt).not.toHaveBeenCalled();
});

it("does not broadcast cancel when the run is unknown", async () => {
  const claude = fakeAdapter();
  const codex = fakeAdapter();
  const mux = new RunRouter(vi.fn(), vi.fn());
  mux.setAdapter("claude", claude.adapter as never);
  mux.setAdapter("codex", codex.adapter as never);

  const cancelled = await mux.cancelRun("missing-run", "t-x");

  expect(cancelled).toBe(false);
  expect(claude.interrupt).not.toHaveBeenCalled();
  expect(codex.interrupt).not.toHaveBeenCalled();
});

it("shutdownAll interrupts active runs and reports the supplied terminal status", async () => {
  const claude = fakeAdapter();
  const codex = fakeAdapter();
  const status = vi.fn();
  const mux = new RunRouter(vi.fn(), status);
  mux.setAdapter("claude", claude.adapter as never);
  mux.setAdapter("codex", codex.adapter as never);

  mux.startRun("run-c", "claude", { threadId: "t-c" });
  mux.startRun("run-x", "codex", { threadId: "t-x" });

  await mux.shutdownAll({ status: "error", error: "worker received SIGTERM" });

  expect(claude.interrupt).toHaveBeenCalledWith("t-c");
  expect(codex.interrupt).toHaveBeenCalledWith("t-x");
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

it("shutdownAll waits for async terminal report started by interrupt completion", async () => {
  let completeRun: (() => void) | undefined;
  const interrupt = vi.fn().mockImplementation(async () => {
    completeRun?.();
  });
  const adapter = {
    run: () =>
      new Observable((sub) => {
        completeRun = () => sub.complete();
      }),
    interrupt,
  };
  let resolveReport: (() => void) | undefined;
  const status = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveReport = resolve;
      })
  );
  const mux = new RunRouter(vi.fn(), status);
  mux.setAdapter("claude", adapter as never);
  mux.startRun("run-1", "claude", { threadId: "t-1" });

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

it("shutdownAll starts terminal reporting before waiting for a stuck interrupt", async () => {
  const interrupt = vi.fn(
    () =>
      new Promise<void>(() => {
        // never settles
      })
  );
  const adapter = {
    run: () =>
      new Observable(() => {
        // keep the run active
      }),
    interrupt,
  };
  let resolveReport: (() => void) | undefined;
  const status = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveReport = resolve;
      })
  );
  const mux = new RunRouter(vi.fn(), status);
  mux.setAdapter("claude", adapter as never);
  mux.startRun("run-1", "claude", { threadId: "t-1" });

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
  expect(interrupt).toHaveBeenCalledWith("t-1");
  expect(shutdownSettled).toBe(false);

  resolveReport?.();
  await Promise.resolve();

  expect(shutdownSettled).toBe(false);
  expect(mux.size()).toBe(0);
});

it("reports error when no adapter registered for agentType", () => {
  const status = vi.fn();
  const mux = new RunRouter(vi.fn(), status);

  mux.startRun("run-1", "codex", { threadId: "t-1" });

  expect(status).toHaveBeenCalledWith("run-1", {
    status: "error",
    error: expect.stringContaining("codex"),
  });
});
