import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolFallback } from "./tool-fallback";

function renderTool(props: {
  argsText?: string;
  result?: unknown;
  status?: { type: string; error?: unknown };
}) {
  const Component = ToolFallback as unknown as (p: Record<string, unknown>) => React.ReactElement;
  return render(
    <Component
      type="tool-call"
      toolCallId="call-1"
      toolName="Bash"
      args={{}}
      {...props}
    />,
  );
}

describe("ToolFallback 展开门槛", () => {
  it("没有 argsText / result / error 时，trigger 被禁用且不渲染 chevron", () => {
    renderTool({ status: { type: "running" } });
    const trigger = screen.getByRole("button") as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.querySelectorAll("svg")).toHaveLength(1); // 只有状态图标，没有 chevron
  });

  it("有 argsText（即使仍是 running）时，trigger 可点击且渲染 chevron", () => {
    renderTool({ argsText: '{"command":"pwd"}', status: { type: "running" } });
    const trigger = screen.getByRole("button") as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    expect(trigger.querySelectorAll("svg")).toHaveLength(2); // 状态图标 + chevron
  });

  it("有 result 时，trigger 可点击且渲染 chevron", () => {
    renderTool({ result: "ok", status: { type: "complete" } });
    const trigger = screen.getByRole("button") as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    expect(trigger.querySelectorAll("svg")).toHaveLength(2);
  });

  it("incomplete 且有 error 时，trigger 可点击且渲染 chevron", () => {
    renderTool({ status: { type: "incomplete", error: "失败原因" } });
    const trigger = screen.getByRole("button") as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    expect(trigger.querySelectorAll("svg")).toHaveLength(2);
  });
});
