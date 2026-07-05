import { describe, it, expect } from "vitest";
import { resolveManagerConfig } from "./config.js";

const DEFAULT_LOG_DIR = "/home/agework/.agework/logs/runtime";

describe("resolveManagerConfig", () => {
  it("reads flags and strips trailing slash from server url (docker: worker-image required)", () => {
    const config = resolveManagerConfig(
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

  it("falls back to env and prefers flags over env (local: worker-entry/tsx-cli required)", () => {
    const config = resolveManagerConfig(["--token", "flag-token"], {
      AGEWORK_SERVER_BASE_URL: "http://env:3000/api/v1",
      AGEWORK_RUNTIME_TOKEN: "env-token",
      AGEWORK_RUNTIME_TYPE: "local",
      AGEWORK_RUNTIME_WORKER_ENTRY: "/app/dist/main.js",
      AGEWORK_RUNTIME_TSX_CLI: "/app/dist/main.js",
    });
    expect(config).toEqual({
      serverBaseUrl: "http://env:3000/api/v1",
      token: "flag-token",
      runtimeType: "local",
      runtimeLogHostPath: DEFAULT_LOG_DIR,
      workerEntryPath: "/app/dist/main.js",
      tsxCliPath: "/app/dist/main.js",
    });
  });

  it("reads a custom log dir", () => {
    const config = resolveManagerConfig(
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

  it("rejects docker/opensandbox without a worker image", () => {
    expect(() =>
      resolveManagerConfig(
        ["--server", "http://h/api/v1", "--token", "t", "--runtime", "docker"],
        {}
      )
    ).toThrow("missing worker image");
  });

  it("rejects local without worker-entry/tsx-cli", () => {
    expect(() =>
      resolveManagerConfig(
        ["--server", "http://h/api/v1", "--token", "t", "--runtime", "local"],
        {}
      )
    ).toThrow("missing local worker entry");
  });

  it("rejects a flag without value", () => {
    expect(() =>
      resolveManagerConfig(["--server", "--token", "t"], {})
    ).toThrow("flag --server requires a value");
  });
});
