import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getAgentOptionsByType,
  getAgentOptions,
  isRootRuntime,
} from "./agent-options";

describe("isRootRuntime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when process.getuid is 0", () => {
    vi.spyOn(process, "getuid").mockReturnValue(0);
    expect(isRootRuntime()).toBe(true);
  });

  it("returns false when process.getuid is non-zero", () => {
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    expect(isRootRuntime()).toBe(false);
  });

  it("returns false when process.getuid is unavailable", () => {
    vi.spyOn(process, "getuid").mockReturnValue(undefined as unknown as number);
    expect(isRootRuntime()).toBe(false);
  });
});

describe("getAgentOptionsByType", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns options for claude and codex", () => {
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    const options = getAgentOptionsByType();
    expect(options).toHaveProperty("claude");
    expect(options).toHaveProperty("codex");
  });

  it("claude has permissionMode with options", () => {
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    const options = getAgentOptionsByType();
    expect(options.claude.permissionMode.options.length).toBeGreaterThan(0);
    expect(options.claude.permissionMode.defaultValue).toBe("acceptEdits");
  });

  it("codex has permissionMode with options", () => {
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    const options = getAgentOptionsByType();
    expect(options.codex.permissionMode.options.length).toBeGreaterThan(0);
    expect(options.codex.permissionMode.defaultValue).toBe("auto-review");
  });

  it("each option has value, label, description", () => {
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    const options = getAgentOptionsByType();
    for (const agent of [options.claude, options.codex]) {
      for (const opt of agent.permissionMode.options) {
        expect(opt.value).toBeTruthy();
        expect(opt.label).toBeTruthy();
        expect(opt.description).toBeTruthy();
      }
    }
  });

  it("includes bypassPermissions when not running as root", () => {
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    const options = getAgentOptionsByType();
    expect(
      options.claude.permissionMode.options.some(
        (o) => o.value === "bypassPermissions"
      )
    ).toBe(true);
  });

  it("excludes bypassPermissions when running as root", () => {
    vi.spyOn(process, "getuid").mockReturnValue(0);
    const options = getAgentOptionsByType();
    expect(
      options.claude.permissionMode.options.some(
        (o) => o.value === "bypassPermissions"
      )
    ).toBe(false);
  });
});

describe("getAgentOptions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns agents array with all agent types", () => {
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    const result = getAgentOptions();
    expect(result.list.length).toBeGreaterThan(0);
    for (const agent of result.list) {
      expect(agent.id).toBeTruthy();
      expect(agent.label).toBeTruthy();
      expect(agent.options).toBeDefined();
    }
  });
});
