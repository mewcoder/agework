import { describe, expect, it } from "vitest";
import { join } from "node:path";

describe("desktop preload path", () => {
  it("is emitted next to main.js", () => {
    expect(join("dist", "preload.js")).toBe("dist/preload.js");
  });
});
