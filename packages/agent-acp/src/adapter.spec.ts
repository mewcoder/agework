import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { AcpAgentAdapter } from "./adapter";
import { FAKE_ACP_AGENT_PATH } from "./testing/fake-acp-agent";

function childEnv(scenario: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") base[k] = v;
  }
  return { ...base, ...scenario };
}

function makeAdapter(
  scenario: Record<string, string> = {},
  pendingActions: (string | null)[] = []
): AcpAgentAdapter {
  return new AcpAgentAdapter({
    command: process.execPath,
    args: [FAKE_ACP_AGENT_PATH],
    cwd: process.cwd(),
    env: childEnv(scenario),
    agentType: "opencode",
    pendingActionSink: (e) => pendingActions.push(e.pendingAction),
  });
}

function input(threadId: string, runId: string, text = "hello"): RunAgentInput {
  return {
    threadId,
    runId,
    messages: [{ id: "u1", role: "user", content: text }],
  } as RunAgentInput;
}

const waitFor = async (fn: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("AcpAgentAdapter", () => {
  it("runs a prompt end-to-end and emits the AG-UI lifecycle", async () => {
    const adapter = makeAdapter({ FAKE_ACP_REPLY: "hi from opencode" });
    const events: BaseEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      adapter.run(input("t1", "r1")).subscribe({
        next: (e) => events.push(e),
        complete: resolve,
        error: reject,
      });
    });

    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.MESSAGES_SNAPSHOT);

    const sessionCustom = events.find(
      (e) => e.type === EventType.CUSTOM && (e as unknown as { name: string }).name === "agent.sessionId"
    );
    expect(sessionCustom).toBeTruthy();

    const finished = events.find((e) => e.type === EventType.RUN_FINISHED) as unknown as {
      result: { stopReason: string; agent: string; protocol: string };
    };
    expect(finished.result.stopReason).toBe("end_turn");
    expect(finished.result.agent).toBe("opencode");
    expect(finished.result.protocol).toBe("acp");

    const text = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => (e as unknown as { delta: string }).delta)
      .join("");
    expect(text).toBe("hi from opencode");
  });

  it("emits reported session modes and applies forwardedProps.acpModeId via set_mode", async () => {
    const runOnce = async (
      forwardedProps?: Record<string, unknown>,
      scenario: Record<string, string> = { FAKE_ACP_MODES: "1" }
    ) => {
      const adapter = makeAdapter(scenario);
      const events: BaseEvent[] = [];
      await new Promise<void>((resolve, reject) => {
        adapter
          .run({
            ...input(`t-modes-${forwardedProps ? "set" : "default"}`, "r1"),
            ...(forwardedProps ? { forwardedProps } : {}),
          } as RunAgentInput)
          .subscribe({ next: (e) => events.push(e), complete: resolve, error: reject });
      });
      return events.find(
        (e) =>
          e.type === EventType.CUSTOM &&
          (e as unknown as { name: string }).name === "agent.modes"
      ) as unknown as { value: { currentModeId: string; availableModes: { id: string }[] } };
    };

    const reported = await runOnce();
    expect(reported.value.currentModeId).toBe("build");
    expect(reported.value.availableModes.map((m) => m.id)).toEqual(["build", "plan"]);

    const switched = await runOnce({ acpModeId: "plan" });
    expect(switched.value.currentModeId).toBe("plan");

    // opencode 形态:modes 经 config option(category "mode")暴露,
    // 切换走 session/set_config_option。
    const configOptionScenario = { FAKE_ACP_MODES_CONFIG_OPTION: "1" };
    const reportedViaConfig = await runOnce(undefined, configOptionScenario);
    expect(reportedViaConfig.value.currentModeId).toBe("build");
    expect(reportedViaConfig.value.availableModes.map((m) => m.id)).toEqual([
      "build",
      "plan",
    ]);

    const switchedViaConfig = await runOnce(
      { acpModeId: "plan" },
      configOptionScenario
    );
    expect(switchedViaConfig.value.currentModeId).toBe("plan");
  });

  it("surfaces a permission request as an interrupt and resumes on approval", async () => {
    const pendingActions: (string | null)[] = [];
    const adapter = makeAdapter(
      { FAKE_ACP_REQUEST_PERMISSION: "1", FAKE_ACP_REPLY: "approved reply" },
      pendingActions
    );
    const events: BaseEvent[] = [];
    const done = new Promise<void>((resolve, reject) => {
      adapter.run(input("t2", "r2", "do it")).subscribe({
        next: (e) => events.push(e),
        complete: resolve,
        error: reject,
      });
    });

    // Wait for the terminal interrupt RUN_FINISHED.
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === EventType.RUN_FINISHED &&
          (e as unknown as { outcome?: { type: string } }).outcome?.type === "interrupt"
      )
    );
    expect(pendingActions).toContain("question");

    // Approve the permission → resume the same turn.
    const resolved = adapter.resolveApproval(
      "t2",
      { choice: "allow-once" },
      "resume-r2"
    );
    expect(resolved).toBe(true);

    await done;

    // A resume RUN_STARTED carried the new runId.
    const resumeStarted = events.find(
      (e) => e.type === EventType.RUN_STARTED && (e as unknown as { runId?: string }).runId === "resume-r2"
    );
    expect(resumeStarted).toBeTruthy();

    // Final RUN_FINISHED (non-interrupt) completed the turn.
    const finalFinish = events
      .filter((e) => e.type === EventType.RUN_FINISHED)
      .at(-1) as unknown as { result?: { stopReason: string } };
    expect(finalFinish.result?.stopReason).toBe("end_turn");
    expect(pendingActions.at(-1)).toBeNull();
  });

  it("interrupt() aborts a hanging run", async () => {
    const adapter = makeAdapter({ FAKE_ACP_HANG: "1" });
    const events: BaseEvent[] = [];
    const done = new Promise<void>((resolve, reject) => {
      adapter.run(input("t3", "r3")).subscribe({
        next: (e) => events.push(e),
        complete: resolve,
        error: reject,
      });
    });

    await waitFor(() => events.some((e) => e.type === EventType.RUN_STARTED));
    await adapter.interrupt("t3");
    await done;
    // The run terminated (completed the observable) without hanging.
    expect(events.some((e) => e.type === EventType.RUN_STARTED)).toBe(true);
  });
});
