import { describe, it, expect } from "vitest";
import { generateUserId, generateWorkspaceId } from "./id-generator";

describe("generateUserId", () => {
  it("returns a non-empty string", async () => {
    const id = await generateUserId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("generates unique ids", async () => {
    const ids = await Promise.all(
      Array.from({ length: 10 }, () => generateUserId())
    );
    expect(new Set(ids).size).toBe(10);
  });
});

describe("generateWorkspaceId", () => {
  it("returns a non-empty string", async () => {
    const id = await generateWorkspaceId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("generates unique ids", async () => {
    const ids = await Promise.all(
      Array.from({ length: 10 }, () => generateWorkspaceId())
    );
    expect(new Set(ids).size).toBe(10);
  });
});
