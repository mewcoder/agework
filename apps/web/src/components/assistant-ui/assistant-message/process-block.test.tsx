import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  ProcessBlock,
  groupToolItems,
  visibleToolItems,
} from "./process-block";

describe("ProcessBlock", () => {
  it("keeps details open while a permission interrupt is waiting", () => {
    render(
      <ProcessBlock keepOpen>
        <span>permission details</span>
      </ProcessBlock>,
    );

    expect(screen.getByText("permission details")).toBeTruthy();
  });

  it("clusters only adjacent completed tools and keeps the active tool visible", () => {
    const groups = groupToolItems([
      { key: 1, status: { type: "complete" }, children: "done-1" },
      { key: 2, status: { type: "complete" }, children: "done-2" },
      { key: 3, status: { type: "running" }, children: "active" },
      { key: 4, status: { type: "complete" }, children: "done-3" },
    ]);

    expect(groups.map((group) => [group.kind, group.items.length])).toEqual([
      ["completed", 2],
      ["single", 1],
      ["completed", 1],
    ]);
    expect(groups[1]?.items[0]?.children).toBe("active");
  });

  it("keeps all tools visible until the tool sequence ends", () => {
    const items = [
      { key: 1, status: { type: "complete" }, children: "done-1" },
      { key: 2, status: { type: "running" }, children: "active" },
      { key: 3, status: { type: "complete" }, children: "done-2" },
    ];

    expect(visibleToolItems(items).map((item) => item.children)).toEqual([
      "done-1",
      "active",
      "done-2",
    ]);
    expect(visibleToolItems(items)).toEqual(items);
  });
});
