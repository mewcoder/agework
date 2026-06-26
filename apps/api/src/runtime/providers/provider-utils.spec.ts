import { describe, it, expect } from "vitest";
import { resolveDockerApiBase } from "./provider-utils";

describe("resolveDockerApiBase", () => {
  it("defaults to host.docker.internal with the api base path included", () => {
    expect(resolveDockerApiBase({})).toBe(
      "http://host.docker.internal:3000/api/v1"
    );
  });

  it("includes AGEWORK_CONTEXT in the path", () => {
    expect(resolveDockerApiBase({ AGEWORK_CONTEXT: "/agent" })).toBe(
      "http://host.docker.internal:3000/agent/api/v1"
    );
  });

  it("uses PORT when set", () => {
    expect(resolveDockerApiBase({ PORT: "4000" })).toBe(
      "http://host.docker.internal:4000/api/v1"
    );
  });
});
