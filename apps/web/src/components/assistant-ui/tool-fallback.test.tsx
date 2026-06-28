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
    // base-ui 用 focusable-when-disabled：禁用时不设原生 disabled，而是 aria-disabled
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    // 状态点（span，非 svg）；locked 时不渲染 chevron → 无 svg
    expect(trigger.querySelectorAll("svg")).toHaveLength(0);
    expect(trigger.querySelector("[data-slot='status-dot']")).not.toBeNull();
  });

  it("有 argsText（即使仍是 running）时，trigger 可点击且渲染 chevron", () => {
    renderTool({ argsText: '{"command":"pwd"}', status: { type: "running" } });
    const trigger = screen.getByRole("button") as HTMLButtonElement;
    expect(trigger.getAttribute("aria-disabled")).not.toBe("true");
    // 状态点（span）+ chevron（svg）→ 1 个 svg
    expect(trigger.querySelectorAll("svg")).toHaveLength(1);
  });

  it("有 result 时，trigger 可点击且渲染 chevron，完成态显绿色点", () => {
    renderTool({ result: "ok", status: { type: "complete" } });
    const trigger = screen.getByRole("button") as HTMLButtonElement;
    expect(trigger.getAttribute("aria-disabled")).not.toBe("true");
    // 完成态显示绿色状态点 + chevron（svg）→ 1 个 svg
    expect(trigger.querySelectorAll("svg")).toHaveLength(1);
    const dot = trigger.querySelector("[data-slot='status-dot']");
    expect(dot).not.toBeNull();
    expect(dot?.className).toContain("bg-emerald");
  });

  it("incomplete 且有 error 时，trigger 可点击且渲染 chevron", () => {
    renderTool({ status: { type: "incomplete", error: "失败原因" } });
    const trigger = screen.getByRole("button") as HTMLButtonElement;
    expect(trigger.getAttribute("aria-disabled")).not.toBe("true");
    expect(trigger.querySelectorAll("svg")).toHaveLength(1);
    expect(trigger.querySelector("[data-slot='status-dot']")).not.toBeNull();
  });
});

describe("ToolFallback 收起态摘要", () => {
  const Component = ToolFallback as unknown as (p: Record<string, unknown>) => React.ReactElement;

  it("Bash 带 description 时 trigger 文本含 description", () => {
    render(
      <Component
        type="tool-call"
        toolCallId="call-1"
        toolName="Bash"
        args={{ command: "pwd", description: "打印当前目录" }}
        argsText='{"command":"pwd","description":"打印当前目录"}'
        status={{ type: "complete" }}
      />,
    );
    const text = screen.getByRole("button").textContent ?? "";
    expect(text).toContain("Bash");
    expect(text).toContain("打印当前目录");
  });

  it("Read 显示 file_path 文件名", () => {
    render(
      <Component
        type="tool-call"
        toolCallId="call-1"
        toolName="Read"
        args={{ file_path: "src/index.ts" }}
        argsText='{"file_path":"src/index.ts"}'
        status={{ type: "complete" }}
      />,
    );
    const text = screen.getByRole("button").textContent ?? "";
    expect(text).toContain("Read");
    expect(text).toContain("index.ts");
  });

  it("Bash 无 description 时回退显示 command", () => {
    render(
      <Component
        type="tool-call"
        toolCallId="call-1"
        toolName="Bash"
        args={{ command: "pwd" }}
        argsText='{"command":"pwd"}'
        status={{ type: "complete" }}
      />,
    );
    const text = screen.getByRole("button").textContent ?? "";
    expect(text).toContain("Bash");
    expect(text).toContain("pwd");
  });
});
