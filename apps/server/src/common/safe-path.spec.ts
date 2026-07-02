import { describe, it, expect } from "vitest";
import { safePathPart } from "./safe-path";

describe("safePathPart", () => {
  it("passes through clean alphanumeric strings", () => {
    expect(safePathPart("hello-world_123")).toBe("hello-world_123");
  });

  it("replaces special characters with hyphens", () => {
    expect(safePathPart("hello world!@#")).toBe("hello-world");
  });

  it("strips leading and trailing hyphens", () => {
    expect(safePathPart("--hello--")).toBe("hello");
  });

  it("returns 'unknown' for empty or all-special-char input", () => {
    expect(safePathPart("")).toBe("unknown");
    expect(safePathPart("!@#$%")).toBe("unknown");
  });

  it("truncates to 120 characters", () => {
    const long = "a".repeat(200);
    expect(safePathPart(long)).toHaveLength(120);
  });

  it("preserves dots", () => {
    expect(safePathPart("file.name.txt")).toBe("file.name.txt");
  });
});
