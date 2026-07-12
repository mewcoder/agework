import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveCodexBackend,
  createCodexAdapter,
} from "./factory";
import { CodexAgentAdapter } from "./business/codex-agent.adapter";
import { CodexAppServerAgentAdapter } from "./business/app-server-adapter";

describe("resolveCodexBackend", () => {
  it("defaults to app-server when env var is not set", () => {
    expect(resolveCodexBackend({})).toBe("app-server");
  });

  it("returns sdk when AGEWORK_CODEX_BACKEND=sdk", () => {
    expect(resolveCodexBackend({ AGEWORK_CODEX_BACKEND: "sdk" })).toBe("sdk");
  });

  it("returns app-server when AGEWORK_CODEX_BACKEND=app-server", () => {
    expect(
      resolveCodexBackend({ AGEWORK_CODEX_BACKEND: "app-server" }),
    ).toBe("app-server");
  });

  it("is case-insensitive", () => {
    expect(resolveCodexBackend({ AGEWORK_CODEX_BACKEND: "SDK" })).toBe("sdk");
    expect(
      resolveCodexBackend({ AGEWORK_CODEX_BACKEND: "APP-SERVER" }),
    ).toBe("app-server");
  });

  it("trims whitespace", () => {
    expect(
      resolveCodexBackend({ AGEWORK_CODEX_BACKEND: "  sdk  " }),
    ).toBe("sdk");
  });

  it("falls back to app-server for unknown values", () => {
    expect(
      resolveCodexBackend({ AGEWORK_CODEX_BACKEND: "something-else" }),
    ).toBe("app-server");
  });

  it("treats empty string as unset", () => {
    expect(resolveCodexBackend({ AGEWORK_CODEX_BACKEND: "" })).toBe(
      "app-server",
    );
  });
});

describe("createCodexAdapter", () => {
  it("creates CodexAppServerAgentAdapter by default", () => {
    const adapter = createCodexAdapter({ codexPath: "/usr/bin/codex" });
    expect(adapter).toBeInstanceOf(CodexAppServerAgentAdapter);
  });

  it("creates CodexAppServerAgentAdapter when backend=app-server", () => {
    const adapter = createCodexAdapter(
      { codexPath: "/usr/bin/codex" },
      "app-server",
    );
    expect(adapter).toBeInstanceOf(CodexAppServerAgentAdapter);
  });

  it("creates CodexAgentAdapter (SDK) when backend=sdk", () => {
    const adapter = createCodexAdapter(
      { codexPath: "/usr/bin/codex" },
      "sdk",
    );
    expect(adapter).toBeInstanceOf(CodexAgentAdapter);
  });

  it("passes codexPath as codexPathOverride to SDK adapter", () => {
    const sdkAdapter = createCodexAdapter(
      { codexPath: "/custom/codex" },
      "sdk",
    ) as CodexAgentAdapter;
    // The SDK adapter passes codexPathOverride to the base class config.
    // We verify it was accepted without throwing.
    expect(sdkAdapter).toBeInstanceOf(CodexAgentAdapter);
  });

  it("respects AGEWORK_CODEX_BACKEND env var when backend param is omitted", () => {
    vi.stubEnv("AGEWORK_CODEX_BACKEND", "sdk");
    const adapter = createCodexAdapter({ codexPath: "/usr/bin/codex" });
    expect(adapter).toBeInstanceOf(CodexAgentAdapter);
    vi.unstubAllEnvs();
  });

  it("passes through all config fields to app-server adapter", () => {
    const adapter = createCodexAdapter(
      {
        apiKey: "test-key",
        baseUrl: "https://api.example.com/v1",
        model: "o4-mini",
        cwd: "/workspace",
        modelReasoningEffort: "high",
        codexPath: "/usr/bin/codex",
        extraConfig: { foo: "bar" },
      },
      "app-server",
    ) as CodexAppServerAgentAdapter;

    const internals = adapter as unknown as {
      config: Record<string, unknown>;
    };
    expect(internals.config.apiKey).toBe("test-key");
    expect(internals.config.model).toBe("o4-mini");
    expect(internals.config.cwd).toBe("/workspace");
    expect(internals.config.codexPath).toBe("/usr/bin/codex");
    expect(internals.config.extraConfig).toEqual({ foo: "bar" });
  });
});
