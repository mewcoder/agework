import { describe, it, expect } from "vitest";
import { resolveManagerConfig } from "./config.js";

describe("resolveManagerConfig", () => {
  it("reads flags and strips trailing slash from server url", () => {
    const config = resolveManagerConfig(
      ["--server", "http://host:3000/api/v1/", "--token", "t1", "--runtime", "docker"],
      {}
    );
    expect(config).toEqual({
      serverBaseUrl: "http://host:3000/api/v1",
      token: "t1",
      runtimeType: "docker",
    });
  });

  it("falls back to env and prefers flags over env", () => {
    const config = resolveManagerConfig(["--token", "flag-token"], {
      AGEWORK_SERVER_BASE_URL: "http://env:3000/api/v1",
      AGEWORK_RUNTIME_TOKEN: "env-token",
      AGEWORK_RUNTIME_TYPE: "local",
    });
    expect(config).toEqual({
      serverBaseUrl: "http://env:3000/api/v1",
      token: "flag-token",
      runtimeType: "local",
    });
  });

  it("rejects missing server url", () => {
    expect(() =>
      resolveManagerConfig(["--token", "t", "--runtime", "docker"], {})
    ).toThrow("missing server url");
  });

  it("rejects missing token", () => {
    expect(() =>
      resolveManagerConfig(
        ["--server", "http://h/api/v1", "--runtime", "docker"],
        {}
      )
    ).toThrow("missing pairing token");
  });

  it("rejects unknown runtime type", () => {
    expect(() =>
      resolveManagerConfig(
        ["--server", "http://h/api/v1", "--token", "t", "--runtime", "vm"],
        {}
      )
    ).toThrow("invalid runtime type");
  });

  it("rejects a flag without value", () => {
    expect(() =>
      resolveManagerConfig(["--server", "--token", "t"], {})
    ).toThrow("flag --server requires a value");
  });
});
