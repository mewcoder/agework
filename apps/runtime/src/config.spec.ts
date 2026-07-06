import { describe, it, expect } from "vitest";
import { resolveRegisteredRuntimeConfig } from "./config.js";

const DEFAULT_LOG_DIR = "/home/agework/.agework/logs/runtime";

describe("resolveRegisteredRuntimeConfig", () => {
  it("reads flags and strips trailing slash from server url (docker: worker-image required)", () => {
    const config = resolveRegisteredRuntimeConfig(
      [
        "--server",
        "http://host:3000/api/v1/",
        "--token",
        "t1",
        "--runtime",
        "docker",
        "--worker-image",
        "agework/runtime:latest",
      ],
      {}
    );
    expect(config).toEqual({
      serverBaseUrl: "http://host:3000/api/v1",
      token: "t1",
      runtimeType: "docker",
      runtimeLogHostPath: DEFAULT_LOG_DIR,
      workerImage: "agework/runtime:latest",
    });
  });

  it("falls back to env and prefers flags over env (local: runtime-entry optional)", () => {
    const config = resolveRegisteredRuntimeConfig(
      ["--token", "flag-token", "--runtime-entry", "/path/flag.js"],
      {
        AGEWORK_SERVER_BASE_URL: "http://env:3000/api/v1",
        AGEWORK_RUNTIME_TOKEN: "env-token",
        AGEWORK_RUNTIME_TYPE: "local",
        AGEWORK_RUNTIME_ENTRY: "/path/env.js",
      }
    );
    expect(config).toEqual({
      serverBaseUrl: "http://env:3000/api/v1",
      token: "flag-token",
      runtimeType: "local",
      runtimeLogHostPath: DEFAULT_LOG_DIR,
      runtimeEntryPath: "/path/flag.js",
    });
  });

  it("local without runtime-entry defaults to self (allowed)", () => {
    const config = resolveRegisteredRuntimeConfig(
      ["--server", "http://h/api/v1", "--token", "t", "--runtime", "local"],
      {}
    );
    expect(config).toEqual({
      serverBaseUrl: "http://h/api/v1",
      token: "t",
      runtimeType: "local",
      runtimeLogHostPath: DEFAULT_LOG_DIR,
    });
  });

  it("reads a custom log dir", () => {
    const config = resolveRegisteredRuntimeConfig(
      [
        "--server",
        "http://h/api/v1",
        "--token",
        "t",
        "--runtime",
        "docker",
        "--worker-image",
        "img",
        "--log-dir",
        "/custom/logs",
      ],
      {}
    );
    expect(config.runtimeLogHostPath).toBe("/custom/logs");
  });

  it("rejects missing server url", () => {
    expect(() =>
      resolveRegisteredRuntimeConfig(["--token", "t", "--runtime", "docker"], {})
    ).toThrow("missing server url");
  });

  it("rejects missing token", () => {
    expect(() =>
      resolveRegisteredRuntimeConfig(
        ["--server", "http://h/api/v1", "--runtime", "docker"],
        {}
      )
    ).toThrow("missing pairing token");
  });

  it("rejects unknown runtime type", () => {
    expect(() =>
      resolveRegisteredRuntimeConfig(
        ["--server", "http://h/api/v1", "--token", "t", "--runtime", "vm"],
        {}
      )
    ).toThrow("invalid runtime type");
  });

  it("rejects docker/opensandbox without a worker image", () => {
    expect(() =>
      resolveRegisteredRuntimeConfig(
        ["--server", "http://h/api/v1", "--token", "t", "--runtime", "docker"],
        {}
      )
    ).toThrow("missing worker image");
  });

  it("accepts local with no --runtime-entry (defaults later to process.argv[1])", () => {
    const config = resolveRegisteredRuntimeConfig(
      ["--server", "http://h/api/v1", "--token", "t", "--runtime", "local"],
      {}
    );
    expect(config.runtimeType).toBe("local");
  });

  it("rejects a flag without value", () => {
    expect(() =>
      resolveRegisteredRuntimeConfig(["--server", "--token", "t"], {})
    ).toThrow("flag --server requires a value");
  });
});
