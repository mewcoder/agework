import { describe, expect, it } from "vitest";
import { RunSessionRegistry } from "./run-session-registry.js";

describe("RunSessionRegistry", () => {
  it("owns the run lifecycle state and config together", () => {
    const sessions = new RunSessionRegistry();
    const placement = {
      userId: "user-1",
      workspaceId: "ws-1",
      scope: "workspace" as const,
      runtimeType: "native",
      userLifecycleVersion: 1,
    };
    sessions.reserve("run-1", placement);
    sessions.setConfig("run-1", { runId: "run-1" } as never);

    expect(sessions.has("run-1")).toBe(true);
    expect(sessions.listRunIds()).toEqual(["run-1"]);
    expect(sessions.isReady("run-1")).toBe(false);
    expect(sessions.getConfig("run-1")).toMatchObject({ runId: "run-1" });

    sessions.markCancelled("run-1");
    expect(sessions.isCancelled("run-1")).toBe(true);
    expect(sessions.bindWorker("run-1", "worker-1")).toBe(true);
    expect(sessions.workerId("run-1")).toBe("worker-1");

    sessions.delete("run-1");
    expect(sessions.has("run-1")).toBe(false);
    expect(sessions.listRunIds()).toEqual([]);
    expect(sessions.getConfig("run-1")).toBeUndefined();
  });

  it("deduplicates and clears tracked submissions", async () => {
    const sessions = new RunSessionRegistry();
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });

    const tracked = sessions.trackSubmission("run-1", pending);
    expect(sessions.getSubmission("run-1")).toBe(tracked);

    resolve();
    await tracked;
    expect(sessions.getSubmission("run-1")).toBeUndefined();
  });
});
