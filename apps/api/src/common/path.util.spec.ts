import { describe, it, expect } from "vitest";
import { normalizePath, joinPaths, resolveApiBasePath } from "./path.util";

describe("normalizePath", () => {
  it("returns empty string for undefined/empty/root-only values", () => {
    expect(normalizePath(undefined)).toBe("");
    expect(normalizePath("")).toBe("");
    expect(normalizePath("/")).toBe("");
    expect(normalizePath("./")).toBe("");
  });

  it("normalizes a context path to a leading-slash form without trailing slash", () => {
    expect(normalizePath("agent")).toBe("/agent");
    expect(normalizePath("/agent")).toBe("/agent");
    expect(normalizePath("/agent/")).toBe("/agent");
  });
});

describe("joinPaths", () => {
  it("joins normalized segments and falls back to '/' when all empty", () => {
    expect(joinPaths("", "/api/v1")).toBe("/api/v1");
    expect(joinPaths("/agent", "/api/v1")).toBe("/agent/api/v1");
    expect(joinPaths("", "")).toBe("/");
  });
});

describe("resolveApiBasePath", () => {
  it("returns /api/v1 when no app context is set", () => {
    expect(resolveApiBasePath(undefined)).toBe("/api/v1");
  });

  it("prefixes the app context when set", () => {
    expect(resolveApiBasePath("/agent")).toBe("/agent/api/v1");
    expect(resolveApiBasePath("agent")).toBe("/agent/api/v1");
  });
});
