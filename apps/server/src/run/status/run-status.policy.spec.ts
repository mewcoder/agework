import { describe, expect, it } from "vitest";
import { isTerminalRunStatus, type RunStatus } from "@agework/shared";
import {
  decideRunStatusUpdate,
  RUNNING_MUTABLE_STATUSES,
  runStatusEffect,
} from "./run-status.policy";

const ALL_RUN_STATUSES: RunStatus[] = [
  "queued",
  "preparing",
  "running",
  "requires_action",
  "cancelling",
  "finished",
  "error",
  "cancelled",
];

describe("run lifecycle policy", () => {
  it("classifies terminal run statuses", () => {
    expect(isTerminalRunStatus("finished")).toBe(true);
    expect(isTerminalRunStatus("error")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("requires_action")).toBe(false);
  });

  it("effect 表的 terminal 标志与 shared 终态集合双向一致(漂移守卫)", () => {
    for (const status of ALL_RUN_STATUSES) {
      expect(
        runStatusEffect(status).terminal,
        `effect table vs shared TERMINAL_RUN_STATUSES: ${status}`
      ).toBe(isTerminalRunStatus(status));
    }
  });

  it("ignores every late status after a terminal status is recorded", () => {
    expect(
      decideRunStatusUpdate({
        nextStatus: "running",
        terminalOrFinalizing: true,
      })
    ).toEqual({
      action: "ignore",
      reason: "terminal_already_recorded",
    });
  });

  it("returns the side effects for key run statuses", () => {
    expect(runStatusEffect("running")).toMatchObject({
      persistenceAction: "markRunning",
      terminal: false,
      savePartialMessage: false,
    });
    expect(runStatusEffect("requires_action")).toMatchObject({
      persistenceAction: "markRequiresAction",
      terminal: false,
      savePartialMessage: true,
    });
    expect(runStatusEffect("finished")).toMatchObject({
      persistenceAction: "markFinished",
      terminal: true,
      terminalConversationStatus: "idle",
      terminalMessageComplete: true,
    });
    expect(runStatusEffect("error")).toMatchObject({
      persistenceAction: "markError",
      terminal: true,
      terminalConversationStatus: "error",
      terminalMessageComplete: false,
      terminalIncompleteReason: "error",
    });
  });

  it("returns an apply decision with the effect for active statuses", () => {
    expect(
      decideRunStatusUpdate({
        nextStatus: "requires_action",
        terminalOrFinalizing: false,
      })
    ).toEqual({
      action: "apply",
      effect: runStatusEffect("requires_action"),
    });
  });

  it("does not let running writes overwrite cancelling runs", () => {
    expect(RUNNING_MUTABLE_STATUSES).toEqual([
      "queued",
      "preparing",
      "running",
      "requires_action",
    ]);
    expect(RUNNING_MUTABLE_STATUSES).not.toContain("cancelling");
  });
});
