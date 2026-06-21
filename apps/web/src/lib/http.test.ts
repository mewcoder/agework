import { describe, it, expect } from "vitest";
import { normalizeHeaders } from "./http";

describe("normalizeHeaders", () => {
  it("returns empty object for undefined", () => {
    expect(normalizeHeaders(undefined)).toEqual({});
  });

  it("handles plain object headers", () => {
    expect(normalizeHeaders({ "Content-Type": "application/json", "X-Custom": "val" }))
      .toEqual({ "Content-Type": "application/json", "X-Custom": "val" });
  });

  it("handles Headers instance — header names 被 Headers API 规范化（小写）", () => {
    const h = new Headers();
    h.set("Content-Type", "application/json");
    h.set("Authorization", "Bearer abc123");
    // Headers.forEach 的 key 是小写（规范行为）
    expect(normalizeHeaders(h)).toEqual({
      "content-type": "application/json",
      "authorization": "Bearer abc123",
    });
  });

  it("handles array headers", () => {
    const h: [string, string][] = [
      ["Content-Type", "application/json"],
      ["X-Request-Id", "42"],
    ];
    expect(normalizeHeaders(h)).toEqual({
      "Content-Type": "application/json",
      "X-Request-Id": "42",
    });
  });

  it("关键场景：Headers 实例与 authHeaders 合并后 Authorization 存在", () => {
    const authHeaders = { Authorization: "Bearer token123" };
    const initHeaders = new Headers();
    initHeaders.set("Content-Type", "application/json");

    const merged: Record<string, string> = { ...authHeaders, ...normalizeHeaders(initHeaders) };
    // Authorization 来自 authHeaders（大写 key），content-type 来自 Headers（小写 key）
    expect(merged.Authorization).toBe("Bearer token123");
    expect(merged["content-type"]).toBe("application/json");
  });

  it("关键场景：数组 headers 与 authHeaders 合并后 Authorization 存在", () => {
    const authHeaders = { Authorization: "Bearer token123" };
    const initHeaders: [string, string][] = [["Content-Type", "text/plain"]];

    const merged = { ...authHeaders, ...normalizeHeaders(initHeaders) };
    expect(merged).toEqual({
      Authorization: "Bearer token123",
      "Content-Type": "text/plain",
    });
  });

  it("之前会丢 Authorization 的场景：Headers 实例用 as Record 断言", () => {
    // 旧代码: ...(init?.headers as Record<string, string> | undefined)
    // Headers 实例展开后只得到 {} 而非正常 headers
    const initHeaders = new Headers();
    initHeaders.set("Content-Type", "application/json");

    // 旧方式（展开 Headers 实例 = 空对象）
    const oldWay = { ...initHeaders } as unknown as Record<string, string>;
    expect(Object.keys(oldWay).length).toBe(0); // Headers 实例展开为空

    // 新方式（normalizeHeaders 正确提取）
    const newWay = normalizeHeaders(initHeaders);
    expect(Object.keys(newWay).length).toBeGreaterThan(0);
  });
});
