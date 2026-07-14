import { describe, expect, it } from "vitest";
import { availableRuntimeTypes, normalizeRuntimeCapabilities } from "./index";

describe("runtime capabilities", () => {
  it("keeps a canonical multi-runtimeType matrix", () => {
    const capabilities = normalizeRuntimeCapabilities({
      native: { available: true, scopes: ["workspace"] },
      docker: { available: true, scopes: ["user", "workspace"] },
    });

    expect(availableRuntimeTypes(capabilities)).toEqual(["native", "docker"]);
  });

  it("rejects the removed single-runtime capability shape", () => {
    expect(normalizeRuntimeCapabilities({ scopes: ["workspace"] })).toEqual({});
  });
});
